package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

var (
	flagDataDir = flag.String("data", "../docs/data", "path to data directory containing qcf/ and qcu/ subdirectories")
	flagCache   = flag.String("cache", "memory", "cache strategy: none, mmap, memory")
	flagProd    = flag.Bool("prod", false, "production mode: TLS via ACME on :443/:80")
	flagCertDir = flag.String("cert-dir", "/var/cache/autocert", "autocert certificate cache directory")
	flagDomain  = flag.String("domain", "api.klymot.com", "domain name for ACME TLS certificate")
	flagPort    = flag.Int("port", 8081, "HTTP port for local (non-production) mode")
	flagIndex   = flag.String("index", "", "path to index.json for geo-gridded weights (defaults to <data>/index.json)")
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
		log.Fatalf("initializing data store (%s): %v", *flagCache, err)
	}
	log.Printf("data store ready (cache=%s)", *flagCache)

	mux := http.NewServeMux()
	mux.Handle("/api/v1/aggregate", corsMiddleware(*flagProd)(
		http.HandlerFunc(newAggregateHandler(store, meta)),
	))
	mux.Handle("/api/v1/status", corsMiddleware(*flagProd)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
		}),
	))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *flagProd {
		runProd(ctx, mux)
	} else {
		runLocal(ctx, mux)
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

	// :80 handles ACME HTTP-01 challenges and redirects everything else to HTTPS.
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

var prodOrigins = map[string]bool{
	"https://www.klymot.com": true,
	"https://klymot.com":     true,
}

// corsMiddleware sets CORS headers for requests from known origins.
// In non-production mode, localhost origins are also permitted.
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
					w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
