package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/geoip2-golang"
)

// --- UA classification (ordered; Chrome must follow Edge/Opera) ---

var (
	reBotUA   = regexp.MustCompile(`(?i)bot|crawl|slurp|spider|facebookexternalhit|semrush|ahrefs|bytespider|headlesschrome`)
	reEdge    = regexp.MustCompile(`Edg/`)
	reOpera   = regexp.MustCompile(`OPR/`)
	reChrome  = regexp.MustCompile(`Chrome/`)
	reFirefox = regexp.MustCompile(`Firefox/`)
	reSafari  = regexp.MustCompile(`Safari/`)
)

func uaBrowser(ua string) string {
	if reBotUA.MatchString(ua) {
		return "Bot"
	}
	switch {
	case reEdge.MatchString(ua):
		return "Edge"
	case reOpera.MatchString(ua):
		return "Opera"
	case reChrome.MatchString(ua):
		return "Chrome"
	case reFirefox.MatchString(ua):
		return "Firefox"
	case reSafari.MatchString(ua):
		return "Safari"
	}
	return "Other"
}

func uaOS(ua string) string {
	switch {
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "iPhone"), strings.Contains(ua, "iPad"):
		return "iOS"
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "Macintosh"), strings.Contains(ua, "Mac OS"):
		return "macOS"
	case strings.Contains(ua, "Linux"):
		return "Linux"
	}
	return "Other"
}

// realIP extracts the client IP, respecting X-Forwarded-For from a trusted proxy.
func realIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func sanitizePath(p string) string {
	if p == "" || p[0] != '/' {
		p = "/"
	}
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if len(p) > 200 {
		p = p[:200]
	}
	return p
}

// --- Session tracking (2-minute inactivity window) ---

type visitorSession struct {
	ActiveSecs   int64 `json:"a"` // accumulated seconds from closed segments
	LastEvent    int64 `json:"l"` // Unix time of last event
	SegmentStart int64 `json:"s"` // Unix time of current segment start
}

func (vs *visitorSession) record(now int64) {
	const gapSecs = 120
	if vs.LastEvent == 0 {
		vs.SegmentStart = now
		vs.LastEvent = now
		return
	}
	if now < vs.LastEvent {
		return // ignore out-of-order events
	}
	if now-vs.LastEvent > gapSecs {
		vs.ActiveSecs += (vs.LastEvent - vs.SegmentStart) + gapSecs
		vs.SegmentStart = now
	}
	vs.LastEvent = now
}

func (vs *visitorSession) totalSecs() int64 {
	if vs.LastEvent == 0 {
		return 0
	}
	return vs.ActiveSecs + (vs.LastEvent - vs.SegmentStart) + 120
}

// --- Aggregation key: the grain at which we store page view counts ---

type usageKey struct {
	Date    string
	Path    string
	Country string
	Browser string
	OS      string
}

func (k usageKey) encode() string {
	return strings.Join([]string{k.Date, k.Path, k.Country, k.Browser, k.OS}, "\t")
}

func decodeKey(s string) (usageKey, bool) {
	p := strings.SplitN(s, "\t", 5)
	if len(p) != 5 {
		return usageKey{}, false
	}
	return usageKey{p[0], p[1], p[2], p[3], p[4]}, true
}

// --- Referrer / UTM helpers ---

// normalizeReferrer extracts the hostname from a referrer URL, stripping "www."
// and query strings. Returns "direct" for empty or unparseable values.
func normalizeReferrer(ref string) string {
	if ref == "" {
		return "direct"
	}
	u, err := url.Parse(ref)
	if err != nil || u.Host == "" {
		return "direct"
	}
	host := strings.ToLower(u.Hostname())
	host = strings.TrimPrefix(host, "www.")
	if len(host) > 100 {
		host = host[:100]
	}
	return host
}

func sanitizeUTM(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

// --- Disk format ---

type usageDisk struct {
	Counts    map[string]int64          `json:"counts"`
	Uniques   map[string]int64          `json:"uniques"`
	Sessions  map[string]visitorSession `json:"sessions,omitempty"` // "date\thash" -> session
	Referrers map[string]int64          `json:"referrers,omitempty"` // "date\thostname" -> count
	UTMs      map[string]int64          `json:"utms,omitempty"`      // "date\tsource\tmedium\tcampaign" -> count
}

// --- Tracker ---

type usageTracker struct {
	mu        sync.Mutex
	counts    map[usageKey]int64
	uniques   map[string]int64           // date -> unique count (persisted)
	seen      map[string]map[string]bool // date -> daily-hash set (memory only, for dedup)
	sessions  map[string]visitorSession  // "date\thash" -> session (persisted)
	referrers map[string]int64           // "date\thostname" -> count (persisted)
	utms      map[string]int64           // "date\tsource\tmedium\tcampaign" -> count (persisted)
	salt      []byte
	saltDate  string
	dataFile  string
	geoDB     *geoip2.Reader // nil when geoip disabled
}

func newUsageTracker(dataFile, geoDBPath string) *usageTracker {
	t := &usageTracker{
		counts:    make(map[usageKey]int64),
		uniques:   make(map[string]int64),
		seen:      make(map[string]map[string]bool),
		sessions:  make(map[string]visitorSession),
		referrers: make(map[string]int64),
		utms:      make(map[string]int64),
		dataFile:  dataFile,
	}

	if geoDBPath != "" {
		db, err := geoip2.Open(geoDBPath)
		if err != nil {
			log.Printf("usage: geoip db %s: %v — country tracking disabled", geoDBPath, err)
		} else {
			t.geoDB = db
			log.Printf("usage: geoip database loaded (%s)", geoDBPath)
		}
	}

	if dataFile != "" {
		if err := t.loadFromDisk(); err != nil && !os.IsNotExist(err) {
			log.Printf("usage: load %s: %v", dataFile, err)
		} else if err == nil {
			log.Printf("usage: loaded persisted data from %s", dataFile)
		}
	}

	return t
}

func (t *usageTracker) loadFromDisk() error {
	raw, err := os.ReadFile(t.dataFile)
	if err != nil {
		return err
	}
	var d usageDisk
	if err := json.Unmarshal(raw, &d); err != nil {
		return err
	}
	for enc, v := range d.Counts {
		if k, ok := decodeKey(enc); ok {
			t.counts[k] = v
		}
	}
	for date, v := range d.Uniques {
		t.uniques[date] = v
	}
	for k, v := range d.Sessions {
		t.sessions[k] = v
	}
	for k, v := range d.Referrers {
		t.referrers[k] = v
	}
	for k, v := range d.UTMs {
		t.utms[k] = v
	}
	return nil
}

func (t *usageTracker) flushToDisk() {
	if t.dataFile == "" {
		return
	}
	t.mu.Lock()
	d := usageDisk{
		Counts:    make(map[string]int64, len(t.counts)),
		Uniques:   make(map[string]int64, len(t.uniques)),
		Sessions:  make(map[string]visitorSession, len(t.sessions)),
		Referrers: make(map[string]int64, len(t.referrers)),
		UTMs:      make(map[string]int64, len(t.utms)),
	}
	for k, v := range t.counts {
		d.Counts[k.encode()] = v
	}
	for date, v := range t.uniques {
		d.Uniques[date] = v
	}
	for k, v := range t.sessions {
		d.Sessions[k] = v
	}
	for k, v := range t.referrers {
		d.Referrers[k] = v
	}
	for k, v := range t.utms {
		d.UTMs[k] = v
	}
	t.mu.Unlock()

	b, err := json.Marshal(d)
	if err != nil {
		log.Printf("usage: marshal: %v", err)
		return
	}
	tmp := t.dataFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		log.Printf("usage: write tmp: %v", err)
		return
	}
	if err := os.Rename(tmp, t.dataFile); err != nil {
		log.Printf("usage: rename: %v", err)
	}
}

func (t *usageTracker) startFlusher(ctx context.Context) {
	go func() {
		tick := time.NewTicker(5 * time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				t.flushToDisk()
			case <-ctx.Done():
				t.flushToDisk()
				return
			}
		}
	}()
}

func (t *usageTracker) dailySalt(date string) []byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.saltDate != date {
		salt := make([]byte, 16)
		if _, err := rand.Read(salt); err != nil {
			// fall back to deterministic salt so we don't panic
			h := sha256.Sum256([]byte("klymot-usage-fallback-" + date))
			copy(salt, h[:16])
		}
		t.salt = salt
		t.saltDate = date
	}
	return append([]byte(nil), t.salt...)
}

// visitorHash produces a daily-rotating opaque hash for unique-visitor dedup.
// The salt changes each day, making cross-day tracking impossible.
func (t *usageTracker) visitorHash(ip, browser, date string) string {
	salt := t.dailySalt(date)
	mac := hmac.New(sha256.New, salt)
	mac.Write([]byte(ip + "|" + browser))
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

func (t *usageTracker) lookupCountry(ipStr string) string {
	if t.geoDB == nil {
		return "ZZ"
	}
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return "ZZ"
	}
	rec, err := t.geoDB.Country(ip)
	if err != nil || rec.Country.IsoCode == "" {
		return "ZZ"
	}
	return rec.Country.IsoCode
}

func (t *usageTracker) record(path, browser, os, country, date, hash, referrer, utmSource, utmMedium, utmCampaign string, nowUnix int64) {
	key := usageKey{Date: date, Path: path, Country: country, Browser: browser, OS: os}
	t.mu.Lock()
	defer t.mu.Unlock()

	t.counts[key]++

	if t.seen[date] == nil {
		t.seen[date] = make(map[string]bool)
	}
	if !t.seen[date][hash] {
		t.seen[date][hash] = true
		t.uniques[date]++
	}

	sessionKey := date + "\t" + hash
	sess := t.sessions[sessionKey]
	sess.record(nowUnix)
	t.sessions[sessionKey] = sess

	// Only record referrer/UTM for real page views, not synthetic feature beacons.
	if !strings.HasPrefix(path, "/__") {
		t.referrers[date+"\t"+referrer]++
		if utmSource != "" || utmMedium != "" || utmCampaign != "" {
			t.utms[date+"\t"+utmSource+"\t"+utmMedium+"\t"+utmCampaign]++
		}
	}
}

// beaconHandler handles POST /api/v1/usage.
func (t *usageTracker) beaconHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Path        string `json:"path"`
		Referrer    string `json:"referrer"`
		UTMSource   string `json:"utm_source"`
		UTMMedium   string `json:"utm_medium"`
		UTMCampaign string `json:"utm_campaign"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ua := r.Header.Get("User-Agent")
	browser := uaBrowser(ua)
	if browser == "Bot" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	os := uaOS(ua)
	ip := realIP(r)
	path := sanitizePath(body.Path)
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	country := t.lookupCountry(ip)
	hash := t.visitorHash(ip, browser, date)
	referrer := normalizeReferrer(body.Referrer)
	utmSource := sanitizeUTM(body.UTMSource)
	utmMedium := sanitizeUTM(body.UTMMedium)
	utmCampaign := sanitizeUTM(body.UTMCampaign)

	t.record(path, browser, os, country, date, hash, referrer, utmSource, utmMedium, utmCampaign, now.Unix())
	w.WriteHeader(http.StatusNoContent)
}

// --- Stats endpoint ---

type KV struct {
	Key   string `json:"key"`
	Value int64  `json:"value"`
}

type DatePoint struct {
	Date    string `json:"date"`
	Views   int64  `json:"views"`
	Uniques int64  `json:"uniques"`
}

type SessionPoint struct {
	Date      string  `json:"date"`
	Visitors  int     `json:"visitors"`
	AvgMins   float64 `json:"avg_mins"`
	TotalMins float64 `json:"total_mins"`
}

type StatsResponse struct {
	GeneratedAt string `json:"generated_at"`
	Totals      struct {
		Views   int64 `json:"views"`
		Uniques int64 `json:"uniques"`
	} `json:"totals"`
	ByDate        []DatePoint    `json:"by_date"`
	ByCountry     []KV           `json:"by_country"`
	ByBrowser     []KV           `json:"by_browser"`
	ByOS          []KV           `json:"by_os"`
	ByFeature     []KV           `json:"by_feature"`      // main-site /__feature__/* only (top 30)
	ByLabsFeature []KV           `json:"by_labs_feature"` // labs /__feature__/labs/* only (all steps)
	ByConsent     []KV           `json:"by_consent"`      // /__consent__/* beacons
	BySession     []SessionPoint `json:"by_session"`      // daily active-time breakdown
	ByReferrer    []KV           `json:"by_referrer"`     // top referrer hostnames (30d)
	ByUTMSource   []KV           `json:"by_utm_source"`   // top utm_source+medium combos (30d)
	ByUTMCampaign []KV           `json:"by_utm_campaign"` // top utm_campaign values (30d)
}

func (t *usageTracker) statsHandler(password string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if r.Header.Get("Authorization") != "Bearer "+password {
			w.Header().Set("WWW-Authenticate", `Bearer realm="klymot admin"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Snapshot under lock, then compute without holding the lock.
		t.mu.Lock()
		countsCopy := make(map[usageKey]int64, len(t.counts))
		for k, v := range t.counts {
			countsCopy[k] = v
		}
		uniquesCopy := make(map[string]int64, len(t.uniques))
		for k, v := range t.uniques {
			uniquesCopy[k] = v
		}
		sessionsCopy := make(map[string]visitorSession, len(t.sessions))
		for k, v := range t.sessions {
			sessionsCopy[k] = v
		}
		referrersCopy := make(map[string]int64, len(t.referrers))
		for k, v := range t.referrers {
			referrersCopy[k] = v
		}
		utmsCopy := make(map[string]int64, len(t.utms))
		for k, v := range t.utms {
			utmsCopy[k] = v
		}
		t.mu.Unlock()

		// Aggregate over the last 90 days.
		// Synthetic paths (/__feature__/*, /__consent__/*) are bucketed separately
		// so they don't inflate real page-view totals.
		cutoff := time.Now().UTC().AddDate(0, 0, -90).Format("2006-01-02")
		countries := make(map[string]int64)
		browsers := make(map[string]int64)
		oses := make(map[string]int64)
		dateViews := make(map[string]int64)
		siteFeatures := make(map[string]int64)
		labsFeatures := make(map[string]int64)
		consent := make(map[string]int64)
		var totalViews int64

		for k, v := range countsCopy {
			if k.Date < cutoff {
				continue
			}
			if strings.HasPrefix(k.Path, "/__feature__/") {
				key := strings.TrimPrefix(k.Path, "/__feature__/")
				if strings.HasPrefix(key, "labs/") {
					labsFeatures[key] += v
				} else {
					siteFeatures[key] += v
				}
				continue
			}
			if strings.HasPrefix(k.Path, "/__consent__/") {
				consent[strings.TrimPrefix(k.Path, "/__consent__/")] += v
				continue
			}
			totalViews += v
			if k.Country != "ZZ" {
				countries[k.Country] += v
			}
			browsers[k.Browser] += v
			oses[k.OS] += v
			dateViews[k.Date] += v
		}

		var totalUniques int64
		for _, v := range uniquesCopy {
			totalUniques += v
		}

		// Last 30 days time series.
		dates := make([]DatePoint, 30)
		for i := 29; i >= 0; i-- {
			d := time.Now().UTC().AddDate(0, 0, -i).Format("2006-01-02")
			dates[29-i] = DatePoint{
				Date:    d,
				Views:   dateViews[d],
				Uniques: uniquesCopy[d],
			}
		}

		// Session aggregation — all available dates (not limited to 90d window).
		dateActiveSecs := make(map[string]int64)
		dateSessCount := make(map[string]int)
		for key, sess := range sessionsCopy {
			parts := strings.SplitN(key, "\t", 2)
			if len(parts) != 2 {
				continue
			}
			dateActiveSecs[parts[0]] += sess.totalSecs()
			dateSessCount[parts[0]]++
		}
		var bySessions []SessionPoint
		for date, totalSecs := range dateActiveSecs {
			count := dateSessCount[date]
			bySessions = append(bySessions, SessionPoint{
				Date:      date,
				Visitors:  count,
				AvgMins:   float64(totalSecs) / float64(count) / 60.0,
				TotalMins: float64(totalSecs) / 60.0,
			})
		}
		sort.Slice(bySessions, func(i, j int) bool { return bySessions[i].Date < bySessions[j].Date })

		// Referrer and UTM aggregation — last 30 days only.
		cutoff30 := time.Now().UTC().AddDate(0, 0, -30).Format("2006-01-02")
		referrerTotals := make(map[string]int64)
		utmSourceTotals := make(map[string]int64)
		utmCampaignTotals := make(map[string]int64)

		for k, v := range referrersCopy {
			parts := strings.SplitN(k, "\t", 2)
			if len(parts) != 2 || parts[0] < cutoff30 {
				continue
			}
			referrerTotals[parts[1]] += v
		}
		for k, v := range utmsCopy {
			parts := strings.SplitN(k, "\t", 4)
			if len(parts) != 4 || parts[0] < cutoff30 {
				continue
			}
			src, med, camp := parts[1], parts[2], parts[3]
			if src != "" || med != "" {
				label := src
				if med != "" {
					label += " / " + med
				}
				utmSourceTotals[label] += v
			}
			if camp != "" {
				utmCampaignTotals[camp] += v
			}
		}

		var resp StatsResponse
		resp.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
		resp.Totals.Views = totalViews
		resp.Totals.Uniques = totalUniques
		resp.ByDate = dates
		resp.ByCountry = topN(countries, 30)
		resp.ByBrowser = topN(browsers, 10)
		resp.ByOS = topN(oses, 10)
		resp.ByFeature = topN(siteFeatures, 30)
		resp.ByLabsFeature = sortedKV(labsFeatures)
		resp.ByConsent = topN(consent, 10)
		resp.BySession = bySessions
		resp.ByReferrer = topN(referrerTotals, 10)
		resp.ByUTMSource = topN(utmSourceTotals, 10)
		resp.ByUTMCampaign = topN(utmCampaignTotals, 10)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	}
}

func topN(m map[string]int64, n int) []KV {
	kvs := sortedKV(m)
	if n > 0 && len(kvs) > n {
		kvs = kvs[:n]
	}
	return kvs
}

func sortedKV(m map[string]int64) []KV {
	kvs := make([]KV, 0, len(m))
	for k, v := range m {
		kvs = append(kvs, KV{k, v})
	}
	sort.Slice(kvs, func(i, j int) bool { return kvs[i].Value > kvs[j].Value })
	return kvs
}
