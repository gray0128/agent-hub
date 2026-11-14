const PREFIX_V1 = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface WebhookConfig {
  url: string;
  key?: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!value || /[^A-Za-z0-9\-_]/.test(value)) {
    throw new Error("Invalid base64url segment");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isLocalHttpHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "[::1]" ||
    lower === "::1" ||
    lower.endsWith(".localhost")
  );
}

export function validateWebhookUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("webhook_url must not be empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("webhook_url must be a valid URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("webhook_url must not include embedded credentials");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && isLocalHttpHostname(parsed.hostname)) {
    return parsed;
  }
  throw new Error("webhook_url must use https:// (http:// is allowed only for localhost/127.0.0.1)");
}

async function deriveAesKey(
  secretMaterial: string,
  usages: ("encrypt" | "decrypt")[]
): Promise<CryptoKey> {
  const trimmed = secretMaterial.trim();
  if (!trimmed) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY is not configured");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(trimmed));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

export async function encryptWebhookConfig(
  secretMaterial: string,
  payload: WebhookConfig
): Promise<{ ciphertext: string; host: string }> {
  const parsedUrl = validateWebhookUrl(payload.url);
  const trimmedKey = payload.key?.trim();
  const normalized: WebhookConfig = {
    url: parsedUrl.toString(),
    ...(trimmedKey ? { key: trimmedKey } : {})
  };
  const aesKey = await deriveAesKey(secretMaterial, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(JSON.stringify(normalized))
  );
  return {
    ciphertext: `${PREFIX_V1}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`,
    host: parsedUrl.host
  };
}

export async function decryptWebhookConfig(
  secretMaterial: string,
  ciphertext: string
): Promise<WebhookConfig> {
  const parts = ciphertext.trim().split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX_V1) {
    throw new Error("Unsupported encrypted webhook payload format");
  }
  const iv = fromBase64Url(parts[1]!);
  const encryptedBytes = fromBase64Url(parts[2]!);
  if (iv.length !== 12 || encryptedBytes.length === 0) {
    throw new Error("Malformed encrypted webhook payload");
  }
  const aesKey = await deriveAesKey(secretMaterial, ["decrypt"]);
  const ivBuf = new Uint8Array(iv.length);
  ivBuf.set(iv);
  const ctBuf = new Uint8Array(encryptedBytes.length);
  ctBuf.set(encryptedBytes);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf },
    aesKey,
    ctBuf
  );
  const raw = JSON.parse(decoder.decode(decrypted)) as unknown;
  if (!raw || typeof raw !== "object" || typeof (raw as { url?: unknown }).url !== "string") {
    throw new Error("Decrypted webhook payload missing url");
  }
  const parsedUrl = validateWebhookUrl((raw as { url: string }).url);
  const rawKey = (raw as { key?: unknown }).key;
  const trimmedKey = typeof rawKey === "string" ? rawKey.trim() : "";
  return {
    url: parsedUrl.toString(),
    ...(trimmedKey ? { key: trimmedKey } : {})
  };
}
