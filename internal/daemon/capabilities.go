package daemon

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gray0128/agent-hub/internal/api"
	"github.com/gray0128/agent-hub/internal/config"
	"github.com/gray0128/agent-hub/internal/runner"
)

const (
	defaultCatalogProbeTimeout = 4 * time.Second
	defaultCatalogCacheTTL     = 10 * time.Minute
)

var (
	agyLabelTierRe = regexp.MustCompile(`(?i)\s*\((low|medium|high|xhigh|max)\)\s*$`)

	claudeModelEnvWhitelist = []string{
		"ANTHROPIC_MODEL",
		"ANTHROPIC_REASONING_MODEL",
		"ANTHROPIC_DEFAULT_OPUS_MODEL",
		"ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	}
)

func defaultCapabilitiesAliases() map[string]string {
	return map[string]string{
		"carbon":   "gemini-4-carbon-high",
		"argon":    "gemini-4-argon-high",
		"hydrogen": "gemini-4-hydrogen-high",
		"flash":    "gemini-3.8-flash-high",
		"opus":     "claude-opus-5-5-high",
		"sonnet":   "claude-sonnet-5-5-high",
	}
}

func (d *Daemon) probeCapabilities() map[string]interface{} {
	d.mu.Lock()
	cachedSnap := cloneAgentCapsMap(d.cachedAgentCaps)
	d.mu.Unlock()

	agents := make(map[string]api.AgentCapability, len(d.cfg.Agents))
	for name, cfg := range d.cfg.Agents {
		available := lookupAgentAvailable(name, cfg)
		defModel, defEffort := resolveConfiguredDefaults(name, cfg)

		if !cfg.Enabled || !available {
			agents[name] = api.AgentCapability{
				Enabled:       cfg.Enabled,
				Available:     available,
				DefaultModel:  defModel,
				DefaultEffort: defEffort,
				CatalogStatus: "fallback",
				Models:        []api.ModelCapability{},
			}
			continue
		}

		if cached, ok := cachedSnap[name]; ok {
			entry := cloneAgentCapability(cached)
			entry.Enabled = cfg.Enabled
			entry.Available = available
			if defModel != "" {
				entry.DefaultModel = defModel
			}
			if defEffort != "" {
				entry.DefaultEffort = defEffort
			}
			agents[name] = entry
			continue
		}

		agents[name] = api.AgentCapability{
			Enabled:       cfg.Enabled,
			Available:     available,
			DefaultModel:  defModel,
			DefaultEffort: defEffort,
			CatalogStatus: "pending",
			Models:        []api.ModelCapability{},
		}
	}

	return map[string]interface{}{
		"agents":  agents,
		"aliases": defaultCapabilitiesAliases(),
	}
}

func (d *Daemon) refreshModelCatalogsAsync(ctx context.Context) {
	ttl := d.catalogCacheTTL
	if ttl <= 0 {
		ttl = defaultCatalogCacheTTL
	}
	timeout := d.catalogProbeTimeout
	if timeout <= 0 {
		timeout = defaultCatalogProbeTimeout
	}

	d.mu.Lock()
	if d.capRefreshInFlight || (len(d.cachedAgentCaps) > 0 && time.Since(d.cachedCapsAt) < ttl) {
		d.mu.Unlock()
		return
	}
	d.capRefreshInFlight = true
	d.mu.Unlock()

	defer func() {
		d.mu.Lock()
		d.capRefreshInFlight = false
		d.mu.Unlock()
	}()

	probed := make(map[string]api.AgentCapability, len(d.cfg.Agents))
	baseEnv := runner.BuildBaseSanitizedEnv()

	for name, cfg := range d.cfg.Agents {
		if ctx.Err() != nil {
			return
		}
		if !cfg.Enabled || !lookupAgentAvailable(name, cfg) {
			continue
		}
		probed[name] = probeSingleAgentCapability(ctx, timeout, baseEnv, name, cfg)
	}

	if ctx.Err() != nil {
		return
	}

	d.mu.Lock()
	d.cachedAgentCaps = probed
	d.cachedCapsAt = time.Now()
	conn := d.conn
	nonce := d.connNonce
	ws := cloneWorkspaces(d.cachedWorkspaces)
	d.mu.Unlock()

	if len(probed) > 0 && conn != nil && nonce != "" {
		d.sendHelloRefresh(conn, nonce, ws)
	}
}

func lookupAgentAvailable(name string, cfg config.AgentConfig) bool {
	cmd := cfg.Command
	if cmd == "" {
		cmd = name
	}
	_, err := exec.LookPath(config.ExpandPath(cmd))
	return err == nil
}

func resolveConfiguredDefaults(agent string, cfg config.AgentConfig) (string, string) {
	rawDefault := cfg.DefaultModel
	if agent == "agy" && strings.TrimSpace(rawDefault) == "" {
		rawDefault = config.DefaultAgyModel
	}
	model, effort := runner.SplitModelAndEffort(rawDefault, "")
	if model == "" {
		return "", effort
	}
	if agent == "agy" {
		return normalizeAgyDefaultModel(model, effort)
	}
	return model, effort
}

func normalizeAgyDefaultModel(model, effort string) (string, string) {
	if strings.Contains(strings.ToLower(model), "orchestrator") {
		return model, ""
	}
	if stem, suf, hasSuffix := runner.SplitAgyEffortSuffix(model); hasSuffix {
		if effort == "" {
			effort = suf
		}
		return stem, effort
	}
	expanded, _ := runner.ExpandAgyModel(model, effort)
	if stem, suf, hasSuffix := runner.SplitAgyEffortSuffix(expanded); hasSuffix {
		if effort == "" {
			effort = suf
		}
		return stem, effort
	}
	return model, effort
}

func probeSingleAgentCapability(ctx context.Context, timeout time.Duration, env []string, name string, cfg config.AgentConfig) api.AgentCapability {
	cmd := cfg.Command
	if cmd == "" {
		cmd = name
	}
	bin := config.ExpandPath(cmd)

	defModel, defEffort := resolveConfiguredDefaults(name, cfg)
	models := []api.ModelCapability{}
	probeOK := false

	switch name {
	case "agy":
		out, err := runner.RunCommandOutputBounded(ctx, timeout, env, bin, "models")
		if err == nil {
			parsed := parseAgyModelsOutput(string(out))
			if len(parsed) > 0 {
				models = parsed
				probeOK = true
			}
		}
	case "omp":
		out, err := runner.RunCommandOutputBounded(ctx, timeout, env, bin, "models", "--json")
		if err == nil {
			parsed := parseOmpModelsJSON(out)
			if len(parsed) > 0 {
				models = parsed
				probeOK = true
			}
		}
	case "pi":
		out, err := runner.RunCommandOutputBounded(ctx, timeout, env, bin, "--list-models")
		if err == nil {
			parsed := parsePiListModelsOutput(string(out))
			if len(parsed) > 0 {
				models = parsed
				probeOK = true
			}
		}
	case "codex":
		parsed, cfgModel, cfgEffort, ok := loadCodexModels(cfg)
		models = parsed
		probeOK = ok
		if defModel == "" && cfgModel != "" {
			defModel = cfgModel
		}
		if defEffort == "" && cfgEffort != "" {
			defEffort = cfgEffort
		}
	case "claude":
		parsed, cfgModel, ok := loadClaudeModels(cfg)
		models = parsed
		probeOK = ok
		if defModel == "" && cfgModel != "" {
			defModel = cfgModel
		}
	default:
		probeOK = len(cfg.Models) > 0 || defModel != ""
	}

	models = mergeConfiguredModels(name, models, cfg)
	if len(models) == 0 {
		models = fallbackModelsForAgent(name, defModel)
	}

	if defModel == "" && len(models) > 0 {
		defModel = models[0].ID
	}
	if defEffort == "" && defModel != "" {
		for _, m := range models {
			if m.ID == defModel && m.DefaultEffort != "" {
				defEffort = m.DefaultEffort
				break
			}
		}
	}

	status := "fallback"
	if probeOK {
		status = "ready"
	}

	return api.AgentCapability{
		Enabled:       cfg.Enabled,
		Available:     true,
		DefaultModel:  defModel,
		DefaultEffort: defEffort,
		CatalogStatus: status,
		Models:        ensureNonNilEffortsSlice(models),
	}
}

func parseAgyModelsOutput(raw string) []api.ModelCapability {
	lines := strings.Split(raw, "\n")
	order := []string{}
	grouped := make(map[string]*api.ModelCapability)

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "fetching ") {
			continue
		}

		var rawID, rawLabel string
		if strings.Contains(trimmed, "\t") {
			parts := strings.SplitN(trimmed, "\t", 2)
			rawID = strings.TrimSpace(parts[0])
			if len(parts) > 1 {
				rawLabel = strings.TrimSpace(parts[1])
			}
		} else {
			fields := strings.Fields(trimmed)
			if len(fields) == 0 {
				continue
			}
			rawID = fields[0]
			if len(fields) > 1 {
				rawLabel = strings.Join(fields[1:], " ")
			}
		}
		if rawID == "" || strings.ContainsAny(rawID, " \t") {
			continue
		}

		stem, effort, hasSuffix := runner.SplitAgyEffortSuffix(rawID)
		if !hasSuffix {
			if _, exists := grouped[rawID]; !exists {
				label := strings.TrimSpace(rawLabel)
				if label == "" {
					label = rawID
				}
				order = append(order, rawID)
				grouped[rawID] = &api.ModelCapability{
					ID:      rawID,
					Label:   label,
					Efforts: []string{},
				}
			}
			continue
		}

		entry, exists := grouped[stem]
		if !exists {
			label := cleanAgyGroupLabel(rawLabel, stem)
			order = append(order, stem)
			entry = &api.ModelCapability{
				ID:      stem,
				Label:   label,
				Efforts: []string{},
			}
			grouped[stem] = entry
		}
		if !sliceContains(entry.Efforts, effort) {
			entry.Efforts = append(entry.Efforts, effort)
		}
	}

	out := make([]api.ModelCapability, 0, len(order))
	for _, id := range order {
		entry := grouped[id]
		if len(entry.Efforts) > 0 {
			entry.DefaultEffort = pickPreferredEffort(entry.Efforts, "high", "medium")
		}
		out = append(out, *entry)
	}
	return out
}

func cleanAgyGroupLabel(rawLabel, fallbackStem string) string {
	cleaned := strings.TrimSpace(agyLabelTierRe.ReplaceAllString(rawLabel, ""))
	if cleaned == "" {
		return fallbackStem
	}
	return cleaned
}

func parseOmpModelsJSON(raw []byte) []api.ModelCapability {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return []api.ModelCapability{}
	}

	if idx := strings.IndexAny(trimmed, "{["); idx > 0 {
		trimmed = trimmed[idx:]
	}

	type ompModelItem struct {
		Provider  string   `json:"provider"`
		ID        string   `json:"id"`
		Selector  string   `json:"selector"`
		Name      string   `json:"name"`
		Reasoning bool     `json:"reasoning"`
		Thinking  []string `json:"thinking"`
	}

	var items []ompModelItem
	var wrapper struct {
		Models []ompModelItem `json:"models"`
	}
	if err := json.Unmarshal([]byte(trimmed), &wrapper); err == nil && wrapper.Models != nil {
		items = wrapper.Models
	} else {
		var bare []ompModelItem
		if err := json.Unmarshal([]byte(trimmed), &bare); err != nil {
			return []api.ModelCapability{}
		}
		items = bare
	}

	out := make([]api.ModelCapability, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.Selector)
		if id == "" {
			if item.Provider != "" && item.ID != "" {
				id = strings.TrimSpace(item.Provider) + "/" + strings.TrimSpace(item.ID)
			} else {
				id = strings.TrimSpace(item.ID)
			}
		}
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}

		label := strings.TrimSpace(item.Name)
		if label == "" {
			label = id
		}

		efforts := []string{}
		if item.Reasoning {
			for _, t := range item.Thinking {
				norm := strings.ToLower(strings.TrimSpace(t))
				if norm != "" && !sliceContains(efforts, norm) {
					efforts = append(efforts, norm)
				}
			}
		}

		defEffort := ""
		if len(efforts) > 0 {
			defEffort = pickPreferredEffort(efforts, "high", "medium")
		}

		out = append(out, api.ModelCapability{
			ID:            id,
			Label:         label,
			Efforts:       efforts,
			DefaultEffort: defEffort,
		})
	}
	return out
}

func parsePiListModelsOutput(raw string) []api.ModelCapability {
	lines := strings.Split(raw, "\n")
	out := []api.ModelCapability{}
	seen := make(map[string]struct{})

	for _, line := range lines {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 5 {
			continue
		}
		if strings.EqualFold(fields[0], "provider") && strings.EqualFold(fields[1], "model") {
			continue
		}
		provider := strings.TrimSpace(fields[0])
		model := strings.TrimSpace(fields[1])
		thinking := strings.ToLower(strings.TrimSpace(fields[4]))
		if provider == "" || model == "" {
			continue
		}

		id := provider + "/" + model
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}

		efforts := []string{}
		defEffort := ""
		if thinking == "yes" || thinking == "true" {
			efforts = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}
			defEffort = "medium"
		}

		out = append(out, api.ModelCapability{
			ID:            id,
			Label:         id,
			Efforts:       efforts,
			DefaultEffort: defEffort,
		})
	}
	return out
}

func loadCodexModels(cfg config.AgentConfig) ([]api.ModelCapability, string, string, bool) {
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return []api.ModelCapability{}, "", "", false
		}
		codexHome = filepath.Join(home, ".codex")
	} else {
		codexHome = config.ExpandPath(codexHome)
	}

	tomlModel, tomlEffort, catalogPath := parseCodexConfigTOML(filepath.Join(codexHome, "config.toml"))
	if catalogPath == "" {
		catalogPath = filepath.Join(codexHome, "models_cache.json")
	} else {
		catalogPath = config.ExpandPath(catalogPath)
		if !filepath.IsAbs(catalogPath) {
			catalogPath = filepath.Join(codexHome, catalogPath)
		}
	}

	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		return []api.ModelCapability{}, tomlModel, tomlEffort, false
	}

	var catalog struct {
		Models []struct {
			Slug                     string `json:"slug"`
			DisplayName              string `json:"display_name"`
			Visibility               string `json:"visibility"`
			DefaultReasoningLevel    string `json:"default_reasoning_level"`
			SupportedReasoningLevels []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return []api.ModelCapability{}, tomlModel, tomlEffort, false
	}

	cfgDefModel, _ := runner.SplitModelAndEffort(cfg.DefaultModel, "")
	out := make([]api.ModelCapability, 0, len(catalog.Models))
	seen := make(map[string]struct{})
	for _, m := range catalog.Models {
		slug := strings.TrimSpace(m.Slug)
		if slug == "" {
			continue
		}
		vis := strings.TrimSpace(m.Visibility)
		isListed := vis == "" || strings.EqualFold(vis, "list")
		isActive := slug == tomlModel || (cfgDefModel != "" && slug == cfgDefModel)
		if !isListed && !isActive {
			continue
		}
		if _, dup := seen[slug]; dup {
			continue
		}
		seen[slug] = struct{}{}

		efforts := []string{}
		for _, lvl := range m.SupportedReasoningLevels {
			e := strings.ToLower(strings.TrimSpace(lvl.Effort))
			if e != "" && !sliceContains(efforts, e) {
				efforts = append(efforts, e)
			}
		}

		label := strings.TrimSpace(m.DisplayName)
		if label == "" {
			label = slug
		}

		out = append(out, api.ModelCapability{
			ID:            slug,
			Label:         label,
			Efforts:       efforts,
			DefaultEffort: strings.ToLower(strings.TrimSpace(m.DefaultReasoningLevel)),
		})
	}

	if len(out) == 0 {
		return []api.ModelCapability{}, tomlModel, tomlEffort, false
	}
	return out, tomlModel, tomlEffort, true
}

func parseCodexConfigTOML(path string) (model, reasoningEffort, catalogJSON string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", ""
	}
	section := ""
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section = strings.TrimSpace(trimmed[1 : len(trimmed)-1])
			continue
		}
		if section != "" {
			continue
		}
		eq := strings.Index(trimmed, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:eq])
		val := parseTOMLStringValue(trimmed[eq+1:])
		switch key {
		case "model":
			model = val
		case "model_reasoning_effort":
			reasoningEffort = strings.ToLower(val)
		case "model_catalog_json":
			catalogJSON = val
		}
	}
	return model, reasoningEffort, catalogJSON
}

func parseTOMLStringValue(raw string) string {
	inSingle := false
	inDouble := false
	cleaned := raw
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == '\\' && inDouble {
			i++
			continue
		}
		if c == '\'' && !inDouble {
			inSingle = !inSingle
		} else if c == '"' && !inSingle {
			inDouble = !inDouble
		} else if c == '#' && !inSingle && !inDouble {
			cleaned = raw[:i]
			break
		}
	}
	cleaned = strings.TrimSpace(cleaned)
	if len(cleaned) >= 2 {
		if (cleaned[0] == '"' && cleaned[len(cleaned)-1] == '"') ||
			(cleaned[0] == '\'' && cleaned[len(cleaned)-1] == '\'') {
			return strings.TrimSpace(cleaned[1 : len(cleaned)-1])
		}
	}
	return cleaned
}

func loadClaudeModels(cfg config.AgentConfig) ([]api.ModelCapability, string, bool) {
	claudeDir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if claudeDir == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return []api.ModelCapability{}, "", false
		}
		claudeDir = filepath.Join(home, ".claude")
	} else {
		claudeDir = config.ExpandPath(claudeDir)
	}

	raw, err := os.ReadFile(filepath.Join(claudeDir, "settings.json"))
	if err != nil {
		return []api.ModelCapability{}, "", false
	}

	var settings struct {
		Model string            `json:"model"`
		Env   map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return []api.ModelCapability{}, "", false
	}

	seen := make(map[string]struct{})
	candidates := []string{}
	addModel := func(v string) {
		m := strings.TrimSpace(v)
		if m == "" {
			return
		}
		if _, dup := seen[m]; dup {
			return
		}
		seen[m] = struct{}{}
		candidates = append(candidates, m)
	}

	defaultModel := strings.TrimSpace(settings.Model)
	addModel(defaultModel)
	for _, key := range claudeModelEnvWhitelist {
		if val := strings.TrimSpace(settings.Env[key]); val != "" {
			if defaultModel == "" && key == "ANTHROPIC_MODEL" {
				defaultModel = val
			}
			addModel(val)
		}
	}
	if defaultModel == "" && len(candidates) > 0 {
		defaultModel = candidates[0]
	}

	out := make([]api.ModelCapability, 0, len(candidates))
	for _, id := range candidates {
		out = append(out, api.ModelCapability{
			ID:            id,
			Label:         id,
			Efforts:       []string{"low", "medium", "high", "max"},
			DefaultEffort: "high",
		})
	}
	if len(out) == 0 && len(cfg.Models) == 0 {
		return []api.ModelCapability{}, defaultModel, false
	}
	return out, defaultModel, len(out) > 0
}

func mergeConfiguredModels(agent string, base []api.ModelCapability, cfg config.AgentConfig) []api.ModelCapability {
	out := ensureNonNilEffortsSlice(base)
	seen := make(map[string]struct{}, len(out))
	for _, m := range out {
		seen[m.ID] = struct{}{}
	}
	for _, raw := range cfg.Models {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		efforts, defEffort := defaultEffortsForAgentModel(agent, id)
		out = append(out, api.ModelCapability{
			ID:            id,
			Label:         id,
			Efforts:       efforts,
			DefaultEffort: defEffort,
		})
	}
	return out
}

func fallbackModelsForAgent(agent, defaultModel string) []api.ModelCapability {
	candidates := []string{}
	if defaultModel != "" {
		candidates = append(candidates, defaultModel)
	}
	switch agent {
	case "agy":
		for _, id := range []string{"gemini-4-hydrogen", "gemini-4-carbon", "gemini-3.8-flash", "gemini-pro-orchestrator"} {
			if !sliceContains(candidates, id) {
				candidates = append(candidates, id)
			}
		}
	case "claude":
		for _, id := range []string{"sonnet", "opus", "haiku"} {
			if !sliceContains(candidates, id) {
				candidates = append(candidates, id)
			}
		}
	}
	out := make([]api.ModelCapability, 0, len(candidates))
	for _, id := range candidates {
		efforts, defEffort := defaultEffortsForAgentModel(agent, id)
		out = append(out, api.ModelCapability{
			ID:            id,
			Label:         id,
			Efforts:       efforts,
			DefaultEffort: defEffort,
		})
	}
	return out
}

func defaultEffortsForAgentModel(agent, modelID string) ([]string, string) {
	switch agent {
	case "agy":
		if strings.Contains(strings.ToLower(modelID), "orchestrator") {
			return []string{}, ""
		}
		if strings.Contains(strings.ToLower(modelID), "hydrogen") {
			return []string{"low", "medium", "high", "xhigh"}, "high"
		}
		return []string{"low", "medium", "high"}, "high"
	case "pi":
		return []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}, "medium"
	case "omp":
		return []string{"off", "minimal", "low", "medium", "high", "xhigh"}, "high"
	case "codex":
		return []string{"low", "medium", "high", "xhigh"}, "medium"
	case "claude":
		return []string{"low", "medium", "high", "max"}, "high"
	default:
		return []string{}, ""
	}
}

func ensureNonNilEffortsSlice(in []api.ModelCapability) []api.ModelCapability {
	out := make([]api.ModelCapability, len(in))
	for i, m := range in {
		efforts := []string{}
		if len(m.Efforts) > 0 {
			efforts = append([]string(nil), m.Efforts...)
		}
		m.Efforts = efforts
		out[i] = m
	}
	return out
}

func cloneAgentCapability(in api.AgentCapability) api.AgentCapability {
	out := in
	if in.Models != nil {
		out.Models = ensureNonNilEffortsSlice(in.Models)
	} else {
		out.Models = []api.ModelCapability{}
	}
	return out
}

func cloneAgentCapsMap(in map[string]api.AgentCapability) map[string]api.AgentCapability {
	out := make(map[string]api.AgentCapability, len(in))
	for k, v := range in {
		out[k] = cloneAgentCapability(v)
	}
	return out
}

func pickPreferredEffort(efforts []string, preferred ...string) string {
	for _, p := range preferred {
		if sliceContains(efforts, p) {
			return p
		}
	}
	if len(efforts) > 0 {
		return efforts[0]
	}
	return ""
}

func sliceContains(slice []string, target string) bool {
	for _, item := range slice {
		if item == target {
			return true
		}
	}
	return false
}
