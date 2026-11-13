package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
	dir, err := ConfigDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "credentials")
	payload, err := json.MarshalIndent(Credentials{
		URL:   strings.TrimRight(strings.TrimSpace(hubURL), "/"),
		Token: strings.TrimSpace(token),
	}, "", "  ")
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

func LoadNodeConfig(path string) (*NodeConfig, error) {
	if strings.TrimSpace(path) == "" {
		var err error
		path, err = DefaultNodeConfigPath()
		if err != nil {
			return nil, err
		}
	} else {
		path = ExpandPath(path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg NodeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = 4
	}
	if cfg.MaxConcurrency > 16 {
		cfg.MaxConcurrency = 16
	}
	if cfg.HeartbeatIntervalSec <= 0 {
		cfg.HeartbeatIntervalSec = 30
	}
	for i, r := range cfg.ProjectRoots {
		cfg.ProjectRoots[i] = ExpandPath(r)
	}
	if cfg.HubURL == "" {
		cfg.HubURL = DefaultHubURL
	}
	cfg.HubURL = strings.TrimRight(cfg.HubURL, "/")
	return &cfg, nil
}
