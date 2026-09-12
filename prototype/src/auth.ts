import { z } from "zod";

export interface UserJwt {
  readonly userJwt: string;
  readonly baseUrl: string;
}

export interface UserJwtCacheOptions {
  /** Performs the real GetUserJwt call for one credential and auth server. */
  readonly fetchJwt: () => Promise<UserJwt>;
  readonly now?: () => number;
}

export interface UserJwtCache {
  get(): Promise<UserJwt>;
}

// Observed GetUserJwt responses carry a 15-minute exp; refresh early so a turn never starts on a dying JWT.
const REFRESH_MARGIN_MS = 60_000;
const FALLBACK_LIFETIME_MS = 5 * 60_000;
const claims = z.object({ exp: z.number().finite() });

function expiresAt(jwt: string, issuedAt: number): number {
  const payload = jwt.split(".")[1];
  if (payload === undefined) return issuedAt + FALLBACK_LIFETIME_MS;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return issuedAt + FALLBACK_LIFETIME_MS;
    throw error;
  }
  const parsed = claims.safeParse(decoded);
  return parsed.success ? parsed.data.exp * 1000 : issuedAt + FALLBACK_LIFETIME_MS;
}

/** One cache per credential/server pair; concurrent callers share a single in-flight fetch. */
export function createUserJwtCache(options: UserJwtCacheOptions): UserJwtCache {
  const now = options.now ?? Date.now;
  let cached: { readonly value: UserJwt; readonly expiresAt: number } | undefined;
  let inflight: Promise<UserJwt> | undefined;
  return {
    get() {
      if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return Promise.resolve(cached.value);
      inflight ??= options.fetchJwt().then(value => {
        cached = { value, expiresAt: expiresAt(value.userJwt, now()) };
        return value;
      }).finally(() => { inflight = undefined; });
      return inflight;
    },
  };
}
