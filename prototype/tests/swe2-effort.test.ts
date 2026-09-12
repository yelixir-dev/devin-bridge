import { expect, test } from "bun:test";
import { createHandler, type ChatInput } from "../src/http.ts";
import { UpstreamError } from "../src/connect.ts";
import type { DiscoveredModel } from "../src/devin-rpc.ts";

const key = "effort-fixture-key";
const model = (uid: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
  uid, label: uid, maxTokens: 8192, disabled: false, router: false, ...extra,
});
const catalog = [model("swe-2-medium"), model("swe-2-high"), model("swe-2-max"), model("other-model")];
const messages = [{ role: "user", content: "fixture request" }];

async function fixture(
  models: readonly DiscoveredModel[],
  check: (origin: string, calls: readonly ChatInput[]) => Promise<void>,
  rejected = false,
) {
  const calls: ChatInput[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: createHandler({
      models,
      async *complete(input) {
        calls.push(input);
        if (rejected) throw new UpstreamError("resource_exhausted");
        yield { type: "text", text: "OK" };
        yield { type: "done", stopReason: 2, usage: null };
      },
    }, key),
  });
  try { await check(server.url.origin, calls); }
  finally { await server.stop(true); }
}

function post(origin: string, extra: Record<string, unknown>) {
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "swe-2", messages, ...extra }),
  });
}

test.each([
  { effort: "medium", expected: "swe-2-medium" },
  { effort: "high", expected: "swe-2-high" },
  { effort: "max", expected: "swe-2-max" },
])("routes swe-2/$effort to the exact variant", async ({ effort, expected }) => {
  // Given all variants available, when the family and effort are requested,
  // then the backend and response both identify the selected concrete model.
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, { reasoning_effort: effort });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: expected });
    expect(calls.map(c => c.model)).toEqual([expected]);
  });
});

test("uses high as the explicit family default", async () => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "swe-2-high" });
    expect(calls.map(c => c.model)).toEqual(["swe-2-high"]);
  });
});

test("reports the selected max variant in streamed chunks", async () => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, { reasoning_effort: "max", stream: true });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"model":"swe-2-max"');
    expect(text).toEndWith("data: [DONE]\n\n");
    expect(calls.map(c => c.model)).toEqual(["swe-2-max"]);
  });
});

test("groups the model list and preserves unrelated models", async () => {
  await fixture(catalog, async (origin, calls) => {
    const response = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        { id: "other-model", object: "model", created: 0, owned_by: "devin" },
        { id: "swe-2", object: "model", created: 0, owned_by: "devin",
          reasoning_efforts: ["medium", "high", "max"], default_reasoning_effort: "high" },
      ],
    });
    expect(calls.length).toBe(0);
  });
});

test("only advertises available non-router efforts", async () => {
  await fixture([
    model("swe-2-medium"), model("swe-2-high", { disabled: true }), model("swe-2-max", { router: true }),
  ], async (origin) => {
    const response = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    expect(await response.json()).toEqual({ object: "list", data: [{
      id: "swe-2", object: "model", created: 0, owned_by: "devin", reasoning_efforts: ["medium"],
    }] });
  });
});

test("does not advertise swe-2 if no variant is available", async () => {
  await fixture([model("swe-2-high", { disabled: true })], async (origin) => {
    const response = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    expect(await response.json()).toEqual({ object: "list", data: [] });
  });
});

test.each([{ reasoning_effort: "max" }, {}])("does not downgrade a missing selected/default effort: %j", async extra => {
  await fixture([model("swe-2-medium")], async (origin, calls) => {
    const response = await post(origin, extra);
    expect(response.status).toBe(404);
    expect(calls.length).toBe(0);
  });
});

test.each(["low", "unknown", null, 3])("rejects invalid effort %j before inference", async effort => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, { reasoning_effort: effort });
    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

test("rejects an effort conflicting with a raw variant", async () => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, { model: "swe-2-max", reasoning_effort: "medium" });
    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

test("does not silently enable reasoning_effort on unrelated models", async () => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, { model: "other-model", reasoning_effort: "high" });
    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });
});

test.each([
  { model: "swe-2-medium" },
  { model: "swe-2-high", reasoning_effort: "high" },
  { model: "other-model" },
])("preserves explicit model selection %j", async extra => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, extra);
    expect(response.status).toBe(200);
    expect(calls.map(c => c.model)).toEqual([extra.model]);
  });
});

test("propagates a max rejection without calling a lower effort", async () => {
  await fixture(catalog, async (origin, calls) => {
    const response = await post(origin, { reasoning_effort: "max" });
    expect(response.status).toBe(429);
    expect(calls.map(c => c.model)).toEqual(["swe-2-max"]);
  }, true);
});
