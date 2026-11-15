package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const DefaultHubURL = "https://ahub.bobocai.win"

type Credentials struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

type AgentConfig struct {
	Enabled      bool     `json:"enabled"`
	Command      string   `json:"command"`
	Args         []string `json:"args,omitempty"`
	DefaultModel string   `json:"default_model,omitempty"`
	Models       []string `json:"models,omitempty"`
}

type NodeConfig struct {
	NodeID               string                 `json:"node_id"`
	DisplayName          string                 `json:"display_name"`
	HubURL               string                 `json:"hub_url"`
	Token                string                 `json:"token,omitempty"`
	DelegationToken      string                 `json:"delegation_token,omitempty"`
	MaxConcurrency       int                    `json:"max_concurrency"`
	HeartbeatIntervalSec int                    `json:"heartbeat_interval_sec,omitempty"`
	ProjectRoots         []string               `json:"project_roots"`
	SkipDirs             []string               `json:"skip_dirs"`
	RemoteControlName    string                 `json:"remote_control_name,omitempty"`
	Agents               map[string]AgentConfig `json:"agents"`
}

func ConfigDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("AHUB_CONFIG_DIR")); override != "" {
		return ExpandPath(override), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "ahub"), nil
}

func CredentialsPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "credentials"), nil
}

func DefaultNodeConfigPath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "node.json"), nil
}

func ExpandPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			if p == "~" {
				return home
			}
			return filepath.Join(home, p[2:])
		}
	}
	return filepath.Clean(p)
}

func LoadCredentialsFile() (Credentials, error) {
	path, err := CredentialsPath()
	if err != nil {
		return Credentials{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Credentials{}, nil
		}
		return Credentials{}, err
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return Credentials{}, err
	}
	return creds, nil
}

func SaveCredentials(hubURL, token string) error {
	path, err := CredentialsPath()
	if err != nil {
		return err
	}
	return writeJSONFile0600(path, Credentials{
		URL:   strings.TrimRight(strings.TrimSpace(hubURL), "/"),
		Token: strings.TrimSpace(token),
	})
}

func writeJSONFile0600(path string, v interface{}) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func ResolveCredentials(flagURL, flagToken string) (string, string, error) {
	fileCreds, err := LoadCredentialsFile()
	if err != nil {
		return "", "", err
	}
	hubURL := strings.TrimSpace(flagURL)
	if hubURL == "" {
		hubURL = strings.TrimSpace(os.Getenv("AHUB_URL"))
	}
	if hubURL == "" {
		hubURL = strings.TrimSpace(fileCreds.URL)
	}
	if hubURL == "" {
		hubURL = DefaultHubURL
	}
	hubURL = strings.TrimRight(hubURL, "/")

	token := strings.TrimSpace(flagToken)
	if token == "" {
		token = strings.TrimSpace(os.Getenv("AHUB_TOKEN"))
	}
	if token == "" {
		token = strings.TrimSpace(fileCreds.Token)
	}
	return hubURL, token, nil
}

func normalizeNodeConfig(cfg *NodeConfig) {
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = 4
	}
	if cfg.MaxConcurrency > 16 {
		cfg.MaxConcurrency = 16
	}
	if cfg.HeartbeatIntervalSec <= 0 {
		cfg.HeartbeatIntervalSec = 30
	}
	if strings.TrimSpace(cfg.HubURL) == "" {
		cfg.HubURL = DefaultHubURL
	}
	cfg.HubURL = strings.TrimRight(strings.TrimSpace(cfg.HubURL), "/")
}

func resolveNodeConfigPath(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return DefaultNodeConfigPath()
	}
	return ExpandPath(path), nil
}

func LoadNodeConfigRaw(path string) (*NodeConfig, string, bool, error) {
	resolved, err := resolveNodeConfigPath(path)
	if err != nil {
		return nil, "", false, err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, resolved, false, nil
		}
		return nil, resolved, false, err
	}
	var cfg NodeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, resolved, true, err
	}
	normalizeNodeConfig(&cfg)
	if len(cfg.SkipDirs) == 0 {
		cfg.SkipDirs = []string{"Library", "Applications", "node_modules"}
	}
	return &cfg, resolved, true, nil
}

func SaveNodeConfig(path string, cfg *NodeConfig) (string, error) {
	resolved, err := resolveNodeConfigPath(path)
	if err != nil {
		return "", err
	}
	normalizeNodeConfig(cfg)
	if err := writeJSONFile0600(resolved, cfg); err != nil {
		return "", err
	}
	return resolved, nil
}

func DefaultNodeID() string {
	host, err := os.Hostname()
	if err != nil {
		return "local-node"
	}
	host = strings.TrimSpace(host)
	if idx := strings.IndexByte(host, '.'); idx > 0 {
		host = host[:idx]
	}
	host = strings.ToLower(host)
	var b strings.Builder
	for i := 0; i < len(host); i++ {
		c := host[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			b.WriteByte(c)
		}
	}
	cleaned := strings.Trim(b.String(), "-_")
	if cleaned == "" {
		return "local-node"
	}
	return cleaned
}

func DetectProjectRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{"~/workspace"}
	}
	candidates := []string{"workspace", "projects", "github", "cnb", "code"}
	roots := make([]string, 0, len(candidates))
	for _, name := range candidates {
		info, err := os.Stat(filepath.Join(home, name))
		if err == nil && info.IsDir() {
			roots = append(roots, "~/"+name)
		}
	}
	if len(roots) == 0 {
		return []string{"~/workspace"}
	}
	return roots
}

func DetectAgents(existing map[string]AgentConfig, lookPath func(string) (string, error)) map[string]AgentConfig {
	out := make(map[string]AgentConfig, len(existing)+5)
	for k, v := range existing {
		out[k] = v
	}
	known := []string{"agy", "pi", "omp", "codex", "claude"}
	for _, name := range known {
		prev := out[name]
		cmd := strings.TrimSpace(prev.Command)
		if cmd == "" {
			cmd = name
		}
		found := false
		if lookPath != nil {
			if resolved, err := lookPath(cmd); err == nil && strings.TrimSpace(resolved) != "" {
				found = true
			}
		}
		prev.Command = cmd
		prev.Enabled = prev.Enabled || found
		if name == "agy" && strings.TrimSpace(prev.DefaultModel) == "" {
			prev.DefaultModel = "gemini-3.8-flash-high"
		}
		out[name] = prev
	}
	return out
}

func EnabledAgentNames(agents map[string]AgentConfig) []string {
	names := make([]string, 0, len(agents))
	for name, cfg := range agents {
		if cfg.Enabled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func LoadNodeConfig(path string) (*NodeConfig, error) {
	resolved, err := resolveNodeConfigPath(path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil, err
	}
	var cfg NodeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	normalizeNodeConfig(&cfg)
	for i, r := range cfg.ProjectRoots {
		cfg.ProjectRoots[i] = ExpandPath(r)
	}
	return &cfg, nil
}
