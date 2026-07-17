package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestStatsHandlerSegregatesLabsFeatures(t *testing.T) {
	today := time.Now().UTC().Format("2006-01-02")
	tracker := &usageTracker{
		counts: map[usageKey]int64{
			{Date: today, Path: "/__feature__/station-detail", Country: "US", Browser: "Chrome", OS: "macOS"}: 50,
		},
		uniques: map[string]int64{today: 3},
		labsHourly: map[string]int64{
			today + "\t12\tlabs/network-altitude/01-visited":         10,
			today + "\t12\tlabs/network-altitude/02-prediction-made": 5,
			today + "\t12\tlabs/sunshine-temperature/01-visited":     2,
			today + "\t12\tlabs/sunshine-temperature/03-unlocked":    1,
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/usage/stats", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	w := httptest.NewRecorder()
	tracker.statsHandler("test-secret")(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp StatsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	siteKeys := map[string]int64{}
	for _, kv := range resp.ByFeature {
		if kv.Key == "" {
			t.Fatal("empty site feature key")
		}
		if len(kv.Key) >= 5 && kv.Key[:5] == "labs/" {
			t.Fatalf("labs key leaked into by_feature: %q", kv.Key)
		}
		siteKeys[kv.Key] = kv.Value
	}
	if siteKeys["station-detail"] != 50 {
		t.Fatalf("station-detail = %d, want 50", siteKeys["station-detail"])
	}

	labsKeys := map[string]int64{}
	for _, kv := range resp.ByLabsFeature {
		labsKeys[kv.Key] = kv.Value
	}
	wantLabs := map[string]int64{
		"labs/network-altitude/01-visited":         10,
		"labs/network-altitude/02-prediction-made": 5,
		"labs/sunshine-temperature/01-visited":     2,
		"labs/sunshine-temperature/03-unlocked":    1,
	}
	for key, want := range wantLabs {
		if got := labsKeys[key]; got != want {
			t.Fatalf("%s = %d, want %d", key, got, want)
		}
	}
}

func TestUsageTrackerHourlyRoundTrip(t *testing.T) {
	dataFile := t.TempDir() + "/usage.json"

	tr := newUsageTracker(dataFile, "")
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	hour := now.Hour()

	tr.record("/some/page", "Chrome", "macOS", "US", date, hour, "hash1", "direct", "", "", "", now.Unix())
	tr.record("/__feature__/labs/test-lab/01-visited", "Chrome", "macOS", "US", date, hour, "hash1", "direct", "", "", "", now.Unix())
	tr.flushToDisk()

	tr2 := newUsageTracker(dataFile, "")

	wantHourlyKey := date + "\t" + strconv.Itoa(hour)
	if got := tr2.hourly[wantHourlyKey]; got != 1 {
		t.Fatalf("hourly[%q] = %d, want 1", wantHourlyKey, got)
	}
	wantLabsHourlyKey := date + "\t" + strconv.Itoa(hour) + "\tlabs/test-lab/01-visited"
	if got := tr2.labsHourly[wantLabsHourlyKey]; got != 1 {
		t.Fatalf("labsHourly[%q] = %d, want 1", wantLabsHourlyKey, got)
	}
	wantLabSessionKey := date + "\thash1\ttest-lab"
	if _, ok := tr2.labSessions[wantLabSessionKey]; !ok {
		t.Fatalf("labSessions missing key %q (have %v)", wantLabSessionKey, tr2.labSessions)
	}
}

func TestStatsHandlerHeatmap(t *testing.T) {
	now := time.Now().UTC()
	testDate := now.AddDate(0, 0, -5) // within the 90d window regardless of when the test runs
	dateStr := testDate.Format("2006-01-02")
	wantWeekday := int(testDate.Weekday())
	const wantHour = 10

	tracker := &usageTracker{
		hourly: map[string]int64{
			dateStr + "\t" + strconv.Itoa(wantHour): 42,
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/usage/stats", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	w := httptest.NewRecorder()
	tracker.statsHandler("test-secret")(w, req)

	var resp StatsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	var found bool
	for _, hp := range resp.ByHour {
		if hp.Weekday == wantWeekday && hp.Hour == wantHour {
			found = true
			if hp.Views != 42 {
				t.Fatalf("views = %d, want 42", hp.Views)
			}
		}
	}
	if !found {
		t.Fatalf("no heatmap point for weekday=%d hour=%d; got %+v", wantWeekday, wantHour, resp.ByHour)
	}
}

func TestStatsHandlerLabsWindow(t *testing.T) {
	now := time.Now().UTC()
	mk := func(agoHours int) (string, string) {
		ts := now.Add(-time.Duration(agoHours) * time.Hour)
		return ts.Format("2006-01-02"), strconv.Itoa(ts.Hour())
	}

	d1, h1 := mk(1)    // ~1 hour ago
	d2, h2 := mk(50)   // ~2 days ago
	d3, h3 := mk(240)  // 10 days ago
	d4, h4 := mk(960)  // 40 days ago
	d5, h5 := mk(2400) // 100 days ago

	labsHourly := map[string]int64{
		d1 + "\t" + h1 + "\tlabs/test-lab/01-step": 1,
		d2 + "\t" + h2 + "\tlabs/test-lab/01-step": 2,
		d3 + "\t" + h3 + "\tlabs/test-lab/01-step": 4,
		d4 + "\t" + h4 + "\tlabs/test-lab/01-step": 8,
		d5 + "\t" + h5 + "\tlabs/test-lab/01-step": 16,
	}

	cases := []struct {
		window string
		want   int64
	}{
		{"24h", 1},
		{"7d", 3},
		{"30d", 7},
		{"90d", 15},
		{"", 15},      // missing param defaults to 90d
		{"bogus", 15}, // invalid param also defaults to 90d
	}

	for _, tc := range cases {
		tracker := &usageTracker{labsHourly: labsHourly}
		url := "/api/v1/usage/stats"
		if tc.window != "" {
			url += "?labs_window=" + tc.window
		}
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", "Bearer test-secret")
		w := httptest.NewRecorder()
		tracker.statsHandler("test-secret")(w, req)

		var resp StatsResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("window=%q: decode response: %v", tc.window, err)
		}
		var got int64
		for _, kv := range resp.ByLabsFeature {
			if kv.Key == "labs/test-lab/01-step" {
				got = kv.Value
			}
		}
		if got != tc.want {
			t.Fatalf("window=%q: labs total = %d, want %d", tc.window, got, tc.want)
		}
		wantEcho := tc.window
		if wantEcho == "" || wantEcho == "bogus" {
			wantEcho = "90d"
		}
		if resp.LabsWindow != wantEcho {
			t.Fatalf("window=%q: LabsWindow = %q, want %q", tc.window, resp.LabsWindow, wantEcho)
		}
	}
}

func TestStatsHandlerByLabTime(t *testing.T) {
	today := time.Now().UTC().Format("2006-01-02")
	oldDate := time.Now().UTC().AddDate(0, 0, -100).Format("2006-01-02")

	tracker := &usageTracker{
		labSessions: map[string]visitorSession{
			today + "\thash1\ttest-lab":   {LastEvent: 1000, SegmentStart: 940},  // totalSecs = 60+120 = 180s = 3min
			today + "\thash2\ttest-lab":   {LastEvent: 2000, SegmentStart: 1880}, // totalSecs = 120+120 = 240s = 4min
			oldDate + "\thash3\ttest-lab": {LastEvent: 500, SegmentStart: 500},   // outside the default 90d window
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/usage/stats", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	w := httptest.NewRecorder()
	tracker.statsHandler("test-secret")(w, req)

	var resp StatsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	var found *LabTimePoint
	for i := range resp.ByLabTime {
		if resp.ByLabTime[i].Slug == "test-lab" {
			found = &resp.ByLabTime[i]
		}
	}
	if found == nil {
		t.Fatalf("no by_lab_time entry for test-lab; got %+v", resp.ByLabTime)
	}
	if found.Sessions != 2 {
		t.Fatalf("sessions = %d, want 2 (the 100-day-old session should be excluded)", found.Sessions)
	}
	const wantAvgMins = 3.5
	if diff := found.AvgMins - wantAvgMins; diff < -0.01 || diff > 0.01 {
		t.Fatalf("avg_mins = %v, want %v", found.AvgMins, wantAvgMins)
	}
}
