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
      !specifier.endsWith(".md") &&
      !specifier.endsWith(".sh") &&
      context.parentURL?.startsWith("file://")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const candidate = path.resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file://") && (url.endsWith(".md") || url.endsWith(".sh"))) {
      const content = fs.readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        source: `export default ${JSON.stringify(content)};`,
        shortCircuit: true
      };
    }
    return nextLoad(url, context);
  }
});

const { handleBinaryDownload, handleBootstrapMd, handleClientBootstrapMd, handleInstallSh } =
  await import("./downloads.ts");

test("handleBootstrapMd injects HUB_PUBLIC_URL across all placeholders", async () => {
  const req = new Request("https://ignored.example/dl/bootstrap.md");
  const resp = handleBootstrapMd(req, { HUB_PUBLIC_URL: "https://hub.custom.example/" });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Content-Type"), "text/markdown; charset=utf-8");

  const text = await resp.text();
  assert.equal(text.includes("__HUB_URL__"), false, "no raw __HUB_URL__ placeholder should remain");
  assert.equal(text.includes("https://hub.custom.example/dl/install.sh"), true);
  assert.equal(text.includes("ahub node init"), true);
  assert.equal(text.includes("--token-stdin"), true);
  assert.equal(text.includes(".grok/skills"), true);
});

test("handleClientBootstrapMd injects HUB_PUBLIC_URL and enforces client isolation rules", async () => {
  const req = new Request("https://ignored.example/dl/client-bootstrap.md");
  const resp = handleClientBootstrapMd(req, { HUB_PUBLIC_URL: "https://hub.custom.example/" });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(resp.headers.get("Cache-Control"), "no-store");

  const text = await resp.text();
  assert.equal(text.includes("__HUB_URL__"), false, "no raw __HUB_URL__ placeholder should remain");
  assert.equal(text.includes("https://hub.custom.example/dl/install.sh"), true);
  assert.equal(text.includes("update --no-restart --json"), true);
  assert.equal(text.includes("auth status --json"), true);
  assert.equal(text.includes("auth login --url https://hub.custom.example --token-stdin"), true);
  assert.equal(text.includes("AHUB_CONFIG_DIR"), true);
  assert.equal(text.includes(".grok/skills"), true);
  assert.equal(text.includes("严禁执行"), true);
  assert.equal(text.includes("ahub node init"), true);
});

test("handleInstallSh injects HUB_PUBLIC_URL cleanly", async () => {
  const req = new Request("https://hub.local.example/dl/install.sh");
  const resp = handleInstallSh(req, { HUB_PUBLIC_URL: "https://hub.custom.example" });
  assert.equal(resp.status, 200);
  const script = await resp.text();
  assert.equal(script.includes("__HUB_URL__"), false);
  assert.equal(script.includes('HUB_URL="${AHUB_URL:-https://hub.custom.example}"'), true);
});

test("handleBinaryDownload accepts ahub-<os>-<arch> and rejects short names", async () => {
  const okResp = await handleBinaryDownload("ahub-darwin-arm64", {});
  assert.equal(okResp.status, 302);
  assert.equal(
    okResp.headers.get("Location"),
    "https://github.com/gray0128/agent-hub/releases/latest/download/ahub-darwin-arm64"
  );

  await assert.rejects(() => handleBinaryDownload("darwin-arm64", {}), (err) => {
    return err?.status === 404 && err?.code === "NOT_FOUND";
  });
});
