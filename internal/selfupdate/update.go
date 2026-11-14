package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gray0128/agent-hub/internal/api"
)

type UpdateResult struct {
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	Updated         bool   `json:"updated"`
	BinaryPath      string `json:"binary_path,omitempty"`
	DaemonRestarted bool   `json:"daemon_restarted"`
	ReloadMode      string `json:"reload_mode,omitempty"`
	DaemonAppPath   string `json:"daemon_app_path,omitempty"`
}

func CheckAndApply(ctx context.Context, client *api.Client, currentVersion string, checkOnly bool, targetBinary string) (*UpdateResult, error) {
	manifest, err := client.GetVersionManifest(ctx)
	if err != nil {
		return nil, err
	}
	assetKey := runtime.GOOS + "_" + runtime.GOARCH
	asset, ok := manifest.Assets[assetKey]
	if !ok {
		return nil, fmt.Errorf("no release asset found for %s", assetKey)
	}

	available := manifest.Version != "" && (currentVersion == "" || currentVersion == "dev" || normalizeVersion(manifest.Version) != normalizeVersion(currentVersion))
	res := &UpdateResult{
		CurrentVersion:  currentVersion,
		LatestVersion:   manifest.Version,
		UpdateAvailable: available,
		Updated:         false,
		BinaryPath:      targetBinary,
	}
	if checkOnly || !available {
		return res, nil
	}

	if targetBinary == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		targetBinary = exe
	}
	res.BinaryPath = targetBinary

	downloadURL := asset.URL
	if strings.HasPrefix(downloadURL, "/") {
		downloadURL = strings.TrimRight(client.BaseURL, "/") + downloadURL
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("download failed with HTTP %d", resp.StatusCode)
	}

	dir := filepath.Dir(targetBinary)
	tmpFile, err := os.CreateTemp(dir, ".ahub-update-*")
	if err != nil {
		return nil, err
	}
	tmpPath := tmpFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmpFile, hasher), resp.Body); err != nil {
		_ = tmpFile.Close()
		return nil, err
	}
	if err := tmpFile.Close(); err != nil {
		return nil, err
	}

	actualSHA := hex.EncodeToString(hasher.Sum(nil))
	if asset.SHA256 != "" && !strings.EqualFold(actualSHA, strings.TrimSpace(asset.SHA256)) {
		return nil, fmt.Errorf("sha256 mismatch: expected %s, got %s", asset.SHA256, actualSHA)
	}

	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return nil, err
	}
	if runtime.GOOS == "darwin" {
		if xattrPath, err := exec.LookPath("xattr"); err == nil {
			_ = exec.Command(xattrPath, "-cr", tmpPath).Run()
		}
	}
	var backupPath string
	if runtime.GOOS == "windows" {
		if _, statErr := os.Stat(targetBinary); statErr == nil {
			backupPath = targetBinary + ".old"
			_ = os.Remove(backupPath)
			if err := os.Rename(targetBinary, backupPath); err != nil {
				return nil, err
			}
		}
	}
	if err := os.Rename(tmpPath, targetBinary); err != nil {
		if backupPath != "" {
			_ = os.Rename(backupPath, targetBinary)
		}
		return nil, err
	}
	cleanup = false
	res.Updated = true
	return res, nil
}

func normalizeVersion(v string) string {
	return strings.TrimPrefix(strings.TrimSpace(v), "v")
}
