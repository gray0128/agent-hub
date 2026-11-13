package runner

import "testing"

func TestExpandAgyModel(t *testing.T) {
	cases := []struct {
		model      string
		effort     string
		wantModel  string
		wantEffort string
	}{
		{"carbon", "", "gemini-4-carbon-high", ""},
		{"carbon@xhigh", "", "gemini-4-carbon-high", "xhigh"},
		{"hydrogen@xhigh", "", "gemini-4-hydrogen-xhigh", "xhigh"},
		{"argon", "low", "gemini-4-argon-low", "low"},
		{"flash", "medium", "gemini-3.8-flash-medium", "medium"},
		{"opus", "", "claude-opus-5-5-high", ""},
		{"sonnet", "low", "claude-sonnet-5-5-low", "low"},
		{"gemini-3.8-flash-high", "high", "gemini-3.8-flash-high", "high"},
	}
	for _, tc := range cases {
		gotModel, gotEffort := ExpandAgyModel(tc.model, tc.effort)
		if gotModel != tc.wantModel || gotEffort != tc.wantEffort {
			t.Fatalf("ExpandAgyModel(%q, %q) = (%q, %q), want (%q, %q)",
				tc.model, tc.effort, gotModel, gotEffort, tc.wantModel, tc.wantEffort)
		}
	}
}
