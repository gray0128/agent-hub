package redact

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

const pemBegin, pemEnd, pemSuffix = "-----BEGIN ", "-----END ", "PRIVATE KEY-----"

var (
	ahubTokenRe        = regexp.MustCompile(`\bahub_(adm|cli|nod)_[A-Za-z0-9_-]{6,}`)
	urlUserInfoRe      = regexp.MustCompile(`(https?://)([^/\s:@]+:[^/\s@]+)@`)
	knownPrefixRe      = regexp.MustCompile(`\b(?:sk-proj-|sk-live-|sk-test-|sk-|xai-|ghp_|gho_|ghu_|ghs_|github_pat_|AIza|whsec_|xox[baprs]-)[A-Za-z0-9_-]{10,}`)
	querySecretRe      = regexp.MustCompile(`(?i)([?&](?:token|key|secret|password|passwd|access_token|api_key|webhook_key)=)([^&\s'"` + "`" + `#]+)`)
	authHeaderRe       = regexp.MustCompile(`(?i)(authorization\s*:\s*(?:bearer|basic)[ \t]+)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"` + "`" + `]+)`)
	httpHeaderSecretRe = regexp.MustCompile(`(?i)(\b(?:x-api-key|api-key|x-auth-token|x-access-token|x-webhook-key|cf-access-client-secret)\s*:\s*)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"` + "`" + `]+)`)
	bearerRe           = regexp.MustCompile(`(?i)\b(bearer)([ \t]+)([A-Za-z0-9._~+/=-]{8,})`)
	curlLineRe         = regexp.MustCompile(`(?m)^[^\r\n]*\bcurl\b[^\r\n]*$`)
	curlUserFlagRe     = regexp.MustCompile(`((?:^|[\s;|&(])(?:-[A-Za-z]*u|--user|--proxy-user)(?:=|[ \t]+))(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"` + "`" + `;|&]+)`)
	cliFlagSecretRe    = regexp.MustCompile(`(?i)((?:^|[\s;|&(])--(?:[a-z0-9-]+-)?(?:token|password|passwd|secret|api-key|apikey|webhook-key)(?:\s*=\s*|[ \t]+))(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"` + "`" + `;|&)]+)`)
	jsonSecretRe        = regexp.MustCompile(`(?i)("(?:[a-z0-9_]*_)?(?:password|passwd|token|secret|api_?key|webhook_?key|access_?token|auth_?token|private_?key|encryption_?key)"\s*:\s*")((?:[^"\\\r\n]|\\.)*)(")`)
	secretJSONKeyNameRe = regexp.MustCompile(`(?i)^(?:[a-z0-9_]*_)?(?:password|passwd|token|secret|api_?key|webhook_?key|access_?token|auth_?token|private_?key|encryption_?key)$`)
	kvSecretRe         = regexp.MustCompile(`(?i)\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|WEBHOOK_?KEY|PRIVATE_?KEY|ENCRYPTION_?KEY)\s*[:=]\s*)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"` + "`" + `;|&]+)`)
	isoDateRe          = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)
	lettersOnlyRe      = regexp.MustCompile(`^[A-Za-z]+$`)
	hasAlnumRe         = regexp.MustCompile(`[A-Za-z0-9]`)
	placeholderWords   = map[string]bool{"true": true, "false": true, "null": true, "none": true, "env": true, "file": true, "flag": true, "__missing__": true}
)

func unwrapQuote(raw string) (quote, inner string, quoted bool) {
	if len(raw) >= 4 && strings.HasPrefix(raw, `\"`) && strings.HasSuffix(raw, `\"`) {
		return `\"`, raw[2 : len(raw)-2], true
	}
	if len(raw) >= 2 && ((raw[0] == '"' && raw[len(raw)-1] == '"') || (raw[0] == '\'' && raw[len(raw)-1] == '\'')) {
		return raw[:1], raw[1 : len(raw)-1], true
	}
	return "", raw, false
}

func isPlaceholderValue(raw string) bool {
	_, inner, _ := unwrapQuote(strings.TrimSpace(raw))
	trimmed := strings.TrimSpace(inner)
	if trimmed == "" || trimmed == "[REDACTED]" || trimmed == "[REDACTED_PRIVATE_KEY]" ||
		(len(trimmed) == len("ahub_cli_[REDACTED]") && strings.HasPrefix(trimmed, "ahub_") && strings.HasSuffix(trimmed, "_[REDACTED]")) ||
		strings.HasPrefix(trimmed, "$") || (strings.HasPrefix(trimmed, "<") && strings.HasSuffix(trimmed, ">")) {
		return true
	}
	return placeholderWords[strings.ToLower(trimmed)]
}

func looksLikeBearerToken(val string) bool {
	if isPlaceholderValue(val) || isoDateRe.MatchString(val) || !hasAlnumRe.MatchString(val) {
		return false
	}
	if lettersOnlyRe.MatchString(val) {
		return len(val) >= 24 && strings.ToLower(val) != val && strings.ToUpper(val) != val
	}
	return true
}

func splitTrailingEscape(raw, full string, endIdx int) (string, string) {
	if strings.HasSuffix(raw, `\`) && endIdx < len(full) && (full[endIdx] == '"' || full[endIdx] == '\'') {
		return raw[:len(raw)-1], `\`
	}
	return raw, ""
}

func findPemMarkerEnd(input string, from, prefixLen int) int {
	sub := input[from+prefixLen:]
	rel := strings.Index(sub, pemSuffix)
	if rel < 0 || rel > 64 {
		return -1
	}
	for i := 0; i < rel; i++ {
		if c := sub[i]; !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ' ') {
			return -1
		}
	}
	return from + prefixLen + rel + len(pemSuffix)
}

func findPemFooterEnd(input string, from int) int {
	for endSearch := from; endSearch < len(input); {
		relEnd := strings.Index(input[endSearch:], pemEnd)
		if relEnd < 0 {
			return -1
		}
		endIdx := endSearch + relEnd
		if candEnd := findPemMarkerEnd(input, endIdx, len(pemEnd)); candEnd >= 0 {
			return candEnd
		}
		endSearch = endIdx + len(pemEnd)
	}
	return -1
}

func redactPemPrivateKeys(input string) string {
	if !strings.Contains(input, pemBegin) {
		return input
	}
	var b strings.Builder
	pos := 0
	for searchFrom := 0; searchFrom < len(input); {
		relBegin := strings.Index(input[searchFrom:], pemBegin)
		if relBegin < 0 {
			break
		}
		beginIdx := searchFrom + relBegin
		hdrEnd := findPemMarkerEnd(input, beginIdx, len(pemBegin))
		if hdrEnd < 0 {
			searchFrom = beginIdx + len(pemBegin)
			continue
		}
		footerEnd := findPemFooterEnd(input, hdrEnd)
		if footerEnd < 0 {
			break
		}
		b.WriteString(input[pos:beginIdx])
		b.WriteString("[REDACTED_PRIVATE_KEY]")
		pos, searchFrom = footerEnd, footerEnd
	}
	if pos == 0 {
		return input
	}
	b.WriteString(input[pos:])
	return b.String()
}

func replaceMatches(re *regexp.Regexp, src string, fn func(loc []int) string) string {
	idxs := re.FindAllStringSubmatchIndex(src, -1)
	if len(idxs) == 0 {
		return src
	}
	var b strings.Builder
	last := 0
	for _, loc := range idxs {
		b.WriteString(src[last:loc[0]])
		b.WriteString(fn(loc))
		last = loc[1]
	}
	b.WriteString(src[last:])
	return b.String()
}

func isCurlPlaceholder(core string) bool {
	idx := strings.IndexByte(core, ':')
	return strings.HasSuffix(core, ":[REDACTED]") || (idx >= 0 && isPlaceholderValue(core[idx+1:]))
}

func maskPrefixVal(src string, re *regexp.Regexp, skipFlag, checkCurl, skipHasToken bool) string {
	return replaceMatches(re, src, func(loc []int) string {
		prefix, rawVal := src[loc[2]:loc[3]], src[loc[4]:loc[5]]
		if skipHasToken && strings.EqualFold(strings.TrimRight(prefix, ":= \t"), "has_token") {
			return src[loc[0]:loc[1]]
		}
		quote, core, quoted := unwrapQuote(rawVal)
		tail := ""
		if !quoted {
			core, tail = splitTrailingEscape(rawVal, src, loc[1])
		}
		if core == "" || isPlaceholderValue(core) || (skipFlag && !quoted && strings.HasPrefix(core, "-")) || (checkCurl && isCurlPlaceholder(core)) {
			return src[loc[0]:loc[1]]
		}
		return prefix + quote + "[REDACTED]" + quote + tail
	})
}

func hasAnySub(s string, needles ...string) bool {
	for _, n := range needles {
		if strings.Contains(s, n) {
			return true
		}
	}
	return false
}

// Text masks tokens, passwords, private keys, and credential assignments while preserving placeholders.
func Text(input string) string {
	if input == "" {
		return ""
	}
	out := redactPemPrivateKeys(input)
	if strings.Contains(out, "ahub_") {
		out = ahubTokenRe.ReplaceAllString(out, "ahub_${1}_[REDACTED]")
	}
	if strings.Contains(out, "://") && strings.Contains(out, "@") {
		out = replaceMatches(urlUserInfoRe, out, func(loc []int) string {
			creds := out[loc[4]:loc[5]]
			if isPlaceholderValue(creds[strings.IndexByte(creds, ':')+1:]) {
				return out[loc[0]:loc[1]]
			}
			return out[loc[2]:loc[3]] + "[REDACTED]@"
		})
	}
	if hasAnySub(out, "sk-", "xai-", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "AIza", "whsec_", "xox") {
		out = knownPrefixRe.ReplaceAllString(out, "[REDACTED]")
	}
	lower := strings.ToLower(out)
	hasKeyWord := hasAnySub(lower, "pass", "token", "secret", "key")
	if hasKeyWord && strings.Contains(out, "=") && strings.ContainsAny(out, "?&") {
		out = maskPrefixVal(out, querySecretRe, false, false, false)
	}
	if strings.Contains(out, ":") && strings.Contains(lower, "authorization") {
		out = maskPrefixVal(out, authHeaderRe, false, false, false)
	}
	if hasKeyWord && strings.Contains(out, ":") {
		out = maskPrefixVal(out, httpHeaderSecretRe, false, false, false)
	}
	if strings.Contains(lower, "bearer") {
		out = replaceMatches(bearerRe, out, func(loc []int) string {
			if core, tail := splitTrailingEscape(out[loc[6]:loc[7]], out, loc[1]); looksLikeBearerToken(core) {
				return "Bearer [REDACTED]" + tail
			}
			return out[loc[0]:loc[1]]
		})
	}
	if strings.Contains(out, "curl") {
		out = curlLineRe.ReplaceAllStringFunc(out, func(line string) string {
			return maskPrefixVal(line, curlUserFlagRe, true, true, false)
		})
	}
	if hasKeyWord && strings.Contains(out, "--") {
		out = maskPrefixVal(out, cliFlagSecretRe, true, false, false)
	}
	if strings.Contains(out, `"`) && strings.Contains(out, `:`) && hasKeyWord {
		out = replaceMatches(jsonSecretRe, out, func(loc []int) string {
			key := out[loc[2]:loc[3]]
			if !strings.Contains(strings.ToLower(key), `"has_token"`) && !isPlaceholderValue(out[loc[4]:loc[5]]) {
				return key + "[REDACTED]" + out[loc[6]:loc[7]]
			}
			return out[loc[0]:loc[1]]
		})
	}
	if hasKeyWord && strings.ContainsAny(out, ":=") {
		out = maskPrefixVal(out, kvSecretRe, false, false, true)
	}
	return out
}

// Value recursively redacts string leaves and sensitive map keys in decoded JSON values
// while preserving placeholders ($VAR, <PLACEHOLDER>), has_token, json.Number, bools, and numbers.
func Value(v interface{}) interface{} {
	switch val := v.(type) {
	case nil:
		return nil
	case string:
		return Text(val)
	case map[string]interface{}:
		return Map(val)
	case map[string]string:
		if val == nil {
			return nil
		}
		out := make(map[string]string, len(val))
		for k, s := range val {
			out[k] = redactNamedString(k, s)
		}
		return out
	case []interface{}:
		if val == nil {
			return nil
		}
		out := make([]interface{}, len(val))
		for i, item := range val {
			out[i] = Value(item)
		}
		return out
	case []string:
		if val == nil {
			return nil
		}
		out := make([]string, len(val))
		for i, item := range val {
			out[i] = Text(item)
		}
		return out
	case json.Number:
		return val
	default:
		return val
	}
}

// Map recursively redacts a JSON object map's string leaves and sensitive key names.
func Map(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return nil
	}
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		if s, ok := v.(string); ok {
			out[k] = redactNamedString(k, s)
			continue
		}
		out[k] = Value(v)
	}
	return out
}

func redactNamedString(key, val string) string {
	redacted := Text(val)
	if !strings.EqualFold(key, "has_token") &&
		secretJSONKeyNameRe.MatchString(key) &&
		redacted != "" &&
		!isPlaceholderValue(redacted) {
		return "[REDACTED]"
	}
	return redacted
}

// TruncateUTF8 bounds s to at most maxBytes on a valid UTF-8 rune boundary.
func TruncateUTF8(s string, maxBytes int) (string, bool) {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s, false
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "\n...[truncated; pass --full for full prompt]", true
}
