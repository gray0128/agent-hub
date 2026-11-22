const AHUB_TOKEN_RE = /\bahub_(adm|cli|nod)_[A-Za-z0-9_-]{6,}/g;
const URL_USERINFO_RE = /(https?:\/\/)([^/\s:@]+:[^/\s@]+)@/g;
const KNOWN_PREFIX_RE =
  /\b(?:sk-proj-|sk-live-|sk-test-|sk-|xai-|ghp_|gho_|ghu_|ghs_|github_pat_|AIza|whsec_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g;
const QUERY_SECRET_RE =
  /([?&](?:token|key|secret|password|passwd|access_token|api_key|webhook_key)=)([^&\s'"`#]+)/gi;
const AUTH_HEADER_RE =
  /(authorization\s*:\s*(?:bearer|basic)[ \t]+)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"`]+)/gi;
const HTTP_HEADER_SECRET_RE =
  /(\b(?:x-api-key|api-key|x-auth-token|x-access-token|x-webhook-key|cf-access-client-secret)\s*:\s*)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"`]+)/gi;
const BEARER_RE = /\b(bearer)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;
const CURL_LINE_RE = /^[^\r\n]*\bcurl\b[^\r\n]*$/gm;
const CURL_USER_FLAG_RE =
  /(^|[\s;|&(])(-[A-Za-z]*u|--user|--proxy-user)(=|[ \t]+)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"`;|&]+)/g;
const CLI_FLAG_SECRET_RE =
  /(^|[\s;|&(])(--(?:[a-z0-9-]+-)?(?:token|password|passwd|secret|api-key|apikey|webhook-key))(\s*=\s*|[ \t]+)(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"`;|&)]+)/gi;
const JSON_SECRET_RE =
  /("(?:[a-z0-9_]*_)?(?:password|passwd|token|secret|api_?key|webhook_?key|access_?token|auth_?token|private_?key|encryption_?key)"\s*:\s*")((?:[^"\\\r\n]|\\.)*)(")/gi;
const SECRET_JSON_KEY_RE =
  /^(?:[a-z0-9_]*_)?(?:password|passwd|token|secret|api_?key|webhook_?key|access_?token|auth_?token|private_?key|encryption_?key)$/i;
const KV_SECRET_RE =
  /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|WEBHOOK_?KEY|PRIVATE_?KEY|ENCRYPTION_?KEY))\s*([:=])\s*(\\"(?:[^"\\\r\n]|\\[^"\r\n])*\\"|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s'"`;|&]+)/gi;

const PLACEHOLDER_WORDS = new Set(["true", "false", "null", "none", "env", "file", "flag", "__missing__"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const LETTERS_ONLY_RE = /^[A-Za-z]+$/;
const HAS_ALNUM_RE = /[A-Za-z0-9]/;
const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_SUFFIX = "PRIVATE KEY-----";

function unwrapQuote(raw: string): { quote: string; inner: string; quoted: boolean } {
  if (raw.startsWith('\\"') && raw.endsWith('\\"') && raw.length >= 4) {
    return { quote: '\\"', inner: raw.slice(2, -2), quoted: true };
  }
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return { quote: raw[0]!, inner: raw.slice(1, -1), quoted: true };
  }
  return { quote: "", inner: raw, quoted: false };
}

function isPlaceholderValue(raw: string): boolean {
  const { inner } = unwrapQuote(raw.trim());
  const trimmed = inner.trim();
  if (!trimmed || trimmed === "[REDACTED]" || trimmed === "[REDACTED_PRIVATE_KEY]") {
    return true;
  }
  if (/^ahub_(?:adm|cli|nod)_\[REDACTED\]$/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("$") || (trimmed.startsWith("<") && trimmed.endsWith(">"))) {
    return true;
  }
  return PLACEHOLDER_WORDS.has(trimmed.toLowerCase());
}

function looksLikeBearerToken(val: string): boolean {
  if (isPlaceholderValue(val) || ISO_DATE_RE.test(val) || !HAS_ALNUM_RE.test(val)) {
    return false;
  }
  if (LETTERS_ONLY_RE.test(val)) {
    return val.length >= 24 && /[A-Z]/.test(val) && /[a-z]/.test(val);
  }
  return true;
}

function splitTrailingEscape(raw: string, full: string, endOffset: number): { core: string; tail: string } {
  if (raw.endsWith("\\") && (full[endOffset] === '"' || full[endOffset] === "'")) {
    return { core: raw.slice(0, -1), tail: "\\" };
  }
  return { core: raw, tail: "" };
}

function isPemLabelChars(s: string): boolean {
  if (s.length > 64) return false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const ok = (ch >= 65 && ch <= 90) || (ch >= 48 && ch <= 57) || ch === 32;
    if (!ok) return false;
  }
  return true;
}

function findPemMarkerEnd(input: string, from: number, prefixLen: number): number {
  const sufIdx = input.indexOf(PEM_SUFFIX, from + prefixLen);
  if (sufIdx === -1) return -1;
  if (!isPemLabelChars(input.slice(from + prefixLen, sufIdx))) return -1;
  return sufIdx + PEM_SUFFIX.length;
}

function redactPemPrivateKeys(input: string): string {
  if (!input.includes(PEM_BEGIN)) return input;
  const parts: string[] = [];
  let pos = 0;
  let searchFrom = 0;
  while (searchFrom < input.length) {
    const beginIdx = input.indexOf(PEM_BEGIN, searchFrom);
    if (beginIdx === -1) break;
    const hdrEnd = findPemMarkerEnd(input, beginIdx, PEM_BEGIN.length);
    if (hdrEnd === -1) {
      searchFrom = beginIdx + PEM_BEGIN.length;
      continue;
    }
    let endSearch = hdrEnd;
    let footerEnd = -1;
    while (endSearch < input.length) {
      const endIdx = input.indexOf(PEM_END, endSearch);
      if (endIdx === -1) break;
      const candEnd = findPemMarkerEnd(input, endIdx, PEM_END.length);
      if (candEnd !== -1) {
        footerEnd = candEnd;
        break;
      }
      endSearch = endIdx + PEM_END.length;
    }
    if (footerEnd === -1) break;
    parts.push(input.slice(pos, beginIdx), "[REDACTED_PRIVATE_KEY]");
    pos = footerEnd;
    searchFrom = footerEnd;
  }
  if (pos === 0) return input;
  parts.push(input.slice(pos));
  return parts.join("");
}

function redactHeaderValue(prefix: string, rawVal: string, offset: number, full: string, match: string): string {
  const { quote, inner, quoted } = unwrapQuote(rawVal);
  if (quoted) {
    if (isPlaceholderValue(inner)) return match;
    return `${prefix}${quote}[REDACTED]${quote}`;
  }
  const { core, tail } = splitTrailingEscape(rawVal, full, offset + match.length);
  if (!core || isPlaceholderValue(core)) return match;
  return `${prefix}[REDACTED]${tail}`;
}

export function redactSecrets(input: string): string {
  if (!input) return "";
  let out = redactPemPrivateKeys(input);
  out = out.replace(AHUB_TOKEN_RE, (_m, scope: string) => `ahub_${scope}_[REDACTED]`);
  out = out.replace(URL_USERINFO_RE, (m, scheme: string, creds: string) => {
    const colon = creds.indexOf(":");
    const pass = colon >= 0 ? creds.slice(colon + 1) : creds;
    return isPlaceholderValue(pass) ? m : `${scheme}[REDACTED]@`;
  });
  out = out.replace(KNOWN_PREFIX_RE, "[REDACTED]");
  out = out.replace(QUERY_SECRET_RE, (m, prefix: string, val: string, offset: number, full: string) => {
    const { core, tail } = splitTrailingEscape(val, full, offset + m.length);
    return !core || isPlaceholderValue(core) ? m : `${prefix}[REDACTED]${tail}`;
  });
  out = out.replace(AUTH_HEADER_RE, (m, prefix: string, val: string, offset: number, full: string) =>
    redactHeaderValue(prefix, val, offset, full, m)
  );
  out = out.replace(HTTP_HEADER_SECRET_RE, (m, prefix: string, val: string, offset: number, full: string) =>
    redactHeaderValue(prefix, val, offset, full, m)
  );
  out = out.replace(BEARER_RE, (m, _kw: string, _ws: string, val: string, offset: number, full: string) => {
    const { core, tail } = splitTrailingEscape(val, full, offset + m.length);
    return !looksLikeBearerToken(core) ? m : `Bearer [REDACTED]${tail}`;
  });
  out = out.replace(CURL_LINE_RE, (line) =>
    line.replace(CURL_USER_FLAG_RE, (m, lead: string, flag: string, sep: string, val: string, offset: number, full: string) => {
      const { quote, inner, quoted } = unwrapQuote(val);
      const { core, tail } = quoted ? { core: inner, tail: "" } : splitTrailingEscape(val, full, offset + m.length);
      if (!core || isPlaceholderValue(core) || core.endsWith(":[REDACTED]")) return m;
      const colon = core.indexOf(":");
      if (colon >= 0 && isPlaceholderValue(core.slice(colon + 1))) return m;
      if (!quoted && core.startsWith("-")) return m;
      return `${lead}${flag}${sep}${quote}[REDACTED]${quote}${tail}`;
    })
  );
  out = out.replace(CLI_FLAG_SECRET_RE, (m, lead: string, flag: string, sep: string, val: string, offset: number, full: string) => {
    const { quote, inner, quoted } = unwrapQuote(val);
    const { core, tail } = quoted ? { core: inner, tail: "" } : splitTrailingEscape(val, full, offset + m.length);
    if (!core || isPlaceholderValue(core) || (!quoted && core.startsWith("-"))) return m;
    return `${lead}${flag}${sep}${quote}[REDACTED]${quote}${tail}`;
  });
  out = out.replace(JSON_SECRET_RE, (m, prefix: string, val: string, suffix: string) => {
    const key = prefix.toLowerCase();
    if (key.includes('"has_token"') || isPlaceholderValue(val)) return m;
    return `${prefix}[REDACTED]${suffix}`;
  });
  out = out.replace(KV_SECRET_RE, (m, key: string, sep: string, val: string, offset: number, full: string) => {
    if (key.toLowerCase() === "has_token") return m;
    const { quote, inner, quoted } = unwrapQuote(val);
    const { core, tail } = quoted ? { core: inner, tail: "" } : splitTrailingEscape(val, full, offset + m.length);
    if (!core || isPlaceholderValue(core)) return m;
    return `${key}${sep}${quote}[REDACTED]${quote}${tail}`;
  });
  return out;
}

export function buildPromptPreview(
  prompt: string,
  maxChars = 1200
): { promptPreview: string; promptTruncated: boolean } {
  const redacted = redactSecrets(prompt);
  const chars = Array.from(redacted);
  if (chars.length <= maxChars) {
    return { promptPreview: redacted, promptTruncated: false };
  }
  return {
    promptPreview: `${chars.slice(0, maxChars).join("")}\n...[truncated]`,
    promptTruncated: true
  };
}

function redactNamedString(key: string, val: string): string {
  const redacted = redactSecrets(val);
  if (
    key.toLowerCase() !== "has_token" &&
    SECRET_JSON_KEY_RE.test(key) &&
    redacted !== "" &&
    !isPlaceholderValue(redacted)
  ) {
    return "[REDACTED]";
  }
  return redacted;
}

export function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const ancestors = new WeakSet<object>();
  const cloned = new WeakMap<object, unknown>();
  const holder: { root: unknown } = { root: undefined };

  type StackTask =
    | { kind: "exit"; source: object }
    | {
        kind: "visit";
        val: unknown;
        keyName: string | null;
        assign: (redacted: unknown) => void;
      };

  const stack: StackTask[] = [
    {
      kind: "visit",
      val: value,
      keyName: null,
      assign: (redacted) => {
        holder.root = redacted;
      }
    }
  ];

  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.kind === "exit") {
      ancestors.delete(task.source);
      continue;
    }

    const { val, keyName, assign } = task;
    if (typeof val === "string") {
      assign(keyName !== null ? redactNamedString(keyName, val) : redactSecrets(val));
      continue;
    }
    if (val === null || typeof val !== "object") {
      assign(val);
      continue;
    }
    if (ancestors.has(val)) {
      assign("[Circular]");
      continue;
    }
    if (cloned.has(val)) {
      assign(cloned.get(val));
      continue;
    }

    ancestors.add(val);
    if (Array.isArray(val)) {
      const outArr = new Array<unknown>(val.length);
      cloned.set(val, outArr);
      assign(outArr);
      stack.push({ kind: "exit", source: val });
      for (let i = val.length - 1; i >= 0; i--) {
        const idx = i;
        stack.push({
          kind: "visit",
          val: val[idx],
          keyName: null,
          assign: (redacted) => {
            outArr[idx] = redacted;
          }
        });
      }
    } else {
      const outObj: Record<string, unknown> = {};
      cloned.set(val, outObj);
      assign(outObj);
      stack.push({ kind: "exit", source: val });
      const entries = Object.entries(val);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, childVal] = entries[i]!;
        stack.push({
          kind: "visit",
          val: childVal,
          keyName: k,
          assign: (redacted) => {
            Object.defineProperty(outObj, k, {
              value: redacted,
              enumerable: true,
              writable: true,
              configurable: true
            });
          }
        });
      }
    }
  }

  return holder.root;
}

export function redactBoardData(data: Record<string, unknown>): Record<string, unknown> {
  return redactJsonValue(data) as Record<string, unknown>;
}
