package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"unicode"
)

// ── Request / Response types ──────────────────────────────────────────────────

type aggregateRequest struct {
	StationIDs    []string `json:"station_ids"`
	GeoGridded    bool     `json:"geo_gridded"`
	Series        string   `json:"series"`         // "qcf" or "qcu"
	Anomaly       bool     `json:"anomaly"`        // if true, return anomalies relative to each station's baseline
	FullYearsOnly bool     `json:"full_years_only"` // if true, a station only contributes to a year when all 12 months are present
}

// aggregateResponse describes a contiguous monthly time series starting at Start.
// Each array element corresponds to one calendar month; the i-th element covers
// the month Start + i months.
//
//   - Counts   – number of stations with a non-missing observation for that month
//   - Averages – mean temperature in °C for that month (0 when Counts[i]==0)
//   - StdDevs  – population standard deviation in °C (0 when Counts[i]<2)
type aggregateResponse struct {
	Start    string    `json:"start"`
	Counts   []int     `json:"counts"`
	Averages []float64 `json:"averages"`
	StdDevs  []float64 `json:"std_devs"`
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

func newAggregateHandler(store DataStore, meta map[string]StationMeta, pc *precomputedCache, lru *lruCache, q *calcQueue) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 8<<20) // 8 MiB body limit (up to ~50k IDs)

		var req aggregateRequest
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

		// 1. Pre-computed all-station cache (blocks until ready if still computing).
		if data, ok := pc.get(req); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Write(data) //nolint:errcheck
			return
		}

		// 2. LRU response cache.
		cacheKey := requestFingerprint(req)
		if data, ok := lru.get(cacheKey); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Write(data) //nolint:errcheck
			return
		}

		// 3. Live computation — run under the concurrency queue.
		var resp *aggregateResponse
		var computeErr error
		ran, retryAfter := q.run(func() {
			resp, computeErr = computeAggregate(store, meta, req)
		})
		if !ran {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter))))
			http.Error(w, "server busy, try again later", http.StatusServiceUnavailable)
			return
		}
		if computeErr != nil {
			log.Printf("aggregate error: %v", computeErr)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}

		data, err := json.Marshal(resp)
		if err != nil {
			log.Printf("encoding response: %v", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		lru.put(cacheKey, data)

		w.Header().Set("Content-Type", "application/json")
		w.Write(data) //nolint:errcheck
	}
}

// validStationID returns true for purely alphanumeric IDs (prevents path traversal).
func validStationID(id string) bool {
	if len(id) == 0 || len(id) > 32 {
		return false
	}
	for _, c := range id {
		if !unicode.IsLetter(c) && !unicode.IsDigit(c) && c != '-' {
			return false
		}
	}
	return true
}

// ── Anomaly computation ───────────────────────────────────────────────────────

// stationAnomalyRows converts raw monthly observations into anomalies relative
// to a per-station, per-calendar-month baseline.
//
// Baseline selection:
//   - A "full year" is one where all 12 months have non-missing values.
//   - The station midpoint is the average of the first and last year with any data.
//   - Up to 30 full years nearest the midpoint are used; ties in distance are
//     broken by taking earlier years first.
//   - If there are no full years the station is dropped (ok = false).
//
// Anomalies are stored as centidegrees (same unit as the raw data).
func stationAnomalyRows(rows StationRows) (anomalyRows StationRows, ok bool) {
	// Collect all years with data and identify full years.
	allYears := make([]int, 0, len(rows))
	var fullYears []int
	for year, row := range rows {
		allYears = append(allYears, year)
		full := true
		for m := 0; m < 12; m++ {
			if row[m] == missVal {
				full = false
				break
			}
		}
		if full {
			fullYears = append(fullYears, year)
		}
	}
	if len(fullYears) == 0 {
		return nil, false
	}

	sort.Ints(allYears)
	midYear := float64(allYears[0]+allYears[len(allYears)-1]) / 2.0

	// Sort full years by distance from the station midpoint, earlier year first
	// when distances are equal.
	sort.Slice(fullYears, func(i, j int) bool {
		di := math.Abs(float64(fullYears[i]) - midYear)
		dj := math.Abs(float64(fullYears[j]) - midYear)
		if di != dj {
			return di < dj
		}
		return fullYears[i] < fullYears[j]
	})

	n := len(fullYears)
	if n > 30 {
		n = 30
	}

	// Compute monthly baseline means in centidegrees.
	var baseline [12]float64
	for _, year := range fullYears[:n] {
		row := rows[year]
		for m := 0; m < 12; m++ {
			baseline[m] += float64(row[m])
		}
	}
	for m := 0; m < 12; m++ {
		baseline[m] /= float64(n)
	}

	// Subtract the baseline from every month that has a reading.
	anomalyRows = make(StationRows, len(rows))
	for year, row := range rows {
		var aRow MonthRow
		for m := 0; m < 12; m++ {
			if row[m] == missVal {
				aRow[m] = missVal
			} else {
				// Anomaly in centidegrees; real anomalies are well within int16 range.
				aRow[m] = int16(math.Round(float64(row[m]) - baseline[m]))
			}
		}
		anomalyRows[year] = aRow
	}
	return anomalyRows, true
}

// ── Full-years filter ─────────────────────────────────────────────────────────

// filterFullYears returns a copy of rows containing only years where all
// twelve months are non-missing.  Years with any missing month are omitted
// entirely, so those station-years contribute to no monthly slot in the
// aggregate.
func filterFullYears(rows StationRows) StationRows {
	out := make(StationRows)
	for year, row := range rows {
		full := true
		for m := 0; m < 12; m++ {
			if row[m] == missVal {
				full = false
				break
			}
		}
		if full {
			out[year] = row
		}
	}
	return out
}

// ── Aggregation ───────────────────────────────────────────────────────────────

type stationEntry struct {
	rows StationRows
	lat  float64
}

func computeAggregate(store DataStore, meta map[string]StationMeta, req aggregateRequest) (*aggregateResponse, error) {
	// Load data for all requested stations and determine the global year range.
	var stations []stationEntry
	globalMin := math.MaxInt32
	globalMax := math.MinInt32

	for _, id := range req.StationIDs {
		rows, err := store.Load(req.Series, id)
		if err != nil {
			log.Printf("skipping %s: %v", id, err)
			continue
		}
		if len(rows) == 0 {
			continue
		}

		if req.Anomaly {
			var ok bool
			rows, ok = stationAnomalyRows(rows)
			if !ok {
				continue // station has no full years — cannot compute baseline
			}
		}

		if req.FullYearsOnly {
			rows = filterFullYears(rows)
			if len(rows) == 0 {
				continue // station has no complete years — nothing to contribute
			}
		}

		lat := 0.0
		if m, ok := meta[id]; ok {
			lat = m.Lat
		}

		for year := range rows {
			if year < globalMin {
				globalMin = year
			}
			if year > globalMax {
				globalMax = year
			}
		}
		stations = append(stations, stationEntry{rows: rows, lat: lat})
	}

	if len(stations) == 0 {
		return &aggregateResponse{
			Start:    "",
			Counts:   []int{},
			Averages: []float64{},
			StdDevs:  []float64{},
		}, nil
	}

	totalMonths := (globalMax-globalMin+1) * 12

	// monthStat accumulates running weighted mean and variance for one month
	// using Welford's online algorithm, extended to support per-station weights.
	type monthStat struct {
		count int     // number of contributing stations
		sumW  float64 // sum of weights
		mean  float64 // current weighted mean (°C)
		m2    float64 // weighted sum of squared deviations (for variance)
	}
	stats := make([]monthStat, totalMonths)

	for _, s := range stations {
		// For a simple numerical average every station has equal weight (1.0).
		// For geo-gridded aggregation we weight by cos(lat) to approximate the
		// area of the grid cell each station represents.
		weight := 1.0
		if req.GeoGridded {
			weight = math.Cos(s.lat * math.Pi / 180.0)
			if weight < 1e-10 {
				weight = 1e-10 // avoid zero weight at the poles
			}
		}

		for year, row := range s.rows {
			base := (year - globalMin) * 12
			for m := 0; m < 12; m++ {
				if row[m] == missVal {
					continue
				}
				val := float64(row[m]) / 100.0 // centidegrees → °C

				st := &stats[base+m]
				st.count++
				st.sumW += weight

				// Welford's weighted online update:
				//   delta = x - old_mean
				//   mean  += (w / sumW) * delta
				//   m2    += w * delta * (x - new_mean)
				oldMean := st.mean
				st.mean += (weight / st.sumW) * (val - oldMean)
				st.m2 += weight * (val - oldMean) * (val - st.mean)
			}
		}
	}

	counts := make([]int, totalMonths)
	averages := make([]float64, totalMonths)
	stdDevs := make([]float64, totalMonths)

	for i, st := range stats {
		counts[i] = st.count
		if st.count > 0 {
			averages[i] = st.mean
			if st.count > 1 {
				stdDevs[i] = math.Sqrt(st.m2 / st.sumW)
			}
		}
	}

	return &aggregateResponse{
		Start:    fmt.Sprintf("%04d-%02d", globalMin, 1),
		Counts:   counts,
		Averages: averages,
		StdDevs:  stdDevs,
	}, nil
}
