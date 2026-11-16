package config

import (
	"errors"
	"testing"
)

func TestDetectAgentsDefaultsAgyToHydrogenHigh(t *testing.T) {
	lookPath := func(cmd string) (string, error) {
		if cmd == "agy" {
			return "/usr/local/bin/agy", nil
		}
		return "", errors.New("not found")
	}

	detected := DetectAgents(nil, lookPath)
	if detected["agy"].DefaultModel != DefaultAgyModel {
		t.Fatalf("expected agy DefaultModel %q, got %q", DefaultAgyModel, detected["agy"].DefaultModel)
	}
	if !detected["agy"].Enabled {
		t.Fatalf("expected agy enabled when found in PATH")
	}

	preserved := DetectAgents(map[string]AgentConfig{
		"agy": {Enabled: true, Command: "agy", DefaultModel: "carbon"},
	}, lookPath)
	if preserved["agy"].DefaultModel != "carbon" {
		t.Fatalf("expected explicit agy DefaultModel preserved, got %q", preserved["agy"].DefaultModel)
	}
}
