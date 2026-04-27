package main

import (
	"testing"
)

// ── parseCSV ──────────────────────────────────────────────────────────────────

func TestParseCSV_basic(t *testing.T) {
	csv := "1980,1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,2000,2100\n"
	rows, err := parseCSV([]byte(csv))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	row, ok := rows[1980]
	if !ok {
		t.Fatal("expected row for 1980")
	}
	for i, want := range [12]int16{1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100} {
		if row[i] != want {
			t.Errorf("month %d: got %d, want %d", i, row[i], want)
		}
	}
}

func TestParseCSV_missingValues(t *testing.T) {
	// First and last months are missing.
	csv := "1990,,1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,\n"
	rows, err := parseCSV([]byte(csv))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	row := rows[1990]
	if row[0] != missVal {
		t.Errorf("month 0: got %d, want missVal", row[0])
	}
	if row[11] != missVal {
		t.Errorf("month 11: got %d, want missVal", row[11])
	}
	if row[1] != 1000 {
		t.Errorf("month 1: got %d, want 1000", row[1])
	}
}

func TestParseCSV_noaaFillValue(t *testing.T) {
	// -9999 is the raw NOAA missing-value sentinel; treat as missing.
	csv := "2000,-9999,500,600,700,800,900,1000,1100,1200,1300,1400,1500\n"
	rows, err := parseCSV([]byte(csv))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rows[2000][0] != missVal {
		t.Errorf("month 0: got %d, want missVal for -9999", rows[2000][0])
	}
}

func TestParseCSV_negativeValidValue(t *testing.T) {
	// Negative centidegrees are valid (sub-zero temperatures).
	csv := "1970,-500,-400,-300,200,800,1200,1500,1400,1000,400,-200,-450\n"
	rows, err := parseCSV([]byte(csv))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rows[1970][0] != -500 {
		t.Errorf("month 0: got %d, want -500", rows[1970][0])
	}
}

func TestParseCSV_multipleYears(t *testing.T) {
	csv := "2010,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000,1000\n" +
		"2011,2000,2000,2000,2000,2000,2000,2000,2000,2000,2000,2000,2000\n"
	rows, err := parseCSV([]byte(csv))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[2010][0] != 1000 {
		t.Errorf("2010 jan: got %d, want 1000", rows[2010][0])
	}
	if rows[2011][0] != 2000 {
		t.Errorf("2011 jan: got %d, want 2000", rows[2011][0])
	}
}

func TestParseCSV_emptyInput(t *testing.T) {
	rows, err := parseCSV([]byte(""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("got %d rows from empty input, want 0", len(rows))
	}
}

func TestParseCSV_blankLines(t *testing.T) {
	csv := "\n1985,500,500,500,500,500,500,500,500,500,500,500,500\n\n"
	rows, err := parseCSV([]byte(csv))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
}

// ── isValidStationID ──────────────────────────────────────────────────────────

func TestIsValidStationID(t *testing.T) {
	tests := []struct {
		id   string
		want bool
	}{
		{"USW00003822", true},
		{"ACW00011604", true},
		{"ASN00066062", true},
		{"", false},
		{"../etc/passwd", false},
		{"US W00003822", false},               // space
		{"USW00003822!", false},               // punctuation
		{"USW00003822.csv", false},            // dot
		{"CA001012475-C", true},               // hyphen is valid in GHCN IDs
		{"USW0000382200000000000000000000000000", false}, // too long
	}
	for _, tc := range tests {
		got := isValidStationID(tc.id)
		if got != tc.want {
			t.Errorf("isValidStationID(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
}
