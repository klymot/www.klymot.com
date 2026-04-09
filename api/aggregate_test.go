package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ── mockStore ─────────────────────────────────────────────────────────────────

// mockStore implements DataStore with a fixed set of in-memory rows.
// Keys are "series/stationID" matching the DataStore.Load contract.
type mockStore struct {
	data map[string]StationRows
}

func (m *mockStore) Load(series, stationID string) (StationRows, error) {
	rows, ok := m.data[series+"/"+stationID]
	if !ok {
		return nil, nil
	}
	return rows, nil
}

// makeRows is a convenience helper that builds a StationRows map from a slice
// of (year, [12]int16) pairs. Use missVal for months without data.
func makeRows(pairs ...interface{}) StationRows {
	rows := make(StationRows)
	for i := 0; i < len(pairs)-1; i += 2 {
		year := pairs[i].(int)
		row := pairs[i+1].([12]int16)
		rows[year] = MonthRow(row)
	}
	return rows
}

// uniform returns a [12]int16 where every month has the same centidegree value.
func uniform(v int16) [12]int16 {
	var row [12]int16
	for i := range row {
		row[i] = v
	}
	return row
}

// ── computeAggregate ──────────────────────────────────────────────────────────

func TestComputeAggregate_noStations(t *testing.T) {
	store := &mockStore{data: map[string]StationRows{}}
	meta := map[string]StationMeta{}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"NOTFOUND"},
		Series:     "qcf",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Start != "" {
		t.Errorf("Start = %q, want empty string for no data", resp.Start)
	}
	if len(resp.Counts) != 0 {
		t.Errorf("Counts not empty for no data")
	}
}

func TestComputeAggregate_singleStation(t *testing.T) {
	// Station with a single year where Jan = 1000 centidegrees = 10°C.
	store := &mockStore{data: map[string]StationRows{
		"qcf/AAA00000001": makeRows(
			2000, [12]int16{1000, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}
	meta := map[string]StationMeta{"AAA00000001": {Lat: 0, Lng: 0}}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"AAA00000001"},
		Series:     "qcf",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Start != "2000-01" {
		t.Errorf("Start = %q, want 2000-01", resp.Start)
	}
	if len(resp.Counts) != 12 {
		t.Fatalf("got %d months, want 12", len(resp.Counts))
	}
	if resp.Counts[0] != 1 {
		t.Errorf("Counts[0] = %d, want 1 (Jan has data)", resp.Counts[0])
	}
	if resp.Counts[1] != 0 {
		t.Errorf("Counts[1] = %d, want 0 (Feb missing)", resp.Counts[1])
	}
	if got, want := resp.Averages[0], 10.0; math.Abs(got-want) > 1e-9 {
		t.Errorf("Averages[0] = %v, want %v", got, want)
	}
	if resp.StdDevs[0] != 0 {
		t.Errorf("StdDevs[0] = %v, want 0 for single observation", resp.StdDevs[0])
	}
}

func TestComputeAggregate_simpleAverage_twoStations(t *testing.T) {
	// Two stations, same year, Jan: 1000 and 2000 centidegrees → mean 15°C, std dev 5°C.
	store := &mockStore{data: map[string]StationRows{
		"qcf/STA00000001": makeRows(2000, uniform(1000)),
		"qcf/STA00000002": makeRows(2000, uniform(2000)),
	}}
	meta := map[string]StationMeta{
		"STA00000001": {Lat: 0},
		"STA00000002": {Lat: 0},
	}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"STA00000001", "STA00000002"},
		Series:     "qcf",
		GeoGridded: false,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for m := 0; m < 12; m++ {
		if resp.Counts[m] != 2 {
			t.Errorf("month %d: Counts = %d, want 2", m, resp.Counts[m])
		}
		if got, want := resp.Averages[m], 15.0; math.Abs(got-want) > 1e-9 {
			t.Errorf("month %d: Averages = %v, want %v", m, got, want)
		}
		if got, want := resp.StdDevs[m], 5.0; math.Abs(got-want) > 1e-9 {
			t.Errorf("month %d: StdDevs = %v, want %v", m, got, want)
		}
	}
}

func TestComputeAggregate_geoGridded_twoStations(t *testing.T) {
	// Station A at equator (lat=0):  weight = cos(0°) = 1.0, value = 1000 centideg = 10°C
	// Station B at 60°N (lat=60):   weight = cos(60°) = 0.5, value = 2000 centideg = 20°C
	// Weighted mean = (1.0*10 + 0.5*20) / (1.0+0.5) = 20/1.5 ≈ 13.333°C
	store := &mockStore{data: map[string]StationRows{
		"qcf/GEO00000001": makeRows(2000, uniform(1000)),
		"qcf/GEO00000002": makeRows(2000, uniform(2000)),
	}}
	meta := map[string]StationMeta{
		"GEO00000001": {Lat: 0},
		"GEO00000002": {Lat: 60},
	}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"GEO00000001", "GEO00000002"},
		Series:     "qcf",
		GeoGridded: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	wantMean := 20.0 / 1.5 // ≈ 13.333...
	if got := resp.Averages[0]; math.Abs(got-wantMean) > 1e-9 {
		t.Errorf("Averages[0] = %v, want %v (geo-gridded weighted mean)", got, wantMean)
	}
}

func TestComputeAggregate_geoGriddedVsSimple_differ(t *testing.T) {
	// Verify geo-gridded and simple modes produce different results when stations
	// are at different latitudes with different values.
	store := &mockStore{data: map[string]StationRows{
		"qcf/DIFF0000001": makeRows(2000, uniform(0)),    // 0°C at equator (weight≈1)
		"qcf/DIFF0000002": makeRows(2000, uniform(9000)), // 90°C at 89°N  (weight≈0)
	}}
	meta := map[string]StationMeta{
		"DIFF0000001": {Lat: 0},
		"DIFF0000002": {Lat: 89},
	}

	ids := []string{"DIFF0000001", "DIFF0000002"}
	simple, _ := computeAggregate(store, meta, aggregateRequest{StationIDs: ids, Series: "qcf", GeoGridded: false})
	geo, _ := computeAggregate(store, meta, aggregateRequest{StationIDs: ids, Series: "qcf", GeoGridded: true})

	if simple.Averages[0] == geo.Averages[0] {
		t.Errorf("simple and geo-gridded averages should differ, both got %v", simple.Averages[0])
	}
	// Geo-gridded result should be much closer to 0 (the equatorial station dominates).
	if geo.Averages[0] >= simple.Averages[0] {
		t.Errorf("geo-gridded avg %v should be less than simple avg %v (equator dominates)", geo.Averages[0], simple.Averages[0])
	}
}

func TestComputeAggregate_dateRange_multiYear(t *testing.T) {
	// Station A covers 2000–2001, station B covers 2001–2002.
	// Global range should span 2000–2002 = 36 months.
	store := &mockStore{data: map[string]StationRows{
		"qcf/RNG00000001": makeRows(
			2000, uniform(1000),
			2001, uniform(1000),
		),
		"qcf/RNG00000002": makeRows(
			2001, uniform(2000),
			2002, uniform(2000),
		),
	}}
	meta := map[string]StationMeta{}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"RNG00000001", "RNG00000002"},
		Series:     "qcf",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Start != "2000-01" {
		t.Errorf("Start = %q, want 2000-01", resp.Start)
	}
	if got, want := len(resp.Counts), 36; got != want {
		t.Fatalf("len(Counts) = %d, want %d (3 years × 12 months)", got, want)
	}
	// 2000 months: only station A → count=1, avg=10
	if resp.Counts[0] != 1 {
		t.Errorf("2000-Jan count = %d, want 1", resp.Counts[0])
	}
	// 2001 months: both stations → count=2, avg=15
	if resp.Counts[12] != 2 {
		t.Errorf("2001-Jan count = %d, want 2", resp.Counts[12])
	}
	if got, want := resp.Averages[12], 15.0; math.Abs(got-want) > 1e-9 {
		t.Errorf("2001-Jan avg = %v, want %v", got, want)
	}
	// 2002 months: only station B → count=1, avg=20
	if resp.Counts[24] != 1 {
		t.Errorf("2002-Jan count = %d, want 1", resp.Counts[24])
	}
}

func TestComputeAggregate_missingMonthsNotCounted(t *testing.T) {
	// Every month is missing except January.
	store := &mockStore{data: map[string]StationRows{
		"qcf/MSS00000001": makeRows(
			2005, [12]int16{1500, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}
	meta := map[string]StationMeta{}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"MSS00000001"},
		Series:     "qcf",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Counts[0] != 1 {
		t.Errorf("Jan count = %d, want 1", resp.Counts[0])
	}
	for m := 1; m < 12; m++ {
		if resp.Counts[m] != 0 {
			t.Errorf("month %d count = %d, want 0 (missing)", m, resp.Counts[m])
		}
		if resp.Averages[m] != 0 {
			t.Errorf("month %d avg = %v, want 0 (no data)", m, resp.Averages[m])
		}
	}
}

func TestComputeAggregate_unknownStationSkipped(t *testing.T) {
	store := &mockStore{data: map[string]StationRows{
		"qcf/KNW00000001": makeRows(2000, uniform(1000)),
	}}
	meta := map[string]StationMeta{}

	resp, err := computeAggregate(store, meta, aggregateRequest{
		StationIDs: []string{"KNW00000001", "NOSUCHSTATION"},
		Series:     "qcf",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Should still succeed with the one known station.
	if resp.Counts[0] != 1 {
		t.Errorf("Jan count = %d, want 1", resp.Counts[0])
	}
}

// ── stationAnomalyRows ────────────────────────────────────────────────────────

func TestStationAnomalyRows_noFullYears(t *testing.T) {
	// Station with only partial years (missing months) — should be dropped.
	rows := makeRows(
		2000, [12]int16{1000, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
	)
	_, ok := stationAnomalyRows(rows)
	if ok {
		t.Error("expected ok=false for station with no full years")
	}
}

func TestStationAnomalyRows_singleFullYear(t *testing.T) {
	// One full year: anomaly for each month must be zero (baseline == the year itself).
	rows := makeRows(2000, uniform(1200))
	aRows, ok := stationAnomalyRows(rows)
	if !ok {
		t.Fatal("expected ok=true")
	}
	row := aRows[2000]
	for m := 0; m < 12; m++ {
		if row[m] != 0 {
			t.Errorf("month %d anomaly = %d, want 0", m, row[m])
		}
	}
}

func TestStationAnomalyRows_anomalyIsCorrect(t *testing.T) {
	// Baseline from 2000 (all months = 1000 centidegrees = 10 °C).
	// 2001 has all months at 1200 (= 12 °C) → anomaly should be +200 centidegrees.
	rows := makeRows(
		2000, uniform(1000),
		2001, uniform(1200),
	)
	aRows, ok := stationAnomalyRows(rows)
	if !ok {
		t.Fatal("expected ok=true")
	}
	// Both years are equally close to the midpoint (2000.5), but only two full
	// years exist so both are used in the baseline → baseline = 1100 centidegrees.
	for m := 0; m < 12; m++ {
		if aRows[2000][m] != -100 {
			t.Errorf("2000 month %d: got %d, want -100", m, aRows[2000][m])
		}
		if aRows[2001][m] != 100 {
			t.Errorf("2001 month %d: got %d, want 100", m, aRows[2001][m])
		}
	}
}

func TestStationAnomalyRows_partialYearPreserved(t *testing.T) {
	// Partial years should appear in the anomaly output but missing months stay missing.
	rows := makeRows(
		2000, uniform(1000), // full year → baseline month mean = 1000
		2001, [12]int16{1200, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
	)
	aRows, ok := stationAnomalyRows(rows)
	if !ok {
		t.Fatal("expected ok=true")
	}
	// Baseline: only 2000 is a full year, so baseline = 1000 for all months.
	if aRows[2001][0] != 200 {
		t.Errorf("2001-Jan anomaly = %d, want 200", aRows[2001][0])
	}
	for m := 1; m < 12; m++ {
		if aRows[2001][m] != missVal {
			t.Errorf("2001 month %d: got %d, want missVal", m, aRows[2001][m])
		}
	}
}

func TestStationAnomalyRows_selectsNearestMidpoint(t *testing.T) {
	// Station spans 2000–2010 (midpoint = 2005). Full years at 2000 and 2010.
	// The year nearest the midpoint is 2010 (distance 5) and 2000 (distance 5) — tie.
	// Partial year at 2005: only January present.
	// With only 2 full years, both are used; baseline jan = mean(2000-jan, 2010-jan).
	rows := makeRows(
		2000, uniform(1000),
		2005, [12]int16{1300, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		2010, uniform(2000),
	)
	aRows, ok := stationAnomalyRows(rows)
	if !ok {
		t.Fatal("expected ok=true")
	}
	// baseline jan = (1000 + 2000) / 2 = 1500
	if aRows[2005][0] != -200 { // 1300 - 1500 = -200
		t.Errorf("2005-Jan anomaly = %d, want -200", aRows[2005][0])
	}
}

// ── computeAggregate anomaly mode ─────────────────────────────────────────────

func TestComputeAggregate_anomaly_zeroWhenBaselineMatchesData(t *testing.T) {
	// One station, one full year. Baseline = that year → all anomalies = 0.
	store := &mockStore{data: map[string]StationRows{
		"qcf/ANM00000001": makeRows(2000, uniform(1500)),
	}}
	resp, err := computeAggregate(store, nil, aggregateRequest{
		StationIDs: []string{"ANM00000001"},
		Series:     "qcf",
		Anomaly:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for m := 0; m < 12; m++ {
		if math.Abs(resp.Averages[m]) > 1e-6 {
			t.Errorf("month %d average = %v, want 0", m, resp.Averages[m])
		}
	}
}

func TestComputeAggregate_anomaly_twoStations(t *testing.T) {
	// Station A: baseline 1000, all data 1000 → anomaly 0.
	// Station B: baseline 2000, all data 2200 → anomaly +200 centidegrees = +2 °C.
	// Mean anomaly = +1 °C.
	store := &mockStore{data: map[string]StationRows{
		"qcf/ANM00000001": makeRows(2000, uniform(1000)),
		"qcf/ANM00000002": makeRows(2000, uniform(2200)),
	}}
	// Station B needs a second year so both are full years but the baseline differs
	// from the observation. Simpler: give each station only one full year.
	// With one full year, baseline = that year, so anomaly = 0 for both.
	// For a non-zero result, we need the observation year to differ from baseline.
	// Give station A two years: baseline year 2000 (1000), obs year 2001 (1200).
	// Give station B two years: baseline year 2000 (2000), obs year 2001 (1800).
	store2 := &mockStore{data: map[string]StationRows{
		"qcf/ANM00000001": makeRows(2000, uniform(1000), 2001, uniform(1200)),
		"qcf/ANM00000002": makeRows(2000, uniform(2000), 2001, uniform(1800)),
	}}
	resp, err := computeAggregate(store2, nil, aggregateRequest{
		StationIDs: []string{"ANM00000001", "ANM00000002"},
		Series:     "qcf",
		Anomaly:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = store // silence unused warning
	// Both stations have two full years so both are used in the baseline.
	// Station A baseline jan = (1000+1200)/2 = 1100 → 2001 anomaly = +100 centideg = +1 °C.
	// Station B baseline jan = (2000+1800)/2 = 1900 → 2001 anomaly = -100 centideg = -1 °C.
	// Mean = 0. Population std dev = 1 °C.
	idx2001Jan := 12 // (2001 - 2000) * 12 + 0
	if resp.Counts[idx2001Jan] != 2 {
		t.Errorf("2001-Jan count = %d, want 2", resp.Counts[idx2001Jan])
	}
	if math.Abs(resp.Averages[idx2001Jan]) > 1e-6 {
		t.Errorf("2001-Jan average = %v, want 0", resp.Averages[idx2001Jan])
	}
	if math.Abs(resp.StdDevs[idx2001Jan]-1.0) > 1e-6 {
		t.Errorf("2001-Jan std dev = %v, want 1.0", resp.StdDevs[idx2001Jan])
	}
}

func TestComputeAggregate_anomaly_noFullYearsDropped(t *testing.T) {
	// Station has no full years → should produce an empty response.
	store := &mockStore{data: map[string]StationRows{
		"qcf/ANM00000001": makeRows(
			2000, [12]int16{1000, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}
	resp, err := computeAggregate(store, nil, aggregateRequest{
		StationIDs: []string{"ANM00000001"},
		Series:     "qcf",
		Anomaly:    true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Start != "" || len(resp.Counts) != 0 {
		t.Errorf("expected empty response, got start=%q counts=%v", resp.Start, resp.Counts)
	}
}

// ── filterFullYears ───────────────────────────────────────────────────────────

func TestFilterFullYears_keepsFullYears(t *testing.T) {
	rows := makeRows(2000, uniform(1000), 2001, uniform(2000))
	out := filterFullYears(rows)
	if len(out) != 2 {
		t.Errorf("got %d years, want 2", len(out))
	}
	for _, y := range []int{2000, 2001} {
		if _, ok := out[y]; !ok {
			t.Errorf("year %d missing from output", y)
		}
	}
}

func TestFilterFullYears_removesPartialYears(t *testing.T) {
	rows := makeRows(
		2000, uniform(1000), // full
		2001, [12]int16{1200, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal}, // partial
		2002, uniform(1400), // full
	)
	out := filterFullYears(rows)
	if len(out) != 2 {
		t.Errorf("got %d years, want 2 (full only)", len(out))
	}
	if _, ok := out[2001]; ok {
		t.Error("partial year 2001 should be excluded")
	}
}

func TestFilterFullYears_allPartialReturnsEmpty(t *testing.T) {
	rows := makeRows(
		2000, [12]int16{1000, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
	)
	out := filterFullYears(rows)
	if len(out) != 0 {
		t.Errorf("got %d years, want 0", len(out))
	}
}

// ── computeAggregate full-years-only mode ─────────────────────────────────────

func TestComputeAggregate_fullYearsOnly_excludesPartialYears(t *testing.T) {
	// Station has 2000 (full) and 2001 (Jan only).
	// With FullYearsOnly, 2001 should contribute nothing.
	store := &mockStore{data: map[string]StationRows{
		"qcf/FYO00000001": makeRows(
			2000, uniform(1000),
			2001, [12]int16{1200, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}

	resp, err := computeAggregate(store, nil, aggregateRequest{
		StationIDs:    []string{"FYO00000001"},
		Series:        "qcf",
		FullYearsOnly: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Only 2000 (12 months) should appear in output.
	if len(resp.Counts) != 12 {
		t.Fatalf("got %d month slots, want 12 (only 2000)", len(resp.Counts))
	}
	for m := 0; m < 12; m++ {
		if resp.Counts[m] != 1 {
			t.Errorf("month %d count = %d, want 1", m, resp.Counts[m])
		}
	}
}

func TestComputeAggregate_fullYearsOnly_stationDroppedWhenNoFullYear(t *testing.T) {
	// Station has only a partial year → no contribution at all with FullYearsOnly.
	store := &mockStore{data: map[string]StationRows{
		"qcf/FYO00000002": makeRows(
			2000, [12]int16{1000, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}

	resp, err := computeAggregate(store, nil, aggregateRequest{
		StationIDs:    []string{"FYO00000002"},
		Series:        "qcf",
		FullYearsOnly: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Start != "" || len(resp.Counts) != 0 {
		t.Errorf("expected empty response, got start=%q counts=%v", resp.Start, resp.Counts)
	}
}

func TestComputeAggregate_fullYearsOnly_false_includesPartialYears(t *testing.T) {
	// Without FullYearsOnly the partial year's Jan should still count.
	store := &mockStore{data: map[string]StationRows{
		"qcf/FYO00000003": makeRows(
			2000, uniform(1000),
			2001, [12]int16{1200, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}

	resp, err := computeAggregate(store, nil, aggregateRequest{
		StationIDs:    []string{"FYO00000003"},
		Series:        "qcf",
		FullYearsOnly: false,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 2001-Jan (index 12) should have count=1.
	if len(resp.Counts) < 13 {
		t.Fatalf("expected at least 13 month slots, got %d", len(resp.Counts))
	}
	if resp.Counts[12] != 1 {
		t.Errorf("2001-Jan count = %d, want 1 (full_years_only=false)", resp.Counts[12])
	}
}

func TestComputeAggregate_fullYearsOnly_withAnomaly(t *testing.T) {
	// Station A: years 2000 (full, 1000 centideg), 2001 (full, 1200 centideg), 2002 (Jan only).
	// Anomaly baseline (both full years): jan baseline = 1100.
	// With FullYearsOnly+Anomaly: 2002 excluded after anomaly step.
	// Result covers 2000–2001 only; both anomaly years present.
	store := &mockStore{data: map[string]StationRows{
		"qcf/FYO00000004": makeRows(
			2000, uniform(1000),
			2001, uniform(1200),
			2002, [12]int16{1300, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal, missVal},
		),
	}}

	resp, err := computeAggregate(store, nil, aggregateRequest{
		StationIDs:    []string{"FYO00000004"},
		Series:        "qcf",
		Anomaly:       true,
		FullYearsOnly: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Only 2000 and 2001 (24 months) should be present.
	if len(resp.Counts) != 24 {
		t.Fatalf("got %d month slots, want 24 (2000–2001 only)", len(resp.Counts))
	}
	// All 24 months should have count=1.
	for m := 0; m < 24; m++ {
		if resp.Counts[m] != 1 {
			t.Errorf("month slot %d count = %d, want 1", m, resp.Counts[m])
		}
	}
	// 2000-Jan anomaly = 1000 - 1100 = -100 centideg = -1 °C.
	if got, want := resp.Averages[0], -1.0; math.Abs(got-want) > 1e-9 {
		t.Errorf("2000-Jan anomaly = %v, want %v", got, want)
	}
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

// newTestHandler builds a handler wired to a mockStore with a fixed dataset.
func newTestHandler() http.HandlerFunc {
	store := &mockStore{data: map[string]StationRows{
		"qcf/TST00000001": makeRows(2000, uniform(1000)),
		"qcu/TST00000001": makeRows(2000, uniform(500)),
	}}
	meta := map[string]StationMeta{"TST00000001": {Lat: 10}}
	// Use a disabled LRU cache and no pre-computed cache in tests.
	return newAggregateHandler(store, meta, newPrecomputedCache(nil, store, meta), newLRUCache(0), newCalcQueue(1, 45))
}

func postJSON(t *testing.T, handler http.Handler, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func TestAggregateHandler_success_qcf(t *testing.T) {
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: []string{"TST00000001"},
		Series:     "qcf",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var resp aggregateResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Start != "2000-01" {
		t.Errorf("Start = %q, want 2000-01", resp.Start)
	}
	if len(resp.Counts) != 12 || len(resp.Averages) != 12 || len(resp.StdDevs) != 12 {
		t.Errorf("expected 12-element arrays, got counts=%d avgs=%d devs=%d",
			len(resp.Counts), len(resp.Averages), len(resp.StdDevs))
	}
}

func TestAggregateHandler_success_qcu(t *testing.T) {
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: []string{"TST00000001"},
		Series:     "qcu",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

func TestAggregateHandler_methodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/aggregate", nil)
	w := httptest.NewRecorder()
	newTestHandler().ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", w.Code)
	}
}

func TestAggregateHandler_invalidJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewBufferString("not json"))
	w := httptest.NewRecorder()
	newTestHandler().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestAggregateHandler_invalidSeries(t *testing.T) {
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: []string{"TST00000001"},
		Series:     "tob",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestAggregateHandler_emptyStationList(t *testing.T) {
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: []string{},
		Series:     "qcf",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestAggregateHandler_tooManyStations(t *testing.T) {
	ids := make([]string, 50001)
	for i := range ids {
		ids[i] = "AAA00000001"
	}
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: ids,
		Series:     "qcf",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for >50000 IDs", w.Code)
	}
}

func TestAggregateHandler_invalidStationID(t *testing.T) {
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: []string{"../etc/passwd"},
		Series:     "qcf",
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestAggregateHandler_responseContentType(t *testing.T) {
	w := postJSON(t, newTestHandler(), aggregateRequest{
		StationIDs: []string{"TST00000001"},
		Series:     "qcf",
	})
	ct := w.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

// ── CORS middleware ───────────────────────────────────────────────────────────

func dummyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func corsRequest(handler http.Handler, origin, method string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/v1/aggregate", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	return w
}

func TestCORSMiddleware_prodOrigins(t *testing.T) {
	handler := corsMiddleware(true)(dummyHandler())
	for _, origin := range []string{"https://www.klymot.com", "https://klymot.com"} {
		w := corsRequest(handler, origin, http.MethodGet)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("origin %q: ACAO = %q, want %q", origin, got, origin)
		}
	}
}

func TestCORSMiddleware_unknownOriginInProd(t *testing.T) {
	handler := corsMiddleware(true)(dummyHandler())
	w := corsRequest(handler, "https://evil.example.com", http.MethodGet)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("unexpected ACAO header for unknown origin: %q", got)
	}
}

func TestCORSMiddleware_localhostAllowedInDev(t *testing.T) {
	handler := corsMiddleware(false)(dummyHandler())
	for _, origin := range []string{"http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:8080"} {
		w := corsRequest(handler, origin, http.MethodGet)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("dev mode: origin %q: ACAO = %q, want %q", origin, got, origin)
		}
	}
}

func TestCORSMiddleware_localhostBlockedInProd(t *testing.T) {
	handler := corsMiddleware(true)(dummyHandler())
	w := corsRequest(handler, "http://localhost:5173", http.MethodGet)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("prod mode: localhost should be blocked, got ACAO = %q", got)
	}
}

func TestCORSMiddleware_preflight(t *testing.T) {
	handler := corsMiddleware(false)(dummyHandler())
	w := corsRequest(handler, "https://www.klymot.com", http.MethodOptions)
	if w.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Error("preflight missing Access-Control-Allow-Methods header")
	}
}

func TestCORSMiddleware_noOriginHeader(t *testing.T) {
	handler := corsMiddleware(false)(dummyHandler())
	w := corsRequest(handler, "", http.MethodGet)
	// No Origin header → no CORS headers in response (same-origin request or server-to-server).
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("no-origin request: unexpected ACAO = %q", got)
	}
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}
