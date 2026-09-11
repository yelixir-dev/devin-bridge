import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

const MAX_FRAME = 16 * 1024 * 1024;
const errorSchema = z.object({ code: z.string() });
const trailerSchema = z.object({ error: errorSchema.optional() });
const statuses: Readonly<Record<string, number>> = {
  unauthenticated: 401, permission_denied: 403, not_found: 404,
  resource_exhausted: 429, invalid_argument: 400, failed_precondition: 400,
  unavailable: 503, deadline_exceeded: 504,
};

export class UpstreamError extends Error {
  constructor(
    readonly code: string,
    readonly status = statuses[code] ?? 502,
  ) {
    // Never echo a raw upstream body: it may contain credentials.
    super(`Devin upstream error: ${code}`);
    this.name = "UpstreamError";
  }
}

export function encodeFrame(payload: Uint8Array): Buffer {
  const compressed = gzipSync(payload);
  const frame = Buffer.alloc(compressed.length + 5);
  frame[0] = 1;
  frame.writeUInt32BE(compressed.length, 1);
  frame.set(compressed, 5);
  return frame;
}

export function decodeUnary(payload: Uint8Array): Uint8Array {
  return payload[0] === 0x1f && payload[1] === 0x8b
    ? gunzipSync(payload, { maxOutputLength: MAX_FRAME })
    : payload;
}

export async function checkStatus(response: Response): Promise<void> {
  if (response.ok) return;
  let code = `http_${response.status}`;
  try {
    const parsed = errorSchema.safeParse(await response.json());
    if (parsed.success) code = parsed.data.code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new UpstreamError(code, response.status);
}

export async function* readFrames(response: Response): AsyncGenerator<Uint8Array> {
  await checkStatus(response);
  if (!response.body) throw new UpstreamError("protocol_error");
  const reader = response.body.getReader();
  let pending: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) pending = Buffer.concat([pending, value]);
      while (pending.length >= 5) {
        const flag = pending.readUInt8(0);
        const length = pending.readUInt32BE(1);
        if (flag > 3 || length > MAX_FRAME) throw new UpstreamError("protocol_error");
        if (pending.length < length + 5) break;
        const payload = pending.subarray(5, length + 5);
        pending = pending.subarray(length + 5);
        let decoded: Uint8Array;
        try {
          decoded = flag & 1 ? gunzipSync(payload, { maxOutputLength: MAX_FRAME }) : payload;
        } catch (error) {
          if (error instanceof Error) throw new UpstreamError("protocol_error");
          throw error;
        }
        if (flag & 2) {
          let raw: unknown;
          try {
            raw = JSON.parse(new TextDecoder().decode(decoded));
          } catch (error) {
            if (error instanceof SyntaxError) throw new UpstreamError("protocol_error");
            throw error;
          }
          const trailer = trailerSchema.safeParse(raw);
          if (!trailer.success || pending.length) throw new UpstreamError("protocol_error");
          if (trailer.data.error) throw new UpstreamError(trailer.data.error.code);
          return;
        }
        yield decoded;
      }
      if (done) throw new UpstreamError("protocol_error"); // EOF without a trailer is not success.
    }
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
