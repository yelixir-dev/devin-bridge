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
  -d '{"model":"swe-2-medium","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":128,"stream":true,"stream_options":{"include_usage":true}}'
```

Supported: `GET /health`, authenticated `GET /v1/models`, and text-only
`POST /v1/chat/completions` (JSON or SSE). Supported parameters are `model`,
`messages` (`system`, `user`, `assistant` with string content), `stream`,
`max_tokens`, `temperature`, `stop`, `n:1`, and `stream_options.include_usage`.
Unsupported fields, tools, and images return 400 before inference.
Model IDs must match the discovered catalog exactly; unknown IDs return 404.
Router models are excluded. Responses reporting a different model are rejected.
No automatic transport or model retries are performed.

```sh
bun run typecheck
bun test tests
bun run build
```

This is a local smoke-test slice, not the completed product: no dashboard,
Anthropic endpoint, interactive OAuth, deployment automation, or tool loop.
The public verification summary is in [docs/VERIFICATION.md](../docs/VERIFICATION.md).
Stop the running process with Ctrl-C.
