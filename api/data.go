package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// missVal is the sentinel for missing monthly data.
// GHCN centidegree values are always in [-9999, 9999], so math.MaxInt16 (32767)
// is safely outside the valid range and fits in int16.
const missVal int16 = 0x7fff

// MonthRow holds the 12 monthly temperature values in centidegrees (°C × 100).
// missVal indicates a missing observation.
type MonthRow [12]int16

// StationRows maps year -> MonthRow for one station's data.
type StationRows map[int]MonthRow

// StationMeta holds the geographic coordinates for a station, used for
// geo-gridded (cosine-latitude-weighted) aggregation.
type StationMeta struct {
	Lat float64
	Lng float64
}

// loadStationMeta reads index.json and returns a map from station ID to metadata.
func loadStationMeta(path string) (map[string]StationMeta, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	var index struct {
		Locations []struct {
			ID  string  `json:"id"`
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"locations"`
	}
	if err := json.NewDecoder(f).Decode(&index); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	meta := make(map[string]StationMeta, len(index.Locations))
	for _, loc := range index.Locations {
		meta[loc.ID] = StationMeta{Lat: loc.Lat, Lng: loc.Lng}
	}
	return meta, nil
}

// DataStore loads monthly data for a station from a named series (qcf or qcu).
// Returns nil, nil when the station file does not exist.
type DataStore interface {
	Load(series, stationID string) (StationRows, error)
}

// newDataStore creates a DataStore using the requested caching strategy:
//
//   - "none"   — read and parse the CSV on every request; no caching
//   - "mmap"   — mmap each file on first access, cache the raw bytes;
//     the OS controls which pages stay in RAM
//   - "memory" — parse every CSV file at start-up and keep the results
//     in memory; fastest per-request, highest RAM usage
func newDataStore(strategy, dataDir string) (DataStore, error) {
	switch strategy {
	case "none":
		return &noCacheStore{dataDir: dataDir}, nil
	case "mmap":
		return &mmapStore{dataDir: dataDir}, nil
	case "memory":
		return newMemoryStore(dataDir)
	default:
		return nil, fmt.Errorf("unknown cache strategy %q (valid: none, mmap, memory)", strategy)
	}
}

// csvPath constructs the path to a station CSV file.
// filepath.Base is applied to both user-supplied components so that directory
// traversal sequences (e.g. "../..") are stripped to their last element even
// if the upstream validation is somehow bypassed.
func csvPath(dataDir, series, stationID string) string {
	return filepath.Join(dataDir, filepath.Base(series), filepath.Base(stationID)+".csv")
}

// isValidSeries rejects any series name that is not one of the two known
// data series, preventing path traversal via the series parameter.
func isValidSeries(series string) bool {
	return series == "qcf" || series == "qcu"
}

// isValidStationID rejects any station ID that could enable path traversal.
// Valid IDs contain only ASCII letters, digits, and hyphens — the full set
// that appears in GHCN data (e.g. "USW00003822", "CA001012475-C").
func isValidStationID(id string) bool {
	if len(id) == 0 || len(id) > 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

// parseCSV parses the raw bytes of a GHCN monthly CSV file.
// Format: year,jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec  (no header)
// Values are integer centidegrees; empty fields indicate missing data.
func parseCSV(data []byte) (StationRows, error) {
	rows := make(StationRows)
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, ",", 14)
		if len(fields) < 13 {
			continue
		}
		year, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		var row MonthRow
		for i := 0; i < 12; i++ {
			s := strings.TrimSpace(fields[i+1])
			if s == "" {
				row[i] = missVal
				continue
			}
			v, err := strconv.ParseInt(s, 10, 16)
			if err != nil || v == -9999 {
				row[i] = missVal
			} else {
				row[i] = int16(v)
			}
		}
		rows[year] = row
	}
	return rows, scanner.Err()
}

// ── noCacheStore ──────────────────────────────────────────────────────────────

type noCacheStore struct{ dataDir string }

func (s *noCacheStore) Load(series, stationID string) (StationRows, error) {
	if !isValidSeries(series) || !isValidStationID(stationID) {
		return nil, nil
	}
	data, err := os.ReadFile(csvPath(s.dataDir, series, stationID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseCSV(data)
}

// ── mmapStore ─────────────────────────────────────────────────────────────────
// Lazily mmaps each file on first access and caches the raw bytes.
// Subsequent requests parse from the cached bytes without touching the disk.
// The OS controls physical page residency; pages for unused stations may be
// evicted under memory pressure and silently reloaded on next access.

type mmapStore struct {
	dataDir string
	mu      sync.Map // key: "series/stationID" → []byte (nil means not-found)
}

func (s *mmapStore) Load(series, stationID string) (StationRows, error) {
	if !isValidSeries(series) || !isValidStationID(stationID) {
		return nil, nil
	}
	key := series + "/" + stationID
	if v, ok := s.mu.Load(key); ok {
		if v == nil {
			return nil, nil // cached not-found
		}
		data := v.([]byte)
		if len(data) == 0 {
			return nil, nil
		}
		return parseCSV(data)
	}

	path := csvPath(s.dataDir, series, stationID)
	data, err := mmapFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		s.mu.Store(key, nil) // cache the miss
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.mu.Store(key, data)
	if len(data) == 0 {
		return nil, nil
	}
	return parseCSV(data)
}

// mmapFile maps the named file into memory and closes the file descriptor.
// The mapping persists after the fd is closed (POSIX-compliant behaviour on
// Linux and macOS).
func mmapFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := int(fi.Size())
	if size == 0 {
		return []byte{}, nil
	}

	data, err := syscall.Mmap(int(f.Fd()), 0, size, syscall.PROT_READ, syscall.MAP_SHARED)
	if err != nil {
		return nil, fmt.Errorf("mmap %s: %w", path, err)
	}
	return data, nil
}

// ── memoryStore ───────────────────────────────────────────────────────────────
// Parses every CSV file at start-up and holds the results in memory.
// Requests never touch the filesystem after initialisation.

type memoryStore struct {
	data map[string]StationRows // key: "series/stationID"
}

func newMemoryStore(dataDir string) (*memoryStore, error) {
	s := &memoryStore{data: make(map[string]StationRows)}
	for _, series := range []string{"qcf", "qcu"} {
		dir := filepath.Join(dataDir, series)
		entries, err := os.ReadDir(dir)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				log.Printf("warning: directory %s not found, skipping", dir)
				continue
			}
			return nil, fmt.Errorf("read dir %s: %w", dir, err)
		}
		loaded := 0
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".csv") {
				continue
			}
			stationID := strings.TrimSuffix(e.Name(), ".csv")
			raw, err := os.ReadFile(filepath.Join(dir, filepath.Base(e.Name())))
			if err != nil {
				log.Printf("warning: reading %s/%s: %v", series, e.Name(), err)
				continue
			}
			rows, err := parseCSV(raw)
			if err != nil {
				log.Printf("warning: parsing %s/%s: %v", series, e.Name(), err)
				continue
			}
			s.data[series+"/"+stationID] = rows
			loaded++
		}
		log.Printf("loaded %d %s stations into memory", loaded, series)
	}
	return s, nil
}

func (s *memoryStore) Load(series, stationID string) (StationRows, error) {
	rows, ok := s.data[series+"/"+stationID]
	if !ok {
		return nil, nil
	}
	return rows, nil
}
