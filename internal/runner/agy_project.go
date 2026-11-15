package runner

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gray0128/agent-hub/internal/config"
)

const defaultCLIProjectID = "default-cli-project"

type agyProjectFile struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	IsWorkspaceOnly  bool            `json:"isWorkspaceOnly"`
	PermissionGrants json.RawMessage `json:"permissionGrants"`
	Settings         json.RawMessage `json:"settings"`
	ProjectResources struct {
		Resources []struct {
			FolderURI string `json:"folderUri"`
			GitFolder *struct {
				FolderURI string `json:"folderUri"`
			} `json:"gitFolder"`
		} `json:"resources"`
	} `json:"projectResources"`
}

type agyProjectCandidate struct {
	id            string
	exact         bool
	matchLen      int
	workspaceOnly bool
	hasPolicy     bool
}

// ResolveAgyProjectID finds the Antigravity project UUID bound to workdir under ~/.gemini/config/projects.
func ResolveAgyProjectID(workdir string) string {
	trimmed := strings.TrimSpace(workdir)
	if trimmed == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return resolveAgyProjectIDFromDir(trimmed, filepath.Join(home, ".gemini", "config", "projects"))
}

func resolveAgyProjectIDFromDir(workdir, projectsDir string) string {
	targetPaths := canonicalPathVariants(workdir)
	if len(targetPaths) == 0 {
		return ""
	}

	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return ""
	}

	var best *agyProjectCandidate
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || name == defaultCLIProjectID+".json" {
			continue
		}

		data, err := os.ReadFile(filepath.Join(projectsDir, name))
		if err != nil {
			continue
		}
		var proj agyProjectFile
		if err := json.Unmarshal(data, &proj); err != nil {
			continue
		}
		projID := strings.TrimSpace(proj.ID)
		if projID == "" || projID == defaultCLIProjectID {
			continue
		}

		cand, ok := matchAgyProject(projID, proj, targetPaths)
		if !ok {
			continue
		}
		if best == nil || isBetterAgyProjectCandidate(cand, *best) {
			copyCand := cand
			best = &copyCand
		}
	}

	if best == nil {
		return ""
	}
	return best.id
}

func matchAgyProject(projID string, proj agyProjectFile, targetPaths []string) (agyProjectCandidate, bool) {
	hasPolicy := hasNonEmptyJSONObject(proj.PermissionGrants) || hasNonEmptyJSONObject(proj.Settings)
	var best *agyProjectCandidate

	for _, res := range proj.ProjectResources.Resources {
		uris := make([]string, 0, 2)
		if u := strings.TrimSpace(res.FolderURI); u != "" {
			uris = append(uris, u)
		}
		if res.GitFolder != nil {
			if u := strings.TrimSpace(res.GitFolder.FolderURI); u != "" {
				uris = append(uris, u)
			}
		}

		for _, rawURI := range uris {
			localPath, ok := fileURIToLocalPath(rawURI)
			if !ok {
				continue
			}
			for _, fp := range canonicalPathVariants(localPath) {
				for _, tp := range targetPaths {
					exact := tp == fp
					ancestor := !exact && !isFilesystemRoot(fp) && strings.HasPrefix(tp, fp+string(filepath.Separator))
					if !exact && !ancestor {
						continue
					}
					cand := agyProjectCandidate{
						id:            projID,
						exact:         exact,
						matchLen:      len(fp),
						workspaceOnly: proj.IsWorkspaceOnly,
						hasPolicy:     hasPolicy,
					}
					if best == nil || isBetterAgyProjectCandidate(cand, *best) {
						copyCand := cand
						best = &copyCand
					}
				}
			}
		}
	}

	if best == nil {
		return agyProjectCandidate{}, false
	}
	return *best, true
}

func isBetterAgyProjectCandidate(cand, best agyProjectCandidate) bool {
	if cand.exact != best.exact {
		return cand.exact
	}
	if !cand.exact && cand.matchLen != best.matchLen {
		return cand.matchLen > best.matchLen
	}
	if cand.workspaceOnly != best.workspaceOnly {
		return !cand.workspaceOnly
	}
	if cand.hasPolicy != best.hasPolicy {
		return cand.hasPolicy
	}
	return cand.id < best.id
}

func canonicalPathVariants(raw string) []string {
	expanded := config.ExpandPath(raw)
	if expanded == "" {
		return nil
	}
	absPath, err := filepath.Abs(expanded)
	if err != nil {
		absPath = filepath.Clean(expanded)
	} else {
		absPath = filepath.Clean(absPath)
	}

	variants := []string{absPath}
	// Resolve symlinks when available so macOS /tmp and /private/tmp match equivalently.
	if resolved, err := filepath.EvalSymlinks(absPath); err == nil {
		resolved = filepath.Clean(resolved)
		if resolved != "" && resolved != absPath {
			variants = append(variants, resolved)
		}
	}
	return variants
}

func fileURIToLocalPath(rawURI string) (string, bool) {
	trimmed := strings.TrimSpace(rawURI)
	if !strings.HasPrefix(trimmed, "file://") {
		return "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}
	if u.Host != "" && u.Host != "localhost" {
		return "", false
	}
	p := u.Path
	if len(p) >= 3 && p[0] == '/' && ((p[1] >= 'A' && p[1] <= 'Z') || (p[1] >= 'a' && p[1] <= 'z')) && p[2] == ':' {
		p = p[1:]
	}
	local := filepath.FromSlash(p)
	if strings.TrimSpace(local) == "" {
		return "", false
	}
	return local, true
}

func isFilesystemRoot(p string) bool {
	if p == "" {
		return true
	}
	clean := filepath.Clean(p)
	return clean == string(filepath.Separator) || filepath.Dir(clean) == clean
}

func hasNonEmptyJSONObject(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed == "{}" {
		return false
	}
	var obj map[string]json.RawMessage
	return json.Unmarshal(raw, &obj) == nil && len(obj) > 0
}

func hasAgyProjectFlag(args []string) bool {
	for _, a := range args {
		if a == "--project" || a == "--new-project" ||
			strings.HasPrefix(a, "--project=") || strings.HasPrefix(a, "--new-project=") {
			return true
		}
	}
	return false
}
