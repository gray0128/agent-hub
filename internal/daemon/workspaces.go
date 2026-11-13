package daemon

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gray0128/agent-hub/internal/api"
)

func ScanWorkspaces(roots, skipDirs []string) []api.WorkspaceEntry {
	skip := make(map[string]bool, len(skipDirs))
	for _, d := range skipDirs {
		skip[d] = true
	}

	seenPaths := make(map[string]bool)
	type candidate struct {
		path      string
		base      string
		parentKey string
		branch    string
	}
	var found []candidate

	for _, root := range roots {
		cleanRoot := filepath.Clean(root)
		info, err := os.Stat(cleanRoot)
		if err != nil || !info.IsDir() {
			continue
		}

		// Check direct children and grandchildren (depth 1 and 2)
		entries, err := os.ReadDir(cleanRoot)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || skip[entry.Name()] {
				continue
			}
			childPath := filepath.Join(cleanRoot, entry.Name())
			if seenPaths[childPath] {
				continue
			}
			if isProjectDir(childPath) {
				seenPaths[childPath] = true
				found = append(found, candidate{
					path:      childPath,
					base:      entry.Name(),
					parentKey: filepath.Base(cleanRoot) + "/" + entry.Name(),
					branch:    readDefaultBranch(childPath),
				})
				continue
			}

			subEntries, err := os.ReadDir(childPath)
			if err != nil {
				continue
			}
			addedSub := false
			for _, sub := range subEntries {
				if !sub.IsDir() || strings.HasPrefix(sub.Name(), ".") || skip[sub.Name()] {
					continue
				}
				subPath := filepath.Join(childPath, sub.Name())
				if seenPaths[subPath] {
					continue
				}
				if isProjectDir(subPath) {
					seenPaths[subPath] = true
					addedSub = true
					found = append(found, candidate{
						path:      subPath,
						base:      sub.Name(),
						parentKey: entry.Name() + "/" + sub.Name(),
						branch:    readDefaultBranch(subPath),
					})
				}
			}
			if !addedSub {
				seenPaths[childPath] = true
				found = append(found, candidate{
					path:      childPath,
					base:      entry.Name(),
					parentKey: filepath.Base(cleanRoot) + "/" + entry.Name(),
					branch:    "",
				})
			}
		}
	}

	baseCounts := make(map[string]int, len(found))
	for _, c := range found {
		baseCounts[c.base]++
	}

	out := make([]api.WorkspaceEntry, 0, len(found))
	for _, c := range found {
		key := c.base
		if baseCounts[c.base] > 1 {
			key = c.parentKey
		}
		out = append(out, api.WorkspaceEntry{
			Key:           key,
			Path:          c.path,
			DefaultBranch: c.branch,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Key == out[j].Key {
			return out[i].Path < out[j].Path
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func isProjectDir(dir string) bool {
	markers := []string{".git", "go.mod", "package.json", "Cargo.toml", "pyproject.toml"}
	for _, m := range markers {
		if _, err := os.Stat(filepath.Join(dir, m)); err == nil {
			return true
		}
	}
	return false
}

func readDefaultBranch(dir string) string {
	headBytes, err := os.ReadFile(filepath.Join(dir, ".git", "HEAD"))
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(headBytes))
	const prefix = "ref: refs/heads/"
	if strings.HasPrefix(line, prefix) {
		return strings.TrimPrefix(line, prefix)
	}
	return ""
}
