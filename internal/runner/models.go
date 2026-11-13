package runner

import "strings"

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

func ExpandAgyModel(modelAlias, effort string) (string, string) {
	model, eff := SplitModelAndEffort(modelAlias, effort)
	if model == "" {
		return "", eff
	}

	suffixEffort := eff
	if suffixEffort == "" {
		suffixEffort = "high"
	}

	var base string
	supportsXHigh := false
	switch strings.ToLower(model) {
	case "carbon":
		base = "gemini-4-carbon"
	case "argon":
		base = "gemini-4-argon"
	case "hydrogen":
		base = "gemini-4-hydrogen"
		supportsXHigh = true
	case "flash":
		base = "gemini-3.8-flash"
	case "opus":
		base = "claude-opus-5-5"
	case "sonnet":
		base = "claude-sonnet-5-5"
	default:
		return model, eff
	}

	mappedSuffix := suffixEffort
	if !supportsXHigh && (mappedSuffix == "xhigh" || mappedSuffix == "max") {
		mappedSuffix = "high"
	}
	return base + "-" + mappedSuffix, eff
}
