package redact

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestTextRedactsSecretsAndPreservesPlaceholders(t *testing.T) {
	input := strings.Join([]string{
		`ahub --token ahub_cli_supersecret123456 nodes`,
		`Authorization: Bearer my_secret_bearer_token_99`,
		`curl https://alice:s3cr3tpass@hooks.example.com/hook?token=abc12345`,
		`AHUB_TOKEN=raw_env_secret_value_1`,
		`password="top_secret_pw"`,
		`{"api_key":"sk-live-1234567890abcdef"}`,
		`echo "$AHUB_TOKEN" && <NODE_TOKEN>`,
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
	}, "\n")

	got := Text(input)
	for _, forbidden := range []string{
		"supersecret123456",
		"my_secret_bearer_token_99",
		"s3cr3tpass",
		"abc12345",
		"raw_env_secret_value_1",
		"top_secret_pw",
		"sk-live-1234567890abcdef",
		"MIIEowIBAAKCAQEA",
	} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("expected %q to be redacted, got:\n%s", forbidden, got)
		}
	}
	if !strings.Contains(got, "ahub_cli_[REDACTED]") {
		t.Fatalf("expected ahub_cli_[REDACTED] marker, got:\n%s", got)
	}
	if !strings.Contains(got, `echo "$AHUB_TOKEN" && <NODE_TOKEN>`) {
		t.Fatalf("expected shell variable and placeholder preserved, got:\n%s", got)
	}
	if !strings.Contains(got, "[REDACTED_PRIVATE_KEY]") {
		t.Fatalf("expected private key marker, got:\n%s", got)
	}
}

func TestTextParityEdgeCasesAndIdempotency(t *testing.T) {
	cases := [][2]string{
		{"ahub --token raw_cli_tok_123 --json", "ahub --token [REDACTED] --json"},
		{`ahub --password "my secret pass" --webhook-key wh_999`, `ahub --password "[REDACTED]" --webhook-key [REDACTED]`},
		{"ahub auth login --url https://ahub.bobocai.win --token-stdin", "ahub auth login --url https://ahub.bobocai.win --token-stdin"},
		{"curl -u alice:s3cr3t https://example.com", "curl -u [REDACTED] https://example.com"},
		{`curl -sSu "alice:my pass" --proxy-user bob:sec2 https://x.com`, `curl -sSu "[REDACTED]" --proxy-user [REDACTED] https://x.com`},
		{"curl -H 'X-API-Key: key_abc_123' -H 'X-Webhook-Key: whk_123' https://x.com", "curl -H 'X-API-Key: [REDACTED]' -H 'X-Webhook-Key: [REDACTED]' https://x.com"},
		{`PASSWORD="a b" TOKEN='c d' has_token=true token_source=env`, `PASSWORD="[REDACTED]" TOKEN='[REDACTED]' has_token=true token_source=env`},
		{`{"api_key":"sk-live-1234567890abcdef","token_source":"env","has_token":"true"}`, `{"api_key":"[REDACTED]","token_source":"env","has_token":"true"}`},
		{"fix bearer authentication and bearer middleware configuration", "fix bearer authentication and bearer middleware configuration"},
		{"Bearer 2026-11-17T00:00:00Z", "Bearer 2026-11-17T00:00:00Z"},
		{"Bearer my_secret_token_99", "Bearer [REDACTED]"},
		{`{"cmd": "curl -u \"alice:my pass\" && X-API-Key: sec99"}`, `{"cmd": "curl -u \"[REDACTED]\" && X-API-Key: [REDACTED]"}`},
	}

	for _, tc := range cases {
		once := Text(tc[0])
		if once != tc[1] {
			t.Fatalf("input %q: want %q, got %q", tc[0], tc[1], once)
		}
		if twice := Text(once); twice != once {
			t.Fatalf("idempotency failed for %q: %q -> %q", tc[0], once, twice)
		}
	}
}

func TestTextPreservesE02AndLinearPerformance(t *testing.T) {
	e02 := "literal check: 'single quotes' \"double quotes\" $HOME $(whoami) `uname -a`\n" +
		"```sh\necho \"$AHUB_TOKEN\" && ls -la /tmp\n```\n"
	if got := Text(e02); got != e02 {
		t.Fatalf("E-02 prompt modified:\nwant=%q\ngot =%q", e02, got)
	}

	bigPem := "-----BEGIN RSA PRIVATE KEY-----\n" + strings.Repeat("A", 120_000)
	bigCurl := "curl " + strings.Repeat("-u alice:secret99 ", 5_500) + "https://example.com"
	start := time.Now()
	outPem := Text(bigPem)
	outCurl := Text(bigCurl)
	elapsed := time.Since(start)

	if outPem != bigPem {
		t.Fatalf("unclosed PEM unexpectedly altered")
	}
	if strings.Contains(outCurl, "secret99") {
		t.Fatalf("expected large curl secrets redacted")
	}
	if Text(outCurl) != outCurl {
		t.Fatalf("expected idempotent large curl redaction")
	}
	if elapsed > 250*time.Millisecond {
		t.Fatalf("expected linear runtime <250ms, took %v", elapsed)
	}
}

func TestTruncateUTF8RespectsRuneBoundaries(t *testing.T) {
	src := strings.Repeat("中", 20)
	trimmed, truncated := TruncateUTF8(src, 10)
	if !truncated {
		t.Fatalf("expected truncated=true")
	}
	if !strings.HasPrefix(trimmed, "中中中") {
		t.Fatalf("unexpected truncated prefix: %q", trimmed)
	}
	if !strings.Contains(trimmed, "--full") {
		t.Fatalf("expected --full hint in truncated suffix: %q", trimmed)
	}
}

func TestMapAndValueRedactsNestedSecretsAndPreservesTypes(t *testing.T) {
	rawJSON := `{
		"api_key": "raw_unprefixed_secret_123",
		"webhook_key": "wh_raw_999",
		"access_token": "ahub_cli_leaksecret99",
		"placeholder_token": "$MY_SECRET_VAR",
		"template_secret": "<WEBHOOK_SECRET>",
		"has_token": "true",
		"token_source": "env",
		"count": 9007199254740993,
		"ok": true,
		"nested": {
			"password": "db_password_xyz",
			"note": "Authorization: Bearer my_bearer_999"
		},
		"items": [
			"token=inline_val_abc",
			{"secret": "nested_arr_secret"}
		]
	}`
	dec := json.NewDecoder(bytes.NewBufferString(rawJSON))
	dec.UseNumber()
	var decoded map[string]interface{}
	if err := dec.Decode(&decoded); err != nil {
		t.Fatalf("decode failed: %v", err)
	}

	got := Map(decoded)
	encodedBytes, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	encoded := string(encodedBytes)

	for _, forbidden := range []string{
		"raw_unprefixed_secret_123",
		"wh_raw_999",
		"leaksecret99",
		"db_password_xyz",
		"my_bearer_999",
		"inline_val_abc",
		"nested_arr_secret",
	} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("expected %q redacted in Map output: %s", forbidden, encoded)
		}
	}

	if got["api_key"] != "[REDACTED]" {
		t.Fatalf("expected api_key=[REDACTED], got %v", got["api_key"])
	}
	if got["webhook_key"] != "[REDACTED]" {
		t.Fatalf("expected webhook_key=[REDACTED], got %v", got["webhook_key"])
	}
	if got["access_token"] != "ahub_cli_[REDACTED]" {
		t.Fatalf("expected access_token=ahub_cli_[REDACTED], got %v", got["access_token"])
	}
	if got["placeholder_token"] != "$MY_SECRET_VAR" {
		t.Fatalf("expected $MY_SECRET_VAR preserved, got %v", got["placeholder_token"])
	}
	if got["template_secret"] != "<WEBHOOK_SECRET>" {
		t.Fatalf("expected <WEBHOOK_SECRET> preserved, got %v", got["template_secret"])
	}
	if got["has_token"] != "true" || got["token_source"] != "env" {
		t.Fatalf("expected has_token and token_source preserved, got %v / %v", got["has_token"], got["token_source"])
	}
	if num, ok := got["count"].(json.Number); !ok || num.String() != "9007199254740993" {
		t.Fatalf("expected json.Number preserved, got %#v", got["count"])
	}
	if got["ok"] != true {
		t.Fatalf("expected bool preserved, got %#v", got["ok"])
	}
	if Map(nil) != nil || Value(nil) != nil {
		t.Fatalf("expected nil Map/Value to stay nil")
	}

	if got := Text(`{"AHUB_TOKEN":"__MISSING__","AWS_SECRET_ACCESS_KEY":"__MISSING__"}`); got != `{"AHUB_TOKEN":"__MISSING__","AWS_SECRET_ACCESS_KEY":"__MISSING__"}` {
		t.Fatalf("expected __MISSING__ sentinel preserved, got %q", got)
	}
}
