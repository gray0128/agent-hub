const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newUlid(): string {
  const now = Date.now();
  let tsPart = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    tsPart = CROCKFORD[t % 32] + tsPart;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let randPart = "";
  // Encode 80 random bits as 16 Crockford base32 characters
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randPart += CROCKFORD[(buffer >> bits) & 31];
    }
  }
  return tsPart + randPart;
}

export function newId(prefix: "key" | "thr" | "run"): string {
  return `${prefix}_${newUlid()}`;
}

export function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `${prefix}${hex}`;
}

export function sanitizeTailPreview(text: string, tailBytes: number): {
  preview: string;
  truncated: boolean;
  totalBytes: number;
} {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const totalBytes = bytes.length;
  if (totalBytes <= tailBytes) {
    return { preview: text, truncated: false, totalBytes };
  }
  let start = totalBytes - tailBytes;
  // Advance past UTF-8 continuation bytes (10xxxxxx) to avoid splitting a multi-byte char.
  while (start < totalBytes && (bytes[start]! & 0b1100_0000) === 0b1000_0000) {
    start++;
  }
  const preview = new TextDecoder().decode(bytes.subarray(start));
  return { preview, truncated: true, totalBytes };
}

export function truncateUtf8Bytes(text: string, maxBytes: number): {
  value: string;
  originalBytes: number;
} {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const originalBytes = bytes.length;
  if (originalBytes <= maxBytes) {
    return { value: text, originalBytes };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
    end--;
  }
  return {
    value: new TextDecoder().decode(bytes.subarray(0, end)),
    originalBytes
  };
}
