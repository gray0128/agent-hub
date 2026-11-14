package selfupdate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"

	"github.com/gray0128/agent-hub/internal/api"
)

func TestNormalizeVersion(t *testing.T) {
	if got := normalizeVersion(" v0.1.0 "); got != "0.1.0" {
		t.Fatalf("normalizeVersion got %q, want 0.1.0", got)
	}
	if got := normalizeVersion("0.1.0"); got != "0.1.0" {
		t.Fatalf("normalizeVersion got %q, want 0.1.0", got)
	}
}

func TestCheckAndApplyVersionComparison(t *testing.T) {
	assetKey := runtime.GOOS + "_" + runtime.GOARCH
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dl/version.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(api.VersionManifest{
			Version: "v0.1.0",
			Assets: map[string]api.VersionAsset{
				assetKey: {URL: "/dl/ahub", SHA256: ""},
			},
		})
	}))
	defer srv.Close()

	client := api.NewClient(srv.URL, "")

	sameNoPrefix, err := CheckAndApply(context.Background(), client, "0.1.0", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if sameNoPrefix.UpdateAvailable {
		t.Fatalf("expected UpdateAvailable=false for 0.1.0 vs v0.1.0, got %+v", sameNoPrefix)
	}

	older, err := CheckAndApply(context.Background(), client, "v0.0.9", true, "")
	if err != nil {
		t.Fatal(err)
	}
	if !older.UpdateAvailable || older.Updated {
		t.Fatalf("expected UpdateAvailable=true and Updated=false on checkOnly, got %+v", older)
	}
}
