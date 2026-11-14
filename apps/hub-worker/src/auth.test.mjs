import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file://")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const candidate = path.resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  }
});

const { authenticateRequest } = await import("./auth.ts");
const { sha256Hex } = await import("./ulid.ts");

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function createRsaTestMaterial() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    jwks: {
      keys: [{ ...pubJwk, kid: "test-kid-1", use: "sig", alg: "RS256" }]
    }
  };
}

async function signAccessJwt(privateKey, payload, kid = "test-kid-1") {
  const headerB64 = toBase64Url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signingInput);
  return `${headerB64}.${payloadB64}.${toBase64Url(new Uint8Array(signature))}`;
}

test("authenticateRequest validates Cf-Access-Jwt-Assertion, same-origin CF_Authorization cookie, CSRF boundaries, and Bearer precedence", async (t) => {
  const { privateKey, jwks } = await createRsaTestMaterial();
  const teamDomain = "http://127.0.0.1:41999";
  const expectedAud = "test-access-aud-123";
  const bootstrapToken = "ahub_adm_test_bootstrap_secret_123";
  const bootstrapSha = await sha256Hex(bootstrapToken);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${teamDomain}/cdn-cgi/access/certs`) {
      return Response.json(jwks);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    DB: {
      prepare() {
        throw new Error("DB.prepare should not be called for Access JWT or bootstrap admin tests");
      }
    },
    CF_ACCESS_TEAM_DOMAIN: teamDomain,
    CF_ACCESS_AUD: expectedAud,
    BOOTSTRAP_ADMIN_TOKEN_SHA256: bootstrapSha
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const validJwt = await signAccessJwt(privateKey, {
    aud: [expectedAud],
    exp: nowSec + 300,
    nbf: nowSec - 10,
    iss: teamDomain,
    sub: "user-1"
  });
  const wrongAudJwt = await signAccessJwt(privateKey, {
    aud: ["wrong-aud"],
    exp: nowSec + 300,
    sub: "user-1"
  });
  const expiredJwt = await signAccessJwt(privateKey, {
    aud: [expectedAud],
    exp: nowSec - 60,
    sub: "user-1"
  });

  // 1. Valid Cf-Access-Jwt-Assertion header
  const headerPrincipal = await authenticateRequest(
    new Request("https://ahub.bobocai.win/api/v1/nodes", {
      headers: { "Cf-Access-Jwt-Assertion": validJwt }
    }),
    env
  );
  assert.equal(headerPrincipal.kind, "access_jwt");
  assert.equal(headerPrincipal.scope, "admin");

  // 2a. Valid same-origin CF_Authorization cookie on GET
  const cookieGetPrincipal = await authenticateRequest(
    new Request("https://ahub.bobocai.win/api/v1/nodes", {
      headers: {
        Cookie: `other=1; CF_Authorization=${validJwt}`,
        "Sec-Fetch-Site": "same-origin"
      }
    }),
    env
  );
  assert.equal(cookieGetPrincipal.kind, "access_jwt");
  assert.equal(cookieGetPrincipal.scope, "admin");

  // 2b. Valid same-origin CF_Authorization cookie on POST
  const cookiePostPrincipal = await authenticateRequest(
    new Request("https://ahub.bobocai.win/api/v1/runs", {
      method: "POST",
      headers: {
        Cookie: `CF_Authorization=${validJwt}`,
        Origin: "https://ahub.bobocai.win",
        "Sec-Fetch-Site": "same-origin"
      }
    }),
    env
  );
  assert.equal(cookiePostPrincipal.kind, "access_jwt");
  assert.equal(cookiePostPrincipal.scope, "admin");

  // 2c. Valid same-origin CF_Authorization cookie on WebSocket upgrade
  const cookieWsPrincipal = await authenticateRequest(
    new Request("https://ahub.bobocai.win/ws/stream", {
      headers: {
        Upgrade: "websocket",
        Origin: "https://ahub.bobocai.win",
        Cookie: `CF_Authorization=${validJwt}`
      }
    }),
    env,
    undefined,
    true
  );
  assert.equal(cookieWsPrincipal.kind, "access_jwt");
  assert.equal(cookieWsPrincipal.scope, "admin");

  // 3. Cross-origin / missing-Origin / cross-site cookie requests must fail with 403 FORBIDDEN_SCOPE
  await assert.rejects(
    () =>
      authenticateRequest(
        new Request("https://ahub.bobocai.win/api/v1/runs", {
          method: "POST",
          headers: {
            Cookie: `CF_Authorization=${validJwt}`,
            Origin: "https://evil.example"
          }
        }),
        env
      ),
    (err) => err?.status === 403 && err?.code === "FORBIDDEN_SCOPE"
  );

  await assert.rejects(
    () =>
      authenticateRequest(
        new Request("https://ahub.bobocai.win/api/v1/runs", {
          method: "POST",
          headers: {
            Cookie: `CF_Authorization=${validJwt}`
          }
        }),
        env
      ),
    (err) => err?.status === 403 && err?.code === "FORBIDDEN_SCOPE"
  );

  await assert.rejects(
    () =>
      authenticateRequest(
        new Request("https://ahub.bobocai.win/api/v1/nodes", {
          headers: {
            Cookie: `CF_Authorization=${validJwt}`,
            "Sec-Fetch-Site": "cross-site"
          }
        }),
        env
      ),
    (err) => err?.status === 403 && err?.code === "FORBIDDEN_SCOPE"
  );

  // 4. Wrong aud or expired exp in CF_Authorization must fail with 401 UNAUTHORIZED
  await assert.rejects(
    () =>
      authenticateRequest(
        new Request("https://ahub.bobocai.win/api/v1/nodes", {
          headers: { Cookie: `CF_Authorization=${wrongAudJwt}` }
        }),
        env
      ),
    (err) => err?.status === 401 && err?.code === "UNAUTHORIZED"
  );

  await assert.rejects(
    () =>
      authenticateRequest(
        new Request("https://ahub.bobocai.win/api/v1/nodes", {
          headers: { Cookie: `CF_Authorization=${expiredJwt}` }
        }),
        env
      ),
    (err) => err?.status === 401 && err?.code === "UNAUTHORIZED"
  );

  // 5. Explicit Bearer token succeeds even when an expired CF_Authorization cookie is present
  const bearerPrincipal = await authenticateRequest(
    new Request("https://ahub.bobocai.win/api/v1/nodes", {
      headers: {
        Authorization: `Bearer ${bootstrapToken}`,
        Cookie: `CF_Authorization=${expiredJwt}`
      }
    }),
    env
  );
  assert.equal(bearerPrincipal.kind, "bootstrap_admin");
  assert.equal(bearerPrincipal.scope, "admin");
});
