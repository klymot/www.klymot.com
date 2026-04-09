package main

import (
	"encoding/json"
	"hash/fnv"
	"log"
	"sort"
	"sync"
)

// ── Fingerprinting ────────────────────────────────────────────────────────────

// stationSetFingerprint returns an FNV-1a hash of the station IDs sorted
// lexicographically, so request order does not affect the key.
func stationSetFingerprint(ids []string) uint64 {
	sorted := make([]string, len(ids))
	copy(sorted, ids)
	sort.Strings(sorted)
	h := fnv.New64a()
	for _, id := range sorted {
		h.Write([]byte(id))
		h.Write([]byte{0}) // null separator prevents "ab","c" ≡ "a","bc"
	}
	return h.Sum64()
}

// requestFingerprint hashes all fields of an aggregateRequest into a uint64
// suitable for use as an LRU cache key.  Station IDs are sorted before
// hashing so request order does not matter.
func requestFingerprint(req aggregateRequest) uint64 {
	h := fnv.New64a()
	h.Write([]byte(req.Series))
	flags := [3]byte{}
	if req.GeoGridded {
		flags[0] = 1
	}
	if req.Anomaly {
		flags[1] = 1
	}
	if req.FullYearsOnly {
		flags[2] = 1
	}
	h.Write(flags[:])
	// Mix in the station-set hash as 8 big-endian bytes.
	sh := stationSetFingerprint(req.StationIDs)
	h.Write([]byte{
		byte(sh >> 56), byte(sh >> 48), byte(sh >> 40), byte(sh >> 32),
		byte(sh >> 24), byte(sh >> 16), byte(sh >> 8), byte(sh),
	})
	return h.Sum64()
}

// ── Pre-computed all-station cache ────────────────────────────────────────────

type precomputedKey struct {
	series     string
	anomaly    bool
	geoGridded bool
}

type precomputedEntry struct {
	once sync.Once
	fn   func() []byte // set once before any goroutine calls once.Do
	data []byte        // written inside once.Do, safe to read after
}

func (e *precomputedEntry) compute() []byte {
	e.once.Do(func() { e.data = e.fn() })
	return e.data
}

// precomputedCache holds 8 always-available all-station aggregations
// (2 series × 2 anomaly × 2 geo_gridded), computed with full_years_only=false.
// Entries are never evicted.  A request that arrives before background
// computation finishes will block in compute() until the result is ready.
type precomputedCache struct {
	allCount int
	allHash  uint64 // FNV-1a hash of sorted station IDs
	entries  map[precomputedKey]*precomputedEntry
}

// newPrecomputedCache creates the cache and wires up a compute function for
// each of the 8 key combinations.  Call startPrecomputation() to kick off
// background goroutines; requests that arrive first will compute on demand.
func newPrecomputedCache(allIDs []string, store DataStore, meta map[string]StationMeta) *precomputedCache {
	entries := make(map[precomputedKey]*precomputedEntry, 8)
	for _, series := range []string{"qcf", "qcu"} {
		for _, anomaly := range []bool{false, true} {
			for _, geo := range []bool{false, true} {
				series, anomaly, geo := series, anomaly, geo
				key := precomputedKey{series, anomaly, geo}
				req := aggregateRequest{
					StationIDs: allIDs,
					Series:     series,
					Anomaly:    anomaly,
					GeoGridded: geo,
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
					log.Printf("pre-computed: series=%s anomaly=%v geo_gridded=%v (%dB)",
						key.series, key.anomaly, key.geoGridded, len(data))
					return data
				}
				entries[key] = e
			}
		}
	}
	return &precomputedCache{
		allCount: len(allIDs),
		allHash:  stationSetFingerprint(allIDs),
		entries:  entries,
	}
}

// startPrecomputation launches a single background goroutine that computes
// all entries serially.  Running them in parallel would exhaust RAM on
// memory-constrained servers (each all-station anomaly pass allocates ~600 MB).
// Any request that arrives before its entry is ready will block in compute()
// and either wait for the background goroutine or do the work itself via
// sync.Once — whichever wins the race.
func (c *precomputedCache) startPrecomputation() {
	go func() {
		for _, e := range c.entries {
			e.compute()
		}
	}()
}

// get returns the cached JSON bytes for req if it targets the full station
// set with full_years_only=false, blocking until the entry is ready.
// Returns nil, false when the request does not match the pre-computed set.
func (c *precomputedCache) get(req aggregateRequest) ([]byte, bool) {
	if req.FullYearsOnly {
		return nil, false
	}
	if len(req.StationIDs) != c.allCount {
		return nil, false
	}
	if stationSetFingerprint(req.StationIDs) != c.allHash {
		return nil, false
	}
	key := precomputedKey{req.Series, req.Anomaly, req.GeoGridded}
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	data := e.compute() // blocks until ready
	if data == nil {
		return nil, false // computation failed; fall through to live compute
	}
	return data, true
}

// ── LRU response cache ────────────────────────────────────────────────────────

type lruItem struct {
	key        uint64
	data       []byte
	prev, next *lruItem
}

// lruCache is a size-bounded, thread-safe LRU cache for JSON-encoded aggregate
// responses.  maxBytes <= 0 disables the cache entirely.
type lruCache struct {
	maxBytes int64
	mu       sync.Mutex
	curBytes int64
	items    map[uint64]*lruItem
	head     *lruItem // most recently used
	tail     *lruItem // least recently used
}

func newLRUCache(maxBytes int64) *lruCache {
	return &lruCache{
		maxBytes: maxBytes,
		items:    make(map[uint64]*lruItem),
	}
}

func (c *lruCache) get(key uint64) ([]byte, bool) {
	if c.maxBytes <= 0 {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[key]
	if !ok {
		return nil, false
	}
	c.moveToFront(item)
	return item.data, true
}

func (c *lruCache) put(key uint64, data []byte) {
	if c.maxBytes <= 0 || int64(len(data)) > c.maxBytes {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if item, ok := c.items[key]; ok {
		c.curBytes += int64(len(data)) - int64(len(item.data))
		item.data = data
		c.moveToFront(item)
	} else {
		item := &lruItem{key: key, data: data}
		c.items[key] = item
		c.curBytes += int64(len(data))
		c.pushFront(item)
	}
	for c.curBytes > c.maxBytes && c.tail != nil {
		c.evict(c.tail)
	}
}

func (c *lruCache) pushFront(item *lruItem) {
	item.prev = nil
	item.next = c.head
	if c.head != nil {
		c.head.prev = item
	}
	c.head = item
	if c.tail == nil {
		c.tail = item
	}
}

func (c *lruCache) moveToFront(item *lruItem) {
	if item == c.head {
		return
	}
	if item.prev != nil {
		item.prev.next = item.next
	}
	if item.next != nil {
		item.next.prev = item.prev
	}
	if item == c.tail {
		c.tail = item.prev
	}
	item.prev = nil
	item.next = c.head
	if c.head != nil {
		c.head.prev = item
	}
	c.head = item
}

func (c *lruCache) evict(item *lruItem) {
	delete(c.items, item.key)
	c.curBytes -= int64(len(item.data))
	if item.prev != nil {
		item.prev.next = item.next
	} else {
		c.head = item.next
	}
	if item.next != nil {
		item.next.prev = item.prev
	} else {
		c.tail = item.prev
	}
}
