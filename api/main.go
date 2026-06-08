package main

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

var (
	flagDataDir      = flag.String("data", "../docs/data", "path to data directory containing qcf/ and qcu/ subdirectories")
	flagCache        = flag.String("cache", "memory", "cache strategy: none, mmap, memory")
	flagProd         = flag.Bool("prod", false, "production mode: TLS via ACME on :443/:80")
	flagCertDir      = flag.String("cert-dir", "/var/cache/autocert", "autocert certificate cache directory")
	flagDomain       = flag.String("domain", "api.klymot.com", "domain name for ACME TLS certificate")
	flagPort         = flag.Int("port", 8081, "HTTP port for local (non-production) mode")
	flagIndex        = flag.String("index", "", "path to index.json for geo-gridded weights (defaults to <data>/index.json)")
	flagDiskCache    = flag.String("disk-cache", "", "directory for disk response cache (empty = disabled)")
	flagConcurrency  = flag.Int("concurrency", 0, "max concurrent aggregate computations (0 = number of CPU cores)")
	flagUsageData    = flag.String("usage-data", "", "path to usage stats JSON file (empty = in-memory only)")
	flagUsagePwFile  = flag.String("usage-password-file", "", "file containing the stats endpoint password (empty = stats disabled)")
	flagGeoIPDB      = flag.String("geoip-db", "", "path to GeoLite2-Country.mmdb for IP geolocation (optional)")
)

func main() {
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("api: ")

	indexPath := *flagIndex
	if indexPath == "" {
		indexPath = *flagDataDir + "/index.json"
	}

	meta, err := loadStationMeta(indexPath)
	if err != nil {
		log.Fatalf("loading station metadata: %v", err)
	}
	log.Printf("loaded metadata for %d stations", len(meta))

	store, err := newDataStore(*flagCache, *flagDataDir)
	if err != nil {
		log.Fatalf("initialising data store (%s): %v", *flagCache, err)
	}
	log.Printf("data store ready (cache=%s)", *flagCache)

	// Build sorted list of all station IDs.
	allIDs := make([]string, 0, len(meta))
	for id := range meta {
		allIDs = append(allIDs, id)
	}
	sort.Strings(allIDs)

	// Disk cache: purged on startup so stale results never survive a data update
	// (the service is restarted whenever data changes).
	dc, err := newDiskCache(*flagDiskCache)
	if err != nil {
		log.Fatalf("initialising disk cache: %v", err)
	}
	if dc != nil {
		log.Printf("disk cache: ready at %s", *flagDiskCache)
	} else {
		log.Printf("disk cache: disabled")
	}

	// Pre-compute all-station aggregations (16 combos) in the background.
	// These are kept in memory for fast cold responses on the all-station view.
	pc := newPrecomputedCache(allIDs, store, meta)
	pc.startPrecomputation()
	log.Printf("pre-computing 16 all-station graphs in background (%d stations)", len(allIDs))

	queue := newCalcQueue(*flagConcurrency, 45.0)
	log.Printf("computation queue: max %d concurrent, 45s reject threshold", queue.concurrency())

	usageStats := newUsageTracker(*flagUsageData, *flagGeoIPDB)

	var statsPassword string
	if *flagUsagePwFile != "" {
		raw, err := os.ReadFile(*flagUsagePwFile)
		if err != nil {
			log.Fatalf("reading usage password file: %v", err)
		}
		statsPassword = strings.TrimSpace(string(raw))
		if statsPassword == "" {
			log.Fatalf("usage password file %s is empty", *flagUsagePwFile)
		}
		log.Printf("usage stats endpoint enabled")
	}

	// Seed the disk cache with the reference-coverage for all stations.
	// This runs concurrently with precomputation so startup is not delayed.
	if dc != nil {
		go func() {
			log.Printf("seed: computing reference coverage for all stations...")
			seedReferenceCoverage(dc, store, allIDs)
			log.Printf("seed: complete")
		}()
	}

	mux := http.NewServeMux()
	mux.Handle("/api/v1/aggregate",
		corsMiddleware(*flagProd)(
			newPostCacheMiddleware(dc, cacheEndpointAggregate)(
				http.HandlerFunc(newAggregateHandler(store, meta, pc, queue)),
			),
		),
	)
	mux.Handle("/api/v1/reference-coverage",
		corsMiddleware(*flagProd)(
			newPostCacheMiddleware(dc, cacheEndpointReferenceCoverage)(
				http.HandlerFunc(newReferenceCoverageHandler(store, queue)),
			),
		),
	)
	mux.Handle("/api/v1/status",
		corsMiddleware(*flagProd)(
			http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
			}),
		),
	)
	mux.Handle("/api/v1/usage",
		corsMiddleware(*flagProd)(
			http.HandlerFunc(usageStats.beaconHandler),
		),
	)
	if statsPassword != "" {
		mux.Handle("/api/v1/usage/stats",
			corsMiddleware(*flagProd)(
				http.HandlerFunc(usageStats.statsHandler(statsPassword)),
			),
		)
	}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	usageStats.startFlusher(ctx)

	logged := loggingMiddleware(gzipMiddleware(mux))
	if *flagProd {
		runProd(ctx, logged)
	} else {
		runLocal(ctx, logged)
	}
}

func runLocal(ctx context.Context, handler http.Handler) {
	addr := fmt.Sprintf(":%d", *flagPort)
	srv := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	go func() {
		log.Printf("listening on http://localhost%s", addr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()
	<-ctx.Done()
	gracefulShutdown(srv)
}

func runProd(ctx context.Context, handler http.Handler) {
	m := &autocert.Manager{
		Cache:      autocert.DirCache(*flagCertDir),
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(*flagDomain),
	}

	httpSrv := &http.Server{
		Addr:         ":80",
		Handler:      m.HTTPHandler(http.HandlerFunc(redirectHTTPS)),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	tlsCfg := m.TLSConfig()
	tlsCfg.MinVersion = tls.VersionTLS12

	httpsSrv := &http.Server{
		Addr:         ":443",
		Handler:      handler,
		TLSConfig:    tlsCfg,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Printf("listening on :80 (ACME challenges + HTTPS redirect)")
		if err := httpSrv.ListenAndServe(); err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()
	go func() {
		log.Printf("listening on :443 (TLS, domain=%s)", *flagDomain)
		if err := httpsSrv.ListenAndServeTLS("", ""); err != http.ErrServerClosed {
			log.Fatalf("HTTPS server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	gracefulShutdown(httpSrv)
	gracefulShutdown(httpsSrv)
}

func gracefulShutdown(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error (%s): %v", srv.Addr, err)
	}
}

func redirectHTTPS(w http.ResponseWriter, r *http.Request) {
	target := "https://" + r.Host + r.URL.RequestURI()
	http.Redirect(w, r, target, http.StatusMovedPermanently)
}

var gzipPool = sync.Pool{
	New: func() any { w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed); return w },
}

// gzipMiddleware compresses responses for clients that send Accept-Encoding: gzip.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gz := gzipPool.Get().(*gzip.Writer)
		gz.Reset(w)
		defer func() {
			gz.Close()
			gzipPool.Put(gz)
		}()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Del("Content-Length")
		next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, gz: gz}, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }

// loggingMiddleware logs one line per request.
func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %dB %s %s",
			r.Method, r.URL.RequestURI(),
			rec.status, rec.bytes,
			time.Since(start).Round(time.Millisecond),
			r.RemoteAddr,
		)
	})
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *responseRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

var prodOrigins = map[string]bool{
	"https://www.klymot.com": true,
	"https://klymot.com":     true,
}

// corsMiddleware sets CORS headers for requests from known origins.
func corsMiddleware(prod bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				allowed := prodOrigins[origin]
				if !allowed && !prod {
					allowed = strings.HasPrefix(origin, "http://localhost") ||
						strings.HasPrefix(origin, "http://127.0.0.1")
				}
				if allowed {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
					w.Header().Set("Access-Control-Max-Age", "86400")
					w.Header().Set("Vary", "Origin")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
