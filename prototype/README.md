# Local Devin proxy prototype

Direct Connect/protobuf access; no Devin executable, ACP, or model fallback.
Wire declarations/codecs are vendored from pinned oh-my-pi source (MIT);
see `vendor/SOURCE.md`.

Requires Bun. Run from this directory:

```sh
bun install
DEVIN_BRIDGE_API_KEY='replace-with-a-local-client-key' bun run start
```

The server binds **127.0.0.1:8787** only. `DEVIN_BRIDGE_API_KEY` protects the local
HTTP surface and must be at least 16 characters. It is separate from the Devin
account credential. Set `PORT` to choose another local port.

For upstream authentication, set `DEVIN_BRIDGE_TOKEN` to your session token, or
let the prototype read the existing `$XDG_DATA_HOME/devin/credentials.toml`
(`~/.local/share/devin/credentials.toml` by default). The file is optional when
the environment token is supplied. `DEVIN_BRIDGE_API_URL` overrides the default
upstream URL. No credentials are logged or written by this prototype.

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer replace-with-a-local-client-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"swe-2","reasoning_effort":"high","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":128,"stream":true,"stream_options":{"include_usage":true}}'
```

Supported: `GET /health`, authenticated `GET /v1/models`, and text/function-tool
`POST /v1/chat/completions` (JSON or SSE). Supported parameters are `model`,
`reasoning_effort`, `messages` (`system`, `developer`, `user`, `assistant`, `tool`), `stream`,
`max_tokens`, `max_completion_tokens`, `temperature`, `stop`, `n:1`, `stream_options.include_usage`,
`store: false`, `tools`, `tool_choice`, and `parallel_tool_calls`.
Content supports strings or text-block arrays, concatenated without whitespace changes.
The two token-limit fields are aliases (1–65536); conflicting values return 400.
Unsupported fields and images return 400 before inference.
`swe-2` groups medium/high/max variants. `reasoning_effort` selects the exact
variant; omission means high. Missing variants return 404, never another level.
Raw variant IDs remain accepted; conflicting effort returns 400.
Other model IDs must match the discovered catalog exactly; unknown IDs return 404.
Router models are excluded. Responses reporting a different model are rejected.
No automatic transport or model retries are performed.

Function tools emit `tool_calls` in JSON or indexed `delta.tool_calls` in SSE,
ending with `finish_reason: "tool_calls"`. The caller executes the function and
sends the assistant call plus a correlated `role: "tool"` result on the next
request. The bridge does not execute tools. See the [root README](../README.md)
for the complete request/response contract.

Tool-choice/declaration violations, parser-invalid/custom payloads, incomplete
JSON and inconsistent native-tool termination fail with `invalid_tool_call`
(JSON 502, or SSE error without `[DONE]`). Required/named calls cannot silently
finish as normal text. XML examples remain text under auto/none. Argument bytes
are preserved without heuristic unescaping; valid but semantically corrupted
upstream strings cannot be reconstructed. Tools declared `strict: true` are
additionally checked against their JSON Schema (`type`, `required`, `enum`,
`additionalProperties: false`, nesting, bounds); non-strict tools pass through.
JSON and SSE share one completion validator; a stream without a terminal event
is a `protocol_error` on both, and a newline-limit stop reports `length`.
The user JWT is cached per credential and refreshed before its `exp` claim.
Request bodies up to 16 MB are accepted; larger bodies return 413. Upstream
streams time out only after 120 s without a frame; there is no total deadline.
Responses carry `system_fingerprint: "devin-bridge-<version>/<resolved model>"`
and `/health` reports the same `version`, so a deployment and its effort routing
can be verified through a proxy that rewrites `model`.

```sh
bun run typecheck
bun test tests
bun run build
```

This is a local smoke-test slice, not the completed product: no dashboard,
Anthropic endpoint, interactive OAuth, deployment automation, or tool loop.
The public verification summary is in [docs/VERIFICATION.md](../docs/VERIFICATION.md).
Stop the running process with Ctrl-C.
