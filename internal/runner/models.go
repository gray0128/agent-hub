package runner

import "strings"

var agyEffortSuffixes = []string{"-xhigh", "-medium", "-low", "-high", "-max"}

func SplitModelAndEffort(rawModel, rawEffort string) (string, string) {
	model := strings.TrimSpace(rawModel)
	effort := strings.TrimSpace(rawEffort)
	if idx := strings.LastIndex(model, "@"); idx > 0 && idx < len(model)-1 {
		if effort == "" {
			effort = strings.TrimSpace(model[idx+1:])
		}
		model = strings.TrimSpace(model[:idx])
	}
	return model, effort
}

// SplitAgyEffortSuffix extracts the trailing tier suffix on an agy model ID when applicable.
func SplitAgyEffortSuffix(modelID string) (stem string, effort string, hasSuffix bool) {
	trimmed := strings.TrimSpace(modelID)
	lower := strings.ToLower(trimmed)
	if trimmed == "" || strings.Contains(lower, "orchestrator") {
		return trimmed, "", false
	}
	for _, suf := range agyEffortSuffixes {
		if strings.HasSuffix(lower, suf) && len(trimmed) > len(suf) {
			return trimmed[:len(trimmed)-len(suf)], suf[1:], true
		}
	}
	return trimmed, "", false
}

func resolveKnownAgyFamily(raw string) (base string, supportsXHigh bool, known bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "carbon", "gemini-4-carbon":
		return "gemini-4-carbon", false, true
	case "argon", "gemini-4-argon":
		return "gemini-4-argon", false, true
	case "hydrogen", "gemini-4-hydrogen":
		return "gemini-4-hydrogen", true, true
	case "flash", "gemini-3.8-flash":
		return "gemini-3.8-flash", false, true
	case "opus", "claude-opus-5-5":
		return "claude-opus-5-5", false, true
	case "sonnet", "claude-sonnet-5-5":
		return "claude-sonnet-5-5", false, true
	default:
		return "", false, false
	}
}

func ExpandAgyModel(modelAlias, effort string) (string, string) {
	model, eff := SplitModelAndEffort(modelAlias, effort)
	if model == "" {
		return "", eff
	}
	if strings.Contains(strings.ToLower(model), "orchestrator") {
		return model, ""
	}

	if base, supportsXHigh, known := resolveKnownAgyFamily(model); known {
		suffixEffort := eff
		if suffixEffort == "" || suffixEffort == "auto" {
			suffixEffort = "high"
		}
		if !supportsXHigh && (suffixEffort == "xhigh" || suffixEffort == "max") {
			suffixEffort = "high"
		}
		return base + "-" + suffixEffort, eff
	}

	if stem, _, hasSuffix := SplitAgyEffortSuffix(model); hasSuffix {
		if eff == "" || eff == "auto" {
			return model, eff
		}
		_, stemXHigh, stemKnown := resolveKnownAgyFamily(stem)
		suffixEffort := eff
		if stemKnown && !stemXHigh && (suffixEffort == "xhigh" || suffixEffort == "max") {
			suffixEffort = "high"
		}
		return stem + "-" + suffixEffort, eff
	}

	if eff != "" && eff != "off" && eff != "auto" {
		return model + "-" + eff, eff
	}
	return model, eff
}
