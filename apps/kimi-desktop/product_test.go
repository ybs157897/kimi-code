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
