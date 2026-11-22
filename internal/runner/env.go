package runner

import (
	"os"
	"strconv"
	"strings"

	"github.com/gray0128/agent-hub/internal/api"
)

var envAllowlist = map[string]bool{
	"PATH":          true,
	"HOME":          true,
	"USER":          true,
	"LOGNAME":       true,
	"SHELL":         true,
	"LANG":          true,
	"LC_ALL":        true,
	"TMPDIR":        true,
	"TERM":          true,
	"SSH_AUTH_SOCK": true,
	"CODEX_HOME":    true,
	"USERPROFILE":   true,
	"APPDATA":       true,
	"LOCALAPPDATA":  true,
	"SYSTEMROOT":    true,
}

// BuildBaseSanitizedEnv keeps minimal runtime variables and strips AHUB_TOKEN and secrets.
func BuildBaseSanitizedEnv() []string {
	out := make([]string, 0, 24)
	for _, entry := range os.Environ() {
		idx := strings.IndexByte(entry, '=')
		if idx <= 0 {
			continue
		}
		key := entry[:idx]
		if envAllowlist[key] || strings.HasPrefix(key, "XDG_") {
			out = append(out, entry)
		}
	}
	return out
}

func BuildSanitizedEnv(run api.RunRecord, hubURL, delegationToken, resultFile string) []string {
	out := BuildBaseSanitizedEnv()

	if delegationToken != "" {
		out = append(out, "AHUB_TOKEN="+delegationToken)
		if hubURL != "" {
			out = append(out, "AHUB_URL="+hubURL)
		}
	}
	if strings.TrimSpace(resultFile) != "" {
		out = append(out, "AHUB_RESULT_FILE="+resultFile)
	}
	out = append(out,
		"AHUB_RUN_ID="+run.ID,
		"AHUB_THREAD_ID="+run.ThreadID,
		"AHUB_ROOT_RUN_ID="+run.RootRunID,
		"AHUB_DEPTH="+strconv.Itoa(run.Depth),
	)
	return out
}
