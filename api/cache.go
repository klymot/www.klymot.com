package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// ── Station-set fingerprint (for precomputed cache matching) ──────────────────

// stationSetFingerprint returns an FNV-1a hash of the station IDs sorted
// lexicographically, so request order does not affect the key.
func stationSetFingerprint(ids []string) uint64 {
	sorted := make([]string, len(ids))
	copy(sorted, ids)
	sort.Strings(sorted)

	// Use a simple FNV-1a accumulator.
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	h := uint64(offset64)
	for _, id := range sorted {
		for i := 0; i < len(id); i++ {
			h ^= uint64(id[i])
			h *= prime64
		}
		h ^= 0 // null separator
		h *= prime64
	}
	return h
}

// ── Pre-computed all-station cache ────────────────────────────────────────────

type precomputedKey struct {
	series        string
	anomaly       bool
	geoGridded    bool
	fullYearsOnly bool
}

type precomputedEntry struct {
	once sync.Once
	fn   func() []byte
	data []byte
}

func (e *precomputedEntry) compute() []byte {
	e.once.Do(func() { e.data = e.fn() })
	return e.data
}

// precomputedCache holds 16 always-available all-station aggregations
// (2 series × 2 anomaly modes × 2 geo_gridded × 2 full_years_only).
// Only the "" (no anomaly) and "station" anomaly modes are pre-computed.
type precomputedCache struct {
	allCount int
	allHash  uint64
	entries  map[precomputedKey]*precomputedEntry
}

func newPrecomputedCache(allIDs []string, store DataStore, meta map[string]StationMeta) *precomputedCache {
	entries := make(map[precomputedKey]*precomputedEntry, 16)
	for _, series := range []string{"qcf", "qcu"} {
		for _, anomaly := range []bool{false, true} {
			for _, geo := range []bool{false, true} {
				for _, fullYears := range []bool{false, true} {
					series, anomaly, geo, fullYears := series, anomaly, geo, fullYears
					key := precomputedKey{series, anomaly, geo, fullYears}
					req := aggregateRequest{
						StationIDs:    allIDs,
						Series:        series,
						Anomaly:       anomaly,
						GeoGridded:    geo,
						FullYearsOnly: fullYears,
					}
					e := &precomputedEntry{}
					e.fn = func() []byte {
						resp, err := computeAggregate(store, meta, req)
						if err != nil {
							log.Printf("pre-compute %+v: %v", key, err)
							return nil
						}
						data, err := json.Marshal(resp)
						if err != nil {
							log.Printf("pre-compute marshal %+v: %v", key, err)
							return nil
						}
						log.Printf("pre-computed: series=%s anomaly=%v geo_gridded=%v full_years=%v (%dB)",
							key.series, key.anomaly, key.geoGridded, key.fullYearsOnly, len(data))
						return data
					}
					entries[key] = e
				}
			}
		}
	}
	return &precomputedCache{
		allCount: len(allIDs),
		allHash:  stationSetFingerprint(allIDs),
		entries:  entries,
	}
}

// startPrecomputation launches a background goroutine that computes all entries
// serially to avoid RAM spikes on memory-constrained servers.
func (c *precomputedCache) startPrecomputation() {
	go func() {
		for _, e := range c.entries {
			e.compute()
		}
	}()
}

// get returns the cached JSON bytes for req if it targets the full station set
// and uses a pre-computed anomaly mode ("" or "station"), blocking until ready.
func (c *precomputedCache) get(req aggregateRequest) ([]byte, bool) {
	mode := req.effectiveAnomalyMode()
	if mode != "" && mode != "station" {
		return nil, false // other modes are not pre-computed
	}
	if len(req.StationIDs) != c.allCount {
		return nil, false
	}
	if stationSetFingerprint(req.StationIDs) != c.allHash {
		return nil, false
	}
	key := precomputedKey{
		series:        req.Series,
		anomaly:       mode == "station",
		geoGridded:    req.GeoGridded,
		fullYearsOnly: req.FullYearsOnly,
	}
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	data := e.compute()
	if data == nil {
		return nil, false
	}
	return data, true
}

// ── Disk response cache ───────────────────────────────────────────────────────

// diskCache stores serialised HTTP responses on disk, keyed by a SHA-256
// digest of the request URL path and normalised JSON body.
//
// The cache directory is purged on creation (call newDiskCache at startup).
// Writes are atomic: content is written to a ".tmp" file then renamed, so
// concurrent writers of the same key are safe (last rename wins; both produce
// identical content for deterministic endpoints).
type diskCache struct {
	dir string
}

// newDiskCache purges dir and re-creates it, then returns a ready cache.
// Returns nil, nil when dir is empty (disk cache disabled).
func newDiskCache(dir string) (*diskCache, error) {
	if dir == "" {
		return nil, nil
	}
	if err := os.RemoveAll(dir); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("purge disk cache %s: %w", dir, err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create disk cache dir %s: %w", dir, err)
	}
	log.Printf("disk cache: initialised at %s (purged)", dir)
	return &diskCache{dir: dir}, nil
}

func (c *diskCache) path(key [32]byte) string {
	return filepath.Join(c.dir, hex.EncodeToString(key[:]))
}

func (c *diskCache) get(key [32]byte) ([]byte, bool) {
	data, err := os.ReadFile(c.path(key))
	if err != nil {
		return nil, false
	}
	return data, true
}

func (c *diskCache) put(key [32]byte, data []byte) {
	p := c.path(key)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("disk cache: write %s: %v", p, err)
		return
	}
	if err := os.Rename(tmp, p); err != nil {
		log.Printf("disk cache: rename %s: %v", p, err)
		os.Remove(tmp) //nolint:errcheck
	}
}

// ── Disk cache key derivation ─────────────────────────────────────────────────

// Compile-time endpoint discriminators keep different API endpoints from
// colliding in the cache while ensuring no user-controlled data ever enters
// the key derivation (r.URL.Path is not used).
const (
	cacheEndpointAggregate         byte = 0x01
	cacheEndpointReferenceCoverage byte = 0x02
)

// diskCacheKey returns SHA-256(endpoint || normalised_body).
// Using a compile-time endpoint byte instead of the URL path means no
// user-controlled data flows into the filesystem path derived from this key.
// normalisedBody has JSON object keys in Go's default map sort order and all
// purely-string JSON arrays sorted, so semantically identical requests
// (e.g. with station_ids in different orders) hash identically.
func diskCacheKey(endpoint byte, body []byte) [32]byte {
	norm, err := normaliseJSONBody(body)
	if err != nil {
		// Fall back to raw body on parse failure.
		norm = body
	}
	h := sha256.New()
	h.Write([]byte{endpoint})
	h.Write(norm)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// normaliseJSONBody parses body as JSON and re-encodes it with:
//   - object keys in Go map sort order (alphabetical)
//   - purely-string arrays sorted lexicographically
func normaliseJSONBody(body []byte) ([]byte, error) {
	var v interface{}
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, err
	}
	return json.Marshal(sortJSONValue(v))
}

func sortJSONValue(v interface{}) interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(t))
		for k, val := range t {
			out[k] = sortJSONValue(val)
		}
		return out
	case []interface{}:
		if len(t) == 0 {
			return t
		}
		// Sort purely-string arrays (e.g. station_ids).
		allStr := true
		for _, x := range t {
			if _, ok := x.(string); !ok {
				allStr = false
				break
			}
		}
		if allStr {
			strs := make([]string, len(t))
			for i, x := range t {
				strs[i] = x.(string)
			}
			sort.Strings(strs)
			out := make([]interface{}, len(strs))
			for i, s := range strs {
				out[i] = s
			}
			return out
		}
		out := make([]interface{}, len(t))
		for i, x := range t {
			out[i] = sortJSONValue(x)
		}
		return out
	}
	return v
}

// ── POST caching middleware ───────────────────────────────────────────────────

// newPostCacheMiddleware returns an HTTP middleware that:
//  1. Reads and re-injects the POST body so the inner handler still sees it.
//  2. Checks the disk cache by key = SHA-256(endpoint || normalised body).
//  3. On hit: writes the cached JSON directly (gzip is applied by an outer layer).
//  4. On miss: wraps the ResponseWriter to capture the response, calls the inner
//     handler, then stores 200 OK JSON responses to the disk cache.
//
// endpoint is a compile-time constant (cacheEndpoint*) that distinguishes
// different API routes without using the user-supplied URL path.
// Passing a nil cache disables caching (requests pass straight through).
func newPostCacheMiddleware(dc *diskCache, endpoint byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || dc == nil {
				next.ServeHTTP(w, r)
				return
			}

			// Buffer body (limit matches the aggregate handler's own limit).
			body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
			r.Body.Close()
			if err != nil {
				http.Error(w, "failed to read request body", http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))

			key := diskCacheKey(endpoint, body)

			if cached, ok := dc.get(key); ok {
				w.Header().Set("Content-Type", "application/json")
				w.Write(cached) //nolint:errcheck
				return
			}

			// Capture the response so we can store it after the handler runs.
			cap := &captureWriter{ResponseWriter: w}
			next.ServeHTTP(cap, r)

			if (cap.status == 0 || cap.status == http.StatusOK) && len(cap.body) > 0 {
				dc.put(key, cap.body)
			}
		})
	}
}

// captureWriter tees every Write to its internal buffer while also passing
// through to the wrapped ResponseWriter.
type captureWriter struct {
	http.ResponseWriter
	status int
	body   []byte
}

func (cw *captureWriter) WriteHeader(code int) {
	cw.status = code
	cw.ResponseWriter.WriteHeader(code)
}

func (cw *captureWriter) Write(b []byte) (int, error) {
	cw.body = append(cw.body, b...)
	return cw.ResponseWriter.Write(b)
}
