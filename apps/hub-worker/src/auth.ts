import { type ApiScope, type AuthPrincipal, type Env, HubError } from "./types";
import { constantTimeEqual, nowIso, sha256Hex } from "./ulid";

interface JwkWithKid extends JsonWebKey {
  kid?: string;
}

interface JwksResponse {
  keys: JwkWithKid[];
}

interface AccessJwtPayload {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iss?: string;
  email?: string;
  sub?: string;
}

const jwksCache = new Map<string, { fetchedAt: number; keys: JwkWithKid[] }>();

function decodeBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function getAccessCerts(teamDomain: string): Promise<JwkWithKid[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < 300_000) {
    return cached.keys;
  }
  const base = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/i.test(teamDomain)
    ? teamDomain
    : `https://${teamDomain}`;
  const resp = await fetch(`${base.replace(/\/+$/, "")}/cdn-cgi/access/certs`);
  if (!resp.ok) {
    throw new HubError(401, "UNAUTHORIZED", "Failed to fetch Cloudflare Access JWKS.");
  }
  const data = (await resp.json()) as JwksResponse;
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache.set(teamDomain, { fetchedAt: Date.now(), keys });
  return keys;
}

async function verifyAccessJwt(token: string, env: Env): Promise<AuthPrincipal> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const expectedAud = env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !expectedAud) {
    throw new HubError(401, "UNAUTHORIZED", "Cloudflare Access JWT verification is not configured.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HubError(401, "UNAUTHORIZED", "Malformed Cloudflare Access JWT.");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { kid?: string; alg?: string };
  let payload: AccessJwtPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerB64))) as {
      kid?: string;
      alg?: string;
    };
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadB64))) as AccessJwtPayload;
  } catch {
    throw new HubError(401, "UNAUTHORIZED", "Invalid Cloudflare Access JWT encoding.");
  }
  if (header.alg !== "RS256" || !header.kid) {
    throw new HubError(401, "UNAUTHORIZED", "Unsupported Cloudflare Access JWT algorithm.");
  }

  const keys = await getAccessCerts(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new HubError(401, "UNAUTHORIZED", "Matching Access signing key not found.");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    decodeBase64Url(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!verified) {
    throw new HubError(401, "UNAUTHORIZED", "Cloudflare Access JWT signature invalid.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    throw new HubError(401, "UNAUTHORIZED", "Cloudflare Access JWT expired.");
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) {
    throw new HubError(401, "UNAUTHORIZED", "Cloudflare Access JWT not yet valid.");
  }
  const audList = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!audList.includes(expectedAud)) {
    throw new HubError(401, "UNAUTHORIZED", "Cloudflare Access JWT audience mismatch.");
  }

  return {
    kind: "access_jwt",
    keyId: null,
    scope: "admin",
    boundNodeId: null,
    allowedNodes: [],
    allowedBoardPrefixes: ["*"],
    allowUnsandboxed: true,
    maxDepthLimit: 3
  };
}

function extractBearerToken(request: Request, allowWsProtocolToken: boolean): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  if (allowWsProtocolToken) {
    const protoHeader = request.headers.get("Sec-WebSocket-Protocol");
    if (protoHeader) {
      const parts = protoHeader.split(",").map((p) => p.trim());
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i]?.toLowerCase() === "bearer" && parts[i + 1]) {
          return parts[i + 1]!;
        }
      }
    }
  }
  return null;
}

export function extractSameOriginAccessCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }
  let cookieToken: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    if (part.slice(0, eqIdx).trim() === "CF_Authorization") {
      const value = part.slice(eqIdx + 1).trim();
      if (value) {
        cookieToken = value;
        break;
      }
    }
  }
  if (!cookieToken) {
    return null;
  }

  const secFetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Cross-site cookie authentication is forbidden.");
  }

  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin")?.trim();
  const method = request.method.toUpperCase();
  const isWsUpgrade = request.headers.get("Upgrade")?.trim().toLowerCase() === "websocket";

  if (isWsUpgrade || (method !== "GET" && method !== "HEAD" && method !== "OPTIONS")) {
    if (origin !== expectedOrigin) {
      throw new HubError(
        403,
        "FORBIDDEN_SCOPE",
        "Same-origin Origin header is required for cookie authentication."
      );
    }
  } else if (origin && origin !== expectedOrigin) {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Origin mismatch for cookie authentication.");
  }

  return cookieToken;
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  allowWsProtocolToken = false
): Promise<AuthPrincipal> {
  const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (accessJwt) {
    return verifyAccessJwt(accessJwt.trim(), env);
  }

  const token = extractBearerToken(request, allowWsProtocolToken);
  if (!token) {
    const accessCookieJwt = extractSameOriginAccessCookie(request);
    if (accessCookieJwt) {
      return verifyAccessJwt(accessCookieJwt, env);
    }
    throw new HubError(401, "UNAUTHORIZED", "Missing authentication token.");
  }

  const digest = await sha256Hex(token);
  const bootstrapHash = env.BOOTSTRAP_ADMIN_TOKEN_SHA256?.trim().toLowerCase();
  if (bootstrapHash && constantTimeEqual(digest, bootstrapHash)) {
    return {
      kind: "bootstrap_admin",
      keyId: null,
      scope: "admin",
      boundNodeId: null,
      allowedNodes: [],
      allowedBoardPrefixes: ["*"],
      allowUnsandboxed: true,
      maxDepthLimit: 3
    };
  }

  const row = await env.DB.prepare(
    `SELECT id, scope, bound_node_id, allowed_nodes_json, allowed_board_prefixes_json, allow_unsandboxed, max_depth_limit, revoked_at
     FROM api_keys
     WHERE key_sha256 = ?1
     LIMIT 1`
  )
    .bind(digest)
    .first<{
      id: string;
      scope: ApiScope;
      bound_node_id: string | null;
      allowed_nodes_json: string;
      allowed_board_prefixes_json: string;
      allow_unsandboxed: number;
      max_depth_limit: number;
      revoked_at: string | null;
    }>();

  if (!row || row.revoked_at !== null) {
    throw new HubError(401, "UNAUTHORIZED", "Invalid or revoked API token.");
  }

  let allowedNodes: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_nodes_json);
    if (Array.isArray(parsed)) {
      allowedNodes = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    allowedNodes = [];
  }

  let allowedBoardPrefixes: string[] = [];
  if (row.scope === "admin") {
    allowedBoardPrefixes = ["*"];
  } else if (row.scope === "client") {
    try {
      const parsed = JSON.parse(row.allowed_board_prefixes_json ?? "[]");
      if (Array.isArray(parsed)) {
        allowedBoardPrefixes = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      allowedBoardPrefixes = [];
    }
  }

  const updateTouch = env.DB.prepare(`UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2`)
    .bind(nowIso(), row.id)
    .run()
    .catch(() => undefined);
  if (ctx) {
    ctx.waitUntil(updateTouch);
  }

  return {
    kind: "api_key",
    keyId: row.id,
    scope: row.scope,
    boundNodeId: row.bound_node_id,
    allowedNodes,
    allowedBoardPrefixes,
    allowUnsandboxed: row.allow_unsandboxed === 1,
    maxDepthLimit: row.max_depth_limit
  };
}

export function requireScope(principal: AuthPrincipal, allowed: readonly ApiScope[]): void {
  if (!allowed.includes(principal.scope)) {
    throw new HubError(
      403,
      "FORBIDDEN_SCOPE",
      `Scope '${principal.scope}' is not permitted for this operation.`
    );
  }
}

export function isNodeVisibleToPrincipal(principal: AuthPrincipal, nodeId: string): boolean {
  if (principal.scope === "admin") return true;
  if (principal.scope === "node") return principal.boundNodeId === nodeId;
  if (principal.boundNodeId && principal.boundNodeId !== nodeId) return false;
  if (principal.allowedNodes.length > 0 && !principal.allowedNodes.includes(nodeId)) return false;
  return true;
}

export function ensureNodeAllowedForClient(principal: AuthPrincipal, nodeId: string): void {
  if (principal.scope === "admin") return;
  if (principal.scope !== "client") {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Node token cannot perform client operations.");
  }
  if (!isNodeVisibleToPrincipal(principal, nodeId)) {
    throw new HubError(
      403,
      "FORBIDDEN_SCOPE",
      principal.boundNodeId && principal.boundNodeId !== nodeId
        ? `Client key is bound to node '${principal.boundNodeId}' and cannot target '${nodeId}'.`
        : `Client key is not permitted to target node '${nodeId}'.`
    );
  }
}

export function ensureRunAccessible(
  principal: AuthPrincipal,
  run: { created_by_key_id: string | null; node_id: string }
): void {
  if (principal.scope === "admin") return;
  if (principal.scope === "node") {
    if (principal.boundNodeId !== run.node_id) {
      throw new HubError(403, "FORBIDDEN_SCOPE", "Node key cannot access another node's run.");
    }
    return;
  }
  ensureNodeAllowedForClient(principal, run.node_id);
  if (run.created_by_key_id !== principal.keyId) {
    throw new HubError(403, "FORBIDDEN_SCOPE", "Client key cannot access runs created by another key.");
  }
}

const SAFE_BOARD_CHANNEL_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

export function sanitizeNextHints(hints: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hints) {
    if (typeof h === "string" && h.length >= 1 && h.length <= 512 && !/[\r\n]/.test(h)) {
      out.push(h);
      if (out.length >= 8) break;
    }
  }
  return out;
}

export function buildBoardPrefixNextHints(principal: AuthPrincipal): string[] {
  const hints: string[] = [];
  for (const p of principal.allowedBoardPrefixes ?? []) {
    if (p === "*") {
      hints.push("ahub board read --json");
      break;
    }
    if (p.length <= 64 && SAFE_BOARD_CHANNEL_RE.test(p)) {
      hints.push(`ahub board read ${p} --json`);
    }
    if (hints.length >= 4) break;
  }
  return sanitizeNextHints(hints);
}

export function isBoardChannelAllowed(principal: AuthPrincipal, channel: string): boolean {
  if (principal.scope === "admin") return true;
  if (principal.scope !== "client") return false;
  const prefixes = principal.allowedBoardPrefixes ?? [];
  if (prefixes.length === 0) return false;
  return prefixes.some((p) => p === "*" || channel === p || channel.startsWith(`${p}/`));
}

export function ensureBoardReadAllowed(principal: AuthPrincipal): void {
  requireScope(principal, ["admin", "client"]);
  if (principal.scope === "client" && (principal.allowedBoardPrefixes ?? []).length === 0) {
    throw new HubError(
      403,
      "FORBIDDEN_SCOPE",
      "Client key has no allowed_board_prefixes configured for coordination board access."
    );
  }
}

export function ensureBoardChannelAllowed(principal: AuthPrincipal, channel: string): void {
  ensureBoardReadAllowed(principal);
  if (!isBoardChannelAllowed(principal, channel)) {
    const hints = buildBoardPrefixNextHints(principal);
    throw new HubError(
      403,
      "FORBIDDEN_SCOPE",
      `Client key is not permitted to access board channel '${channel}'.`,
      undefined,
      hints.length > 0 ? hints : undefined
    );
  }
}
