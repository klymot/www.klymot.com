package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestStatsHandlerSegregatesLabsFeatures(t *testing.T) {
	today := time.Now().UTC().Format("2006-01-02")
	tracker := &usageTracker{
		counts: map[usageKey]int64{
			{Date: today, Path: "/__feature__/station-detail", Country: "US", Browser: "Chrome", OS: "macOS"}: 50,
			{Date: today, Path: "/__feature__/labs/network-altitude/01-visited", Country: "US", Browser: "Chrome", OS: "macOS"}: 10,
			{Date: today, Path: "/__feature__/labs/network-altitude/02-prediction-made", Country: "US", Browser: "Chrome", OS: "macOS"}: 5,
			{Date: today, Path: "/__feature__/labs/sunshine-temperature/01-visited", Country: "GB", Browser: "Safari", OS: "macOS"}: 2,
			{Date: today, Path: "/__feature__/labs/sunshine-temperature/03-unlocked", Country: "GB", Browser: "Safari", OS: "macOS"}: 1,
		},
		uniques: map[string]int64{today: 3},
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
		"labs/network-altitude/01-visited":        10,
		"labs/network-altitude/02-prediction-made": 5,
		"labs/sunshine-temperature/01-visited":    2,
		"labs/sunshine-temperature/03-unlocked":   1,
	}
	for key, want := range wantLabs {
		if got := labsKeys[key]; got != want {
			t.Fatalf("%s = %d, want %d", key, got, want)
		}
	}
}