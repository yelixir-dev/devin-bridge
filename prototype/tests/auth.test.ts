import { expect, test } from "bun:test";
import { createUserJwtCache } from "../src/auth.ts";

const MINUTE = 60_000;
const base = Date.parse("2026-09-12T00:00:00Z");

function jwtWithExp(expSeconds: number | undefined, label: string) {
  const payload = Buffer.from(JSON.stringify(expSeconds === undefined ? { label } : { exp: expSeconds, label })).toString("base64url");
  return `header.${payload}.signature`;
}

function fixture(lifetimes: readonly (number | undefined)[]) {
  let now = base;
  let calls = 0;
  const fetchJwt = async () => {
    const lifetime = lifetimes[calls] ?? lifetimes.at(-1);
    calls++;
    return { userJwt: jwtWithExp(lifetime === undefined ? undefined : Math.floor(now / 1000) + lifetime, `token-${calls}`), baseUrl: "https://api.example.test" };
  };
  const cache = createUserJwtCache({ fetchJwt, now: () => now });
  return { cache, advance: (ms: number) => { now += ms; }, count: () => calls };
}

test("shares one upstream fetch across concurrent and later callers while the JWT is valid", async () => {
  // Given a JWT that expires in fifteen minutes, as the real GetUserJwt response does.
  const { cache, advance, count } = fixture([900]);
  // When three callers race and a fourth arrives later.
  const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
  advance(10 * MINUTE);
  const later = await cache.get();
  // Then every caller receives the same credential from one upstream call.
  expect(count()).toBe(1);
  expect(new Set(results.map(r => r.userJwt)).size).toBe(1);
  expect(later).toEqual(results[0]);
});

test("refreshes before the exp claim instead of using a JWT that would expire mid-flight", async () => {
  // Given a cached JWT that will expire within the refresh margin.
  const { cache, advance, count } = fixture([900]);
  const first = await cache.get();
  advance(14 * MINUTE + 30_000);
  // When a caller arrives inside the last minute of validity.
  const second = await cache.get();
  // Then a fresh JWT is fetched and returned.
  expect(count()).toBe(2);
  expect(second.userJwt).not.toBe(first.userJwt);
});

test("falls back to a short lifetime when the JWT carries no readable exp claim", async () => {
  // Given a JWT whose payload has no exp.
  const { cache, advance, count } = fixture([undefined]);
  await cache.get();
  advance(3 * MINUTE);
  await cache.get();
  expect(count()).toBe(1);
  // When the five-minute fallback lifetime (minus the refresh margin) has elapsed.
  advance(3 * MINUTE);
  await cache.get();
  // Then the credential is fetched again rather than trusted indefinitely.
  expect(count()).toBe(2);
});

test("propagates one upstream failure to every waiter and retries on the next call", async () => {
  // Given an upstream auth call that fails once.
  let attempts = 0;
  let now = base;
  const cache = createUserJwtCache({
    async fetchJwt() {
      attempts++;
      if (attempts === 1) throw new Error("auth unavailable");
      return { userJwt: jwtWithExp(Math.floor(now / 1000) + 900, "ok"), baseUrl: "https://api.example.test" };
    },
    now: () => now,
  });
  // When two callers race into the failing fetch.
  const results = await Promise.allSettled([cache.get(), cache.get()]);
  // Then both observe the failure, nothing is cached, and the next call succeeds with a second fetch.
  expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
  expect(attempts).toBe(1);
  const recovered = await cache.get();
  expect(recovered.baseUrl).toBe("https://api.example.test");
  expect(attempts).toBe(2);
});
