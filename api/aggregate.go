package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// ── Request / Response types ──────────────────────────────────────────────────

type aggregateRequest struct {
	StationIDs    []string `json:"station_ids"`
	GeoGridded    bool     `json:"geo_gridded"`
	Series        string   `json:"series"`          // "qcf" or "qcu"
	Anomaly       bool     `json:"anomaly"`          // deprecated: use anomaly_mode="station"
	AnomalyMode   string   `json:"anomaly_mode"`     // see validAnomalyModes
	AnomalyRef    int      `json:"anomaly_ref"`      // for decade/year modes: decade start (multiple of 10) or year
	FullYearsOnly bool     `json:"full_years_only"`
}

// effectiveAnomalyMode returns the normalised anomaly mode, folding the
// deprecated Anomaly bool into "station" for backward compatibility.
func (req aggregateRequest) effectiveAnomalyMode() string {
	switch req.AnomalyMode {
	case "none":
		return ""
	case "":
		if req.Anomaly {
			return "station"
		}
		return ""
	default:
		return req.AnomalyMode
	}
}

// aggregateResponse describes a contiguous monthly time series starting at Start.
// Each array element corresponds to one calendar month.
//
//   - StationCount – stations that passed the anomaly-mode filter and contributed
//     to the result; always present so the UI can flag significant drops when a
//     strict reference mode excludes stations that lack the chosen period
//   - Counts      – per-month station counts (subset of StationCount; varies by
//     data availability within each year)
//   - Averages    – (weighted) mean temperature in °C (0 when Counts[i]==0)
//   - StdDevs     – population standard deviation in °C (0 when Counts[i]<2)
//   - AnomalyMode / AnomalyRef – resolved reference when an auto or specific
//     reference mode was used; omitted for "station" and no-anomaly modes
type aggregateResponse struct {
	Start        string    `json:"start"`
	StationCount int       `json:"station_count"`
	Counts       []int     `json:"counts"`
	Averages     []float64 `json:"averages"`
	StdDevs      []float64 `json:"std_devs"`
	AnomalyMode  string    `json:"anomaly_mode,omitempty"`
	AnomalyRef   int       `json:"anomaly_ref,omitempty"`
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

var validAnomalyModes = map[string]bool{
	"":                     true,
	"none":                 true,
	"station":              true,
	"auto_decade":          true,
	"auto_decade_fallback": true,
	"auto_year":            true,
	"auto_year_fallback":   true,
	"decade":               true,
	"decade_fallback":      true,
	"year":                 true,
	"year_fallback":        true,
}

func newAggregateHandler(store DataStore, meta map[string]StationMeta, pc *precomputedCache, q *calcQueue) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 8<<20) // 8 MiB body limit

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
		if !validAnomalyModes[req.AnomalyMode] {
			http.Error(w, "invalid anomaly_mode", http.StatusBadRequest)
			return
		}
		if req.AnomalyMode == "decade" || req.AnomalyMode == "decade_fallback" {
			if req.AnomalyRef <= 0 || req.AnomalyRef%10 != 0 {
				http.Error(w, "anomaly_ref must be a positive multiple of 10 for decade modes", http.StatusBadRequest)
				return
			}
		}
		if req.AnomalyMode == "year" || req.AnomalyMode == "year_fallback" {
			if req.AnomalyRef <= 0 {
				http.Error(w, "anomaly_ref must be a positive year for year modes", http.StatusBadRequest)
				return
			}
		}
		for _, id := range req.StationIDs {
			if !isValidStationID(id) {
				http.Error(w, fmt.Sprintf("invalid station_id %q", id), http.StatusBadRequest)
				return
			}
		}

		// 1. Pre-computed all-station cache (handles "" and "station" modes only).
		if data, ok := pc.get(req); ok {
			log.Printf("aggregate: hit=precomputed series=%s mode=%s geo_gridded=%v stations=%d",
				req.Series, req.effectiveAnomalyMode(), req.GeoGridded, len(req.StationIDs))
			w.Header().Set("Content-Type", "application/json")
			w.Write(data) //nolint:errcheck
			return
		}

		// 2. Live computation — run under the concurrency queue.
		var resp *aggregateResponse
		var computeErr error
		ran, elapsed, retryAfter := q.run(func() {
			resp, computeErr = computeAggregate(store, meta, req)
		})
		if !ran {
			log.Printf("aggregate: rejected series=%s mode=%s geo_gridded=%v stations=%d est=%.1fs",
				req.Series, req.effectiveAnomalyMode(), req.GeoGridded, len(req.StationIDs), retryAfter)
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retryAfter))))
			http.Error(w, "server busy, try again later", http.StatusServiceUnavailable)
			return
		}
		log.Printf("aggregate: miss series=%s mode=%s geo_gridded=%v stations=%d duration=%s ewma=%.3fs",
			req.Series, req.effectiveAnomalyMode(), req.GeoGridded, len(req.StationIDs),
			elapsed.Round(time.Millisecond), q.currentEWMA())
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

		w.Header().Set("Content-Type", "application/json")
		w.Write(data) //nolint:errcheck
	}
}


// ── Decade / Year reference helpers ──────────────────────────────────────────

// stationHasDecade reports whether rows contains ≥ 9 non-missing observations
// for each of the 12 calendar months within the decade [decade, decade+10).
// Decade must be a multiple of 10 (e.g. 1980 covers 1980–1989).
func stationHasDecade(rows StationRows, decade int) bool {
	for m := 0; m < 12; m++ {
		n := 0
		for y := decade; y < decade+10; y++ {
			if row, ok := rows[y]; ok && row[m] != missVal {
				n++
			}
		}
		if n < 9 {
			return false
		}
	}
	return true
}

// stationHasYear reports whether rows contains a complete year (all 12 months
// non-missing) for the given year.
func stationHasYear(rows StationRows, year int) bool {
	row, ok := rows[year]
	if !ok {
		return false
	}
	for m := 0; m < 12; m++ {
		if row[m] == missVal {
			return false
		}
	}
	return true
}

// decadeBaseline computes per-calendar-month means (centidegrees) over the
// decade [decade, decade+10). Returns false if any month has < 9 observations.
func decadeBaseline(rows StationRows, decade int) ([12]float64, bool) {
	var sums [12]float64
	var counts [12]int
	for y := decade; y < decade+10; y++ {
		row, ok := rows[y]
		if !ok {
			continue
		}
		for m := 0; m < 12; m++ {
			if row[m] != missVal {
				sums[m] += float64(row[m])
				counts[m]++
			}
		}
	}
	for m := 0; m < 12; m++ {
		if counts[m] < 9 {
			return [12]float64{}, false
		}
	}
	var b [12]float64
	for m := 0; m < 12; m++ {
		b[m] = sums[m] / float64(counts[m])
	}
	return b, true
}

// yearBaseline returns the 12 monthly values (centidegrees) for a complete
// year as a baseline. Returns false if the year is absent or has any missing month.
func yearBaseline(rows StationRows, year int) ([12]float64, bool) {
	row, ok := rows[year]
	if !ok {
		return [12]float64{}, false
	}
	var b [12]float64
	for m := 0; m < 12; m++ {
		if row[m] == missVal {
			return [12]float64{}, false
		}
		b[m] = float64(row[m])
	}
	return b, true
}

// applyBaseline subtracts a per-calendar-month baseline (centidegrees) from
// every observation in rows. Missing values remain missing.
func applyBaseline(rows StationRows, baseline [12]float64) StationRows {
	out := make(StationRows, len(rows))
	for year, row := range rows {
		var a MonthRow
		for m := 0; m < 12; m++ {
			if row[m] == missVal {
				a[m] = missVal
			} else {
				a[m] = int16(math.Round(float64(row[m]) - baseline[m]))
			}
		}
		out[year] = a
	}
	return out
}

// nearestDecadeWithRows returns the decade start (multiple of 10) nearest to
// target for which the station passes stationHasDecade. Ties favour the earlier
// decade. Returns 0, false when no eligible decade exists.
func nearestDecadeWithRows(rows StationRows, target int) (int, bool) {
	best, bestDist, found := 0, math.MaxInt32, false
	seen := map[int]bool{}
	for y := range rows {
		d := (y / 10) * 10
		if seen[d] {
			continue
		}
		seen[d] = true
		if !stationHasDecade(rows, d) {
			continue
		}
		dist := d - target
		if dist < 0 {
			dist = -dist
		}
		if !found || dist < bestDist || (dist == bestDist && d < best) {
			best, bestDist, found = d, dist, true
		}
	}
	return best, found
}

// nearestYearWithRows returns the complete year nearest to target for which
// stationHasYear is true. Ties favour the earlier year.
// Returns 0, false when no eligible year exists.
func nearestYearWithRows(rows StationRows, target int) (int, bool) {
	best, bestDist, found := 0, math.MaxInt32, false
	for y := range rows {
		if !stationHasYear(rows, y) {
			continue
		}
		dist := y - target
		if dist < 0 {
			dist = -dist
		}
		if !found || dist < bestDist || (dist == bestDist && y < best) {
			best, bestDist, found = y, dist, true
		}
	}
	return best, found
}

// ── Auto-resolution helpers ───────────────────────────────────────────────────

type rawStation struct {
	rows StationRows
	lat  float64
}

// findMostCommonDecade returns the decade (multiple of 10) that the greatest
// number of stations in raw pass stationHasDecade. Ties favour the earlier
// decade. Returns 0, false when no eligible decade is found.
func findMostCommonDecade(raw []rawStation) (int, bool) {
	counts := make(map[int]int)
	for _, s := range raw {
		seen := map[int]bool{}
		for y := range s.rows {
			d := (y / 10) * 10
			if !seen[d] {
				seen[d] = true
				if stationHasDecade(s.rows, d) {
					counts[d]++
				}
			}
		}
	}
	if len(counts) == 0 {
		return 0, false
	}
	best, bestCount, first := 0, 0, true
	for d, c := range counts {
		if first || c > bestCount || (c == bestCount && d < best) {
			best, bestCount, first = d, c, false
		}
	}
	return best, true
}

// findMostCommonYear returns the year that the greatest number of stations in
// raw have a complete record for (stationHasYear). Ties favour the earlier year.
// Returns 0, false when no eligible year is found.
func findMostCommonYear(raw []rawStation) (int, bool) {
	counts := make(map[int]int)
	for _, s := range raw {
		for y := range s.rows {
			if stationHasYear(s.rows, y) {
				counts[y]++
			}
		}
	}
	if len(counts) == 0 {
		return 0, false
	}
	best, bestCount, first := 0, 0, true
	for y, c := range counts {
		if first || c > bestCount || (c == bestCount && y < best) {
			best, bestCount, first = y, c, false
		}
	}
	return best, true
}

// ── Anomaly computation ───────────────────────────────────────────────────────

// applyAnomalyMode applies an anomaly transform to rows using the given mode
// and pre-resolved reference value. Returns (nil, false) when the station
// cannot satisfy the mode and should be excluded from the aggregate.
func applyAnomalyMode(rows StationRows, mode string, ref int) (StationRows, bool) {
	switch mode {
	case "station":
		return stationAnomalyRows(rows)

	case "auto_decade", "decade":
		b, ok := decadeBaseline(rows, ref)
		if !ok {
			return nil, false
		}
		return applyBaseline(rows, b), true

	case "auto_decade_fallback", "decade_fallback":
		b, ok := decadeBaseline(rows, ref)
		if !ok {
			nearRef, found := nearestDecadeWithRows(rows, ref)
			if !found {
				return nil, false
			}
			b, ok = decadeBaseline(rows, nearRef)
			if !ok {
				return nil, false
			}
		}
		return applyBaseline(rows, b), true

	case "auto_year", "year":
		b, ok := yearBaseline(rows, ref)
		if !ok {
			return nil, false
		}
		return applyBaseline(rows, b), true

	case "auto_year_fallback", "year_fallback":
		b, ok := yearBaseline(rows, ref)
		if !ok {
			nearRef, found := nearestYearWithRows(rows, ref)
			if !found {
				return nil, false
			}
			b, ok = yearBaseline(rows, nearRef)
			if !ok {
				return nil, false
			}
		}
		return applyBaseline(rows, b), true
	}
	return nil, false
}

// stationAnomalyRows converts raw monthly observations into anomalies relative
// to a per-station, per-calendar-month baseline.
//
// Baseline selection:
//   - A "full year" is one where all 12 months have non-missing values.
//   - The station midpoint is the average of the first and last year with any data.
//   - Up to 30 full years nearest the midpoint are used; ties broken by earlier.
//   - If there are no full years the station is dropped (ok = false).
//
// Anomalies are stored as centidegrees (same unit as the raw data).
func stationAnomalyRows(rows StationRows) (StationRows, bool) {
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

	return applyBaseline(rows, baseline), true
}

// ── Full-years filter ─────────────────────────────────────────────────────────

// filterFullYears returns a copy of rows containing only years where all
// twelve months are non-missing.
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
	mode := req.effectiveAnomalyMode()

	// Phase 1: Load all station data.
	raw := make([]rawStation, 0, len(req.StationIDs))
	for _, id := range req.StationIDs {
		rows, err := store.Load(req.Series, id)
		if err != nil {
			log.Printf("skipping %s: %v", id, err)
			continue
		}
		if len(rows) == 0 {
			continue
		}
		lat := 0.0
		if m, ok := meta[id]; ok {
			lat = m.Lat
		}
		raw = append(raw, rawStation{rows: rows, lat: lat})
	}

	// Phase 2: Resolve the reference value for auto modes.
	resolvedRef := req.AnomalyRef
	if mode == "auto_decade" || mode == "auto_decade_fallback" {
		ref, ok := findMostCommonDecade(raw)
		if !ok {
			return emptyAggregateResponse(), nil
		}
		resolvedRef = ref
	} else if mode == "auto_year" || mode == "auto_year_fallback" {
		ref, ok := findMostCommonYear(raw)
		if !ok {
			return emptyAggregateResponse(), nil
		}
		resolvedRef = ref
	}

	// Phase 3: Apply anomaly transform and build the station list.
	var stations []stationEntry
	globalMin := math.MaxInt32
	globalMax := math.MinInt32

	for _, r := range raw {
		rows := r.rows

		if mode != "" {
			var ok bool
			rows, ok = applyAnomalyMode(rows, mode, resolvedRef)
			if !ok {
				continue // station excluded by the mode's eligibility criteria
			}
		}

		if req.FullYearsOnly {
			rows = filterFullYears(rows)
			if len(rows) == 0 {
				continue
			}
		}

		for year := range rows {
			if year < globalMin {
				globalMin = year
			}
			if year > globalMax {
				globalMax = year
			}
		}
		stations = append(stations, stationEntry{rows: rows, lat: r.lat})
	}

	if len(stations) == 0 {
		return emptyAggregateResponse(), nil
	}

	totalMonths := (globalMax-globalMin+1) * 12

	// monthStat accumulates running weighted mean and variance using
	// Welford's online algorithm extended for per-station weights.
	type monthStat struct {
		count int
		sumW  float64
		mean  float64
		m2    float64
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
				weight = 1e-10
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

	resp := &aggregateResponse{
		Start:        fmt.Sprintf("%04d-%02d", globalMin, 1),
		StationCount: len(stations),
		Counts:       counts,
		Averages:     averages,
		StdDevs:      stdDevs,
	}
	// Echo back the resolved mode and reference for auto/specific reference
	// modes so clients know which baseline was actually used.
	switch mode {
	case "auto_decade", "auto_decade_fallback",
		"auto_year", "auto_year_fallback",
		"decade", "decade_fallback",
		"year", "year_fallback":
		resp.AnomalyMode = mode
		resp.AnomalyRef = resolvedRef
	}
	return resp, nil
}

func emptyAggregateResponse() *aggregateResponse {
	return &aggregateResponse{
		Start:    "",
		Counts:   []int{},
		Averages: []float64{},
		StdDevs:  []float64{},
	}
}
