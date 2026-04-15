package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// ── Request / Response types ──────────────────────────────────────────────────

type referenceCoverageRequest struct {
	StationIDs []string `json:"station_ids"`
	Series     string   `json:"series"` // "qcf" or "qcu"
}

// referenceCoverageResponse reports how many stations in the requested set have
// sufficient data to serve as an anomaly reference for each candidate year or
// decade.
//
//   - Years   – maps year → number of stations with a complete year (all 12 months
//     non-missing). JSON keys are the year as a decimal string.
//   - Decades – maps decade start year → number of stations that pass
//     stationHasDecade (≥ 9 of 10 data points per calendar month).
//     Keys are always multiples of 10.
type referenceCoverageResponse struct {
	Years   map[int]int `json:"years"`
	Decades map[int]int `json:"decades"`
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

func newReferenceCoverageHandler(store DataStore, q *calcQueue) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 8<<20)

		var req referenceCoverageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
			return
		}

		if len(req.StationIDs) == 0 {
			http.Error(w, "station_ids must not be empty", http.StatusBadRequest)
			return
		}
		if len(req.StationIDs) > 50_000 {
			http.Error(w, "station_ids exceeds maximum of 50000", http.StatusBadRequest)
			return
		}
		if req.Series != "qcf" && req.Series != "qcu" {
			http.Error(w, `series must be "qcf" or "qcu"`, http.StatusBadRequest)
			return
		}
		for _, id := range req.StationIDs {
			if !validStationID(id) {
				http.Error(w, fmt.Sprintf("invalid station_id %q", id), http.StatusBadRequest)
				return
			}
		}

		var resp *referenceCoverageResponse
		var computeErr error
		ran, elapsed, retryAfter := q.run(func() {
			resp, computeErr = computeReferenceCoverage(store, req)
		})
		if !ran {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", retryAfter))
			http.Error(w, "server busy, try again later", http.StatusServiceUnavailable)
			return
		}
		log.Printf("reference-coverage: series=%s stations=%d duration=%s",
			req.Series, len(req.StationIDs), elapsed.Round(time.Millisecond))
		if computeErr != nil {
			log.Printf("reference-coverage error: %v", computeErr)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		data, err := json.Marshal(resp)
		if err != nil {
			log.Printf("reference-coverage: marshal error: %v", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(data) //nolint:errcheck
	}
}

// ── Computation ───────────────────────────────────────────────────────────────

// computeReferenceCoverage counts, for each candidate year and decade, how many
// stations in req have sufficient data to use that period as an anomaly baseline.
//
//   - Year N is counted for a station if it has all 12 months non-missing.
//   - Decade D is counted for a station if stationHasDecade(rows, D) is true
//     (≥ 9 of 10 data points for each calendar month across [D, D+10)).
func computeReferenceCoverage(store DataStore, req referenceCoverageRequest) (*referenceCoverageResponse, error) {
	yearCounts := make(map[int]int)
	decadeCounts := make(map[int]int)

	for _, id := range req.StationIDs {
		rows, err := store.Load(req.Series, id)
		if err != nil {
			log.Printf("reference-coverage: skipping %s: %v", id, err)
			continue
		}
		if len(rows) == 0 {
			continue
		}

		// Check every year the station has data for.
		checkedDecades := map[int]bool{}
		for year := range rows {
			if stationHasYear(rows, year) {
				yearCounts[year]++
			}
			d := (year / 10) * 10
			if !checkedDecades[d] {
				checkedDecades[d] = true
				if stationHasDecade(rows, d) {
					decadeCounts[d]++
				}
			}
		}
	}

	return &referenceCoverageResponse{
		Years:   yearCounts,
		Decades: decadeCounts,
	}, nil
}

// seedReferenceCoverage pre-computes and stores the reference-coverage response
// for all stations into the disk cache. Called once at startup.
func seedReferenceCoverage(dc *diskCache, store DataStore, allIDs []string) {
	if dc == nil {
		return
	}
	for _, series := range []string{"qcf", "qcu"} {
		req := referenceCoverageRequest{StationIDs: allIDs, Series: series}

		// Build the body that the middleware would hash.
		body, err := json.Marshal(req)
		if err != nil {
			log.Printf("seed: marshal ref-coverage %s: %v", series, err)
			continue
		}
		key := diskCacheKey("/api/v1/reference-coverage", body)
		if _, ok := dc.get(key); ok {
			log.Printf("seed: ref-coverage %s already cached", series)
			continue
		}

		resp, err := computeReferenceCoverage(store, req)
		if err != nil {
			log.Printf("seed: ref-coverage %s compute error: %v", series, err)
			continue
		}
		data, err := json.Marshal(resp)
		if err != nil {
			log.Printf("seed: ref-coverage %s marshal error: %v", series, err)
			continue
		}
		dc.put(key, data)
		log.Printf("seed: ref-coverage %s cached (%dB)", series, len(data))
	}
}
