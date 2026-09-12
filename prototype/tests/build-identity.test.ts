import { expect, test } from "bun:test";
import { createHandler } from "../src/http.ts";
import { BRIDGE_VERSION } from "../src/version.ts";
import packageJson from "../package.json";

const key = "build-identity-fixture-key";

async function serve(check: (origin: string) => Promise<void>) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: createHandler({
      models: [
        { uid: "swe-2-high", label: "SWE-2 High", disabled: false, router: false, maxTokens: 8192 },
        { uid: "swe-2-medium", label: "SWE-2 Medium", disabled: false, router: false, maxTokens: 8192 },
      ],
      async *complete() {
        yield { type: "text", text: "OK" };
        yield { type: "done", stopReason: 2, usage: null };
      },
    }, key),
  });
  try { await check(server.url.origin); } finally { await server.stop(true); }
}

function post(origin: string, stream: boolean, selection: Record<string, unknown> = { model: "swe-2-high" }) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...selection, stream, messages: [{ role: "user", content: "fixture" }] }),
  });
}

test("keeps the declared package version and the runtime constant in lockstep", () => {
  // Given the package manifest and the constant embedded in the build.
  // Then they identify the same release, so the fingerprint cannot drift from the manifest.
  expect(packageJson.version).toBe(BRIDGE_VERSION);
});

test("identifies the bridge build in JSON completions, every SSE chunk, and the health endpoint", async () => {
  // Given a running bridge; when an operator inspects a completion through any proxy.
  await serve(async origin => {
    // The fingerprint names the build and the concrete variant, because proxies rewrite `model` to the alias.
    const fingerprint = `devin-bridge-${BRIDGE_VERSION}/swe-2-high`;
    const json = await (await post(origin, false)).json();
    expect(json.system_fingerprint).toBe(fingerprint);
    const body = await (await post(origin, true)).text();
    const chunks = body.split("\n\n").filter(frame => frame && frame !== "data: [DONE]").map(frame => JSON.parse(frame.slice(6)));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.system_fingerprint === fingerprint)).toBe(true);
    const routed = await (await post(origin, false, { model: "swe-2", reasoning_effort: "medium" })).json();
    expect(routed.system_fingerprint).toBe(`devin-bridge-${BRIDGE_VERSION}/swe-2-medium`);
    // Then the health endpoint reports the same version for local checks.
    const health = await (await fetch(`${origin}/health`)).json();
    expect(health.version).toBe(BRIDGE_VERSION);
  });
});
