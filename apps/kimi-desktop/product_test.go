package main

import (
	"reflect"
	"testing"
)

func TestParseProductArgs(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []any
	}{
		{name: "empty means no args", in: "", want: nil},
		{name: "blank means no args", in: "   \n\t", want: nil},
		{name: "empty array", in: "[]", want: []any{}},
		{name: "positional array passthrough", in: `[1,"a",{"k":true}]`, want: []any{
			float64(1), "a", map[string]any{"k": true},
		}},
		{name: "object wraps to one positional", in: `{"sessionId":"s1"}`, want: []any{
			map[string]any{"sessionId": "s1"},
		}},
		{name: "empty object wraps", in: "{}", want: []any{map[string]any{}}},
		{name: "leading whitespace tolerated", in: "  [1,2]", want: []any{float64(1), float64(2)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseProductArgs(tt.in)
			if err != nil {
				t.Fatalf("parseProductArgs(%q) unexpected error: %v", tt.in, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("parseProductArgs(%q) = %#v, want %#v", tt.in, got, tt.want)
			}
		})
	}
}

func TestParseProductArgsRejectsNonContainer(t *testing.T) {
	for _, in := range []string{`123`, `"foo"`, `true`, `[1,`, `{`, `nul`} {
		if got, err := parseProductArgs(in); err == nil {
			t.Fatalf("parseProductArgs(%q) = %#v, want error", in, got)
		}
	}
}

func TestParseProductCursor(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []any
	}{
		{name: "empty means no cursor", in: "", want: nil},
		{name: "blank means no cursor", in: "  \n\t", want: nil},
		{name: "empty object means no cursor", in: "{}", want: nil},
		{name: "cursor wraps to one positional arg", in: `{"epoch":"ep_1","after_seq":7}`, want: []any{
			map[string]any{"epoch": "ep_1", "after_seq": float64(7)},
		}},
		{name: "after_seq only", in: `{"after_seq":3}`, want: []any{
			map[string]any{"after_seq": float64(3)},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseProductCursor(tt.in)
			if err != nil {
				t.Fatalf("parseProductCursor(%q) unexpected error: %v", tt.in, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("parseProductCursor(%q) = %#v, want %#v", tt.in, got, tt.want)
			}
		})
	}
}

func TestParseProductCursorRejectsNonObject(t *testing.T) {
	for _, in := range []string{`[1,2]`, `123`, `"ep"`, `true`, `{`} {
		if got, err := parseProductCursor(in); err == nil {
			t.Fatalf("parseProductCursor(%q) = %#v, want error", in, got)
		}
	}
}

func TestParseTerminalSinceSeq(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want int64
	}{
		{name: "empty means zero", in: "", want: 0},
		{name: "blank means zero", in: "  \n\t", want: 0},
		{name: "zero", in: "0", want: 0},
		{name: "positive number", in: "42", want: 42},
		{name: "leading whitespace tolerated", in: "  7", want: 7},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseTerminalSinceSeq(tt.in)
			if err != nil {
				t.Fatalf("parseTerminalSinceSeq(%q) unexpected error: %v", tt.in, err)
			}
			if got != tt.want {
				t.Fatalf("parseTerminalSinceSeq(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestParseTerminalSinceSeqRejectsInvalid(t *testing.T) {
	for _, in := range []string{`-1`, `"42"`, `1.5`, `true`, `[1]`, `{`, `nul`} {
		if got, err := parseTerminalSinceSeq(in); err == nil {
			t.Fatalf("parseTerminalSinceSeq(%q) = %d, want error", in, got)
		}
	}
}
