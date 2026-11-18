import { fromBase64Url, toBase64Url } from "./webhook-crypto";

export interface WebPushEnvLike {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  ALLOW_LOOPBACK_PUSH_FOR_TEST?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateJwk: string;
  subject: string;
}

export interface WebPushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface WebPushSubscriptionTarget {
  endpoint: string;
  keys: WebPushSubscriptionKeys;
}

export interface WebPushNotificationPayload {
  v: 1;
  kind: "native_event" | "run" | "test";
  id: string;
  tag: string;
  urgent: boolean;
  title: string;
  body: string;
  target_url: string;
  ts: string;
}

export type WebPushOutcome = "sent" | "expired" | "rejected" | "retry";

export interface WebPushSendResult {
  ok: boolean;
  outcome: WebPushOutcome;
  retryable: boolean;
  revokeSubscription: boolean;
  httpStatus: number | null;
  errorCode: string;
  errorMessage: string;
}

export interface SendWebPushOptions {
  subscription: WebPushSubscriptionTarget;
  payload: WebPushNotificationPayload;
  vapid: VapidConfig;
  urgency?: "high" | "normal";
  ttlSeconds?: number;
  timeoutMs?: number;
  allowLoopbackForTest?: boolean;
  fetchImpl?: typeof fetch;
}

const encoder = new TextEncoder();
const MAX_ENCRYPTED_PLAINTEXT_BYTES = 3072;
const MAX_VAPID_TTL_SECONDS = 12 * 3600;

function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  return toOwnedBytes(encoder.encode(text));
}

function decodeBase64Url(value: string, label: string): Uint8Array<ArrayBuffer> {
  try {
    return fromBase64Url(value.trim());
  } catch {
    throw new Error(`Invalid base64url encoding for ${label}.`);
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

function isAllowedPushVendorHost(hostname: string): boolean {
  if (hostname === "fcm.googleapis.com") {
    return true;
  }
  const suffixAllowlist = [
    ".push.apple.com",
    ".push.services.mozilla.com",
    ".notify.windows.com"
  ];
  for (const suffix of suffixAllowlist) {
    if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
      return true;
    }
  }
  return false;
}

export function isLoopbackPushAllowed(env: WebPushEnvLike): boolean {
  return env.ALLOW_LOOPBACK_PUSH_FOR_TEST === "true";
}

export function validatePushEndpointUrl(rawUrl: string, allowLoopbackForTest = false): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("Push endpoint URL must not be empty.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Push endpoint URL must be a valid URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Push endpoint URL must not include embedded credentials.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    allowLoopbackForTest &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  ) {
    return parsed;
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Push endpoint URL must use https://.");
  }
  if (parsed.port !== "") {
    throw new Error("Push endpoint URL must not specify a custom port.");
  }
  if (!hostname || hostname.endsWith(".") || !hostname.split(".").every((label) => label.length > 0)) {
    throw new Error("Push endpoint host is malformed.");
  }
  if (!isAllowedPushVendorHost(hostname)) {
    throw new Error("Push endpoint host is not in the allowed Web Push vendor allowlist.");
  }
  return parsed;
}

export function validateSubscriptionKeys(keys: WebPushSubscriptionKeys): {
  uaPublicBytes: Uint8Array<ArrayBuffer>;
  authBytes: Uint8Array<ArrayBuffer>;
} {
  const uaPublicBytes = decodeBase64Url(keys.p256dh, "subscription.keys.p256dh");
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 0x04) {
    throw new Error("Invalid p256dh public key: expected 65-byte uncompressed P-256 point.");
  }
  const authBytes = decodeBase64Url(keys.auth, "subscription.keys.auth");
  if (authBytes.length !== 16) {
    throw new Error("Invalid auth secret: expected 16 bytes.");
  }
  return { uaPublicBytes, authBytes };
}

export function getVapidConfig(
  env: WebPushEnvLike
): { enabled: true; config: VapidConfig } | { enabled: false; reason: "VAPID_NOT_CONFIGURED" } {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateJwk = env.VAPID_PRIVATE_JWK?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey || !privateJwk || !subject) {
    return { enabled: false, reason: "VAPID_NOT_CONFIGURED" };
  }
  return {
    enabled: true,
    config: {
      publicKey,
      privateJwk,
      subject
    }
  };
}

interface NormalizedVapidJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

function validateVapidSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.startsWith("mailto:")) {
    const addr = trimmed.slice("mailto:".length).trim();
    const atIdx = addr.indexOf("@");
    if (atIdx <= 0 || addr.indexOf("@", atIdx + 1) !== -1 || /\s/.test(addr)) {
      throw new Error("VAPID_SUBJECT mailto: address must be valid.");
    }
    const local = addr.slice(0, atIdx);
    const domain = addr.slice(atIdx + 1);
    if (
      !local ||
      !domain ||
      domain.startsWith(".") ||
      domain.endsWith(".") ||
      (!domain.includes(".") && domain !== "localhost")
    ) {
      throw new Error("VAPID_SUBJECT mailto: address must be valid.");
    }
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("VAPID_SUBJECT must be a mailto: or https:// URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("VAPID_SUBJECT must use mailto: or https://.");
  }
  return trimmed;
}

export function parseAndValidateVapidConfig(config: VapidConfig): {
  publicKey: string;
  jwk: NormalizedVapidJwk;
  subject: string;
} {
  const publicKey = config.publicKey.trim();
  const publicBytes = decodeBase64Url(publicKey, "VAPID_PUBLIC_KEY");
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point.");
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(config.privateJwk);
  } catch {
    throw new Error("VAPID_PRIVATE_JWK must be valid JSON.");
  }
  if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
    throw new Error("VAPID_PRIVATE_JWK must be a JSON object.");
  }
  const jwkObj = parsedRaw as Record<string, unknown>;
  if (
    jwkObj.kty !== "EC" ||
    jwkObj.crv !== "P-256" ||
    typeof jwkObj.x !== "string" ||
    typeof jwkObj.y !== "string" ||
    typeof jwkObj.d !== "string"
  ) {
    throw new Error("VAPID_PRIVATE_JWK must be an EC P-256 private JWK with x, y, and d.");
  }

  const xBytes = decodeBase64Url(jwkObj.x, "VAPID_PRIVATE_JWK.x");
  const yBytes = decodeBase64Url(jwkObj.y, "VAPID_PRIVATE_JWK.y");
  const dBytes = decodeBase64Url(jwkObj.d, "VAPID_PRIVATE_JWK.d");
  if (xBytes.length !== 32 || yBytes.length !== 32 || dBytes.length !== 32) {
    throw new Error("VAPID_PRIVATE_JWK x, y, and d coordinates must each be 32 bytes.");
  }

  const expectedPub = concatBytes(new Uint8Array([0x04]), xBytes, yBytes);
  if (!constantTimeBytesEqual(expectedPub, publicBytes)) {
    throw new Error("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_JWK coordinates.");
  }

  const subject = validateVapidSubject(config.subject);
  return {
    publicKey,
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: jwkObj.x.trim(),
      y: jwkObj.y.trim(),
      d: jwkObj.d.trim()
    },
    subject
  };
}

export async function createVapidAuthorizationHeader(
  endpointUrl: URL,
  vapid: VapidConfig,
  opts?: { nowMs?: number; ttlSeconds?: number }
): Promise<string> {
  const validated = parseAndValidateVapidConfig(vapid);
  const nowSec = Math.floor((opts?.nowMs ?? Date.now()) / 1000);
  const ttlSeconds = opts?.ttlSeconds ?? MAX_VAPID_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_VAPID_TTL_SECONDS) {
    throw new Error(`VAPID JWT ttlSeconds must be an integer between 1 and ${MAX_VAPID_TTL_SECONDS}.`);
  }

  const headerB64 = toBase64Url(encodeUtf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payloadB64 = toBase64Url(
    encodeUtf8(
      JSON.stringify({
        aud: endpointUrl.origin,
        exp: nowSec + ttlSeconds,
        sub: validated.subject
      })
    )
  );
  const signingInput = encodeUtf8(`${headerB64}.${payloadB64}`);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    validated.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signingInput)
  );
  if (sigBytes.length !== 64) {
    throw new Error("Unexpected ECDSA P-256 signature length.");
  }
  const jwt = `${headerB64}.${payloadB64}.${toBase64Url(sigBytes)}`;
  return `vapid t=${jwt}, k=${validated.publicKey}`;
}

function utf8JsonBytes(payload: WebPushNotificationPayload): Uint8Array<ArrayBuffer> {
  return encodeUtf8(JSON.stringify(payload));
}

function trimFieldToFit(
  field: "body" | "title",
  basePayload: WebPushNotificationPayload,
  maxBytes: number
): WebPushNotificationPayload {
  if (utf8JsonBytes(basePayload).length <= maxBytes) {
    return basePayload;
  }
  const codePoints = Array.from(basePayload[field]);
  if (codePoints.length === 0) {
    return basePayload;
  }
  const fitsEllipsis = utf8JsonBytes({ ...basePayload, [field]: "..." }).length <= maxBytes;
  const suffix = fitsEllipsis ? "..." : "";

  let lo = 0;
  let hi = codePoints.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = mid === 0 ? "" : codePoints.slice(0, mid).join("") + suffix;
    if (utf8JsonBytes({ ...basePayload, [field]: candidate }).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const trimmed = lo === 0 ? "" : codePoints.slice(0, lo).join("") + suffix;
  return {
    ...basePayload,
    [field]: trimmed
  };
}

export function encodePushPayload(
  payload: WebPushNotificationPayload,
  maxBytes = MAX_ENCRYPTED_PLAINTEXT_BYTES
): Uint8Array<ArrayBuffer> {
  const initial = utf8JsonBytes(payload);
  if (initial.length <= maxBytes) {
    return initial;
  }

  let candidate = trimFieldToFit("body", payload, maxBytes);
  let encoded = utf8JsonBytes(candidate);
  if (encoded.length <= maxBytes) {
    return encoded;
  }

  candidate = trimFieldToFit("title", candidate, maxBytes);
  encoded = utf8JsonBytes(candidate);
  if (encoded.length <= maxBytes) {
    return encoded;
  }

  candidate = trimFieldToFit("body", { ...candidate, target_url: "/" }, maxBytes);
  candidate = trimFieldToFit("title", candidate, maxBytes);
  encoded = utf8JsonBytes(candidate);
  if (encoded.length <= maxBytes) {
    return encoded;
  }

  throw new Error("Push payload exceeds maximum byte budget.");
}

export async function encryptWebPushPayload(
  plaintext: Uint8Array,
  keys: WebPushSubscriptionKeys
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > 4079) {
    throw new Error("Plaintext exceeds single aes128gcm record limit (4079 bytes).");
  }
  const { uaPublicBytes, authBytes } = validateSubscriptionKeys(keys);
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const asKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )) as CryptoKeyPair;

  const asPublicBytes = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer
  );
  if (asPublicBytes.length !== 65 || asPublicBytes[0] !== 0x04) {
    throw new Error("Failed to export ephemeral P-256 public key.");
  }

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asKeyPair.privateKey,
      256
    )
  );

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  // WebCrypto HKDF deriveBits appends the 0x01 block counter internally, so info strings must NOT end with \x01.
  const keyInfo = concatBytes(encodeUtf8("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ecdhBaseKey = await crypto.subtle.importKey("raw", ecdhSecret, "HKDF", false, ["deriveBits"]);
  const ikmBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: authBytes, info: keyInfo },
      ecdhBaseKey,
      256
    )
  );

  const prkBaseKey = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
  const cekBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: encodeUtf8("Content-Encoding: aes128gcm\0") },
      prkBaseKey,
      128
    )
  );
  const nonceBytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: encodeUtf8("Content-Encoding: nonce\0") },
      prkBaseKey,
      96
    )
  );

  const padded = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext, 0);
  padded[plaintext.length] = 0x02;

  const cekKey = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceBytes }, cekKey, padded)
  );

  const frame = new Uint8Array(86 + ciphertext.length);
  frame.set(salt, 0);
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(16, 4096, false);
  frame[20] = asPublicBytes.length;
  frame.set(asPublicBytes, 21);
  frame.set(ciphertext, 86);
  return frame;
}

async function readConciseErrorBody(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).trim();
    if (!text) return "";
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

export async function sendWebPushNotification(options: SendWebPushOptions): Promise<WebPushSendResult> {
  let parsedUrl: URL;
  let encryptedFrame: Uint8Array<ArrayBuffer>;
  let authHeader: string;
  try {
    parsedUrl = validatePushEndpointUrl(
      options.subscription.endpoint,
      options.allowLoopbackForTest ?? false
    );
    const encodedPayload = encodePushPayload(options.payload, MAX_ENCRYPTED_PLAINTEXT_BYTES);
    encryptedFrame = await encryptWebPushPayload(encodedPayload, options.subscription.keys);
    authHeader = await createVapidAuthorizationHeader(parsedUrl, options.vapid);
  } catch (err) {
    return {
      ok: false,
      outcome: "rejected",
      retryable: false,
      revokeSubscription: false,
      httpStatus: null,
      errorCode: "PUSH_INVALID_INPUT",
      errorMessage: err instanceof Error ? err.message : String(err)
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const urgency = options.urgency ?? (options.payload.urgent ? "high" : "normal");
  const ttlSeconds = options.ttlSeconds ?? 86400;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let resp: Response;
  try {
    resp = await fetchImpl(parsedUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: urgency
      },
      body: encryptedFrame,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return {
      ok: false,
      outcome: "retry",
      retryable: true,
      revokeSubscription: false,
      httpStatus: null,
      errorCode: "PUSH_UPSTREAM_TIMEOUT",
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
    };
  }

  const status = resp.status;
  if (status >= 200 && status < 300) {
    await resp.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      outcome: "sent",
      retryable: false,
      revokeSubscription: false,
      httpStatus: status,
      errorCode: "",
      errorMessage: ""
    };
  }

  const snippet = await readConciseErrorBody(resp);
  if (status === 404 || status === 410) {
    return {
      ok: false,
      outcome: "expired",
      retryable: false,
      revokeSubscription: true,
      httpStatus: status,
      errorCode: "SUBSCRIPTION_EXPIRED",
      errorMessage: snippet || `Push subscription expired (HTTP ${status}).`
    };
  }

  if (status === 408 || status === 429 || status >= 500) {
    return {
      ok: false,
      outcome: "retry",
      retryable: true,
      revokeSubscription: false,
      httpStatus: status,
      errorCode: "PUSH_UPSTREAM_TIMEOUT",
      errorMessage: snippet || `Push upstream returned HTTP ${status}.`
    };
  }

  return {
    ok: false,
    outcome: "rejected",
    retryable: false,
    revokeSubscription: false,
    httpStatus: status,
    errorCode: `PUSH_REJECTED_${status}`,
    errorMessage: snippet || `Push gateway rejected request with HTTP ${status}.`
  };
}
