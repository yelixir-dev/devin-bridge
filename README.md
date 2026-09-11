<p align="center">
  <img src="docs/assets/banner.svg" alt="devin-bridge — direct model calls, no silent substitution" width="880">
</p>

<p align="center"><strong>Use Devin models through a local OpenAI-compatible text API.</strong></p>

<p align="center">
  <a href="prototype/package.json"><img src="https://img.shields.io/badge/runtime-Bun%201.4.1-b57920?style=flat-square" alt="Tested with Bun 1.4.1"></a>
  <a href="prototype/src/http.ts"><img src="https://img.shields.io/badge/API-Chat%20Completions-1f6f78?style=flat-square" alt="Chat Completions API"></a>
  <a href="#current-limitations"><img src="https://img.shields.io/badge/status-prototype-9f4d2e?style=flat-square" alt="Prototype"></a>
</p>

<!-- README-I18N:START -->

**English** | [한국어](./README.ko.md)

<!-- README-I18N:END -->

**devin-bridge** is a local, text-only proxy for Devin's internal Connect/protobuf
inference interface. It exposes Chat Completions without launching the Devin CLI
or an ACP agent. A real `swe-2-medium` request returned `OK` through the HTTP proxy
in **6.52 seconds**; the reproducible test suite currently contains **20 tests**.
This is a verified prototype, not a full OpenAI API replacement.
See the [verification record](docs/VERIFICATION.md) for the measurement and its limits.

[Features](#what-it-does) · [Install](#install) · [Usage](#usage) · [Protocol](#how-it-works) · [Verification](#verification) · [Attribution](#attribution) · [Limitations](#current-limitations)

## What it does

- **Direct inference.** Calls Devin's Connect/protobuf interface using pinned [oh-my-pi wire declarations](prototype/vendor/SOURCE.md); no CLI subprocess or agent loop.
- **JSON and SSE responses.** Serves text-only `POST /v1/chat/completions`, including upstream-reported token usage.
- **Exact model selection.** Accepts model IDs from the account's discovered catalog, excludes router models, and rejects unknown IDs before inference.
- **No model fallback.** No automatic model or transport retries; upstream rejections are surfaced instead of substituting another model.
- **Local access control.** Binds to `127.0.0.1`, checks a separate client API key, and rejects browser-origin requests.
- **Fail-closed streams.** Rejects malformed/truncated Connect responses and reported model mismatches rather than marking them successful.

## Install

Requires **Bun**; installation and verification were tested with **Bun 1.4.1**.
The runnable package stays in `prototype/`.

```sh
git clone https://github.com/yelixir-dev/devin-bridge.git
cd devin-bridge/prototype
bun install --frozen-lockfile
```

Use a valid Devin session token belonging to your account. Authentication is
currently token-based; the prototype does **not** perform browser OAuth.

Two credential sources are supported:

1. Set `DEVIN_BRIDGE_TOKEN` explicitly.
2. If it is unset, import the existing token from
   `$XDG_DATA_HOME/devin/credentials.toml`, or
   `~/.local/share/devin/credentials.toml` by default. This reads a file; it does
   not run the CLI.

For an explicit token, enter it without putting its value in shell history
(Bash):

```sh
read -rsp "Devin session token: " DEVIN_BRIDGE_TOKEN; printf '\n'
export DEVIN_BRIDGE_TOKEN
```

Skip that block if using an existing credentials file. Then create a separate
local client key and start the server:

```sh
export DEVIN_BRIDGE_API_KEY="$(bun -e 'console.log(crypto.randomUUID())')"
printf 'Local client key: %s\n' "$DEVIN_BRIDGE_API_KEY"
bun run start
```

The local client key is **not** your Devin session token. Keep it for the client
examples below. The server listens at `http://127.0.0.1:8787`; stop it with Ctrl-C.

## Usage

In another Bash terminal, enter the **same local client key** printed at startup:

```sh
read -rsp "Local client key: " DEVIN_BRIDGE_API_KEY; printf '\n'
export DEVIN_BRIDGE_API_KEY

curl -sS http://127.0.0.1:8787/health

curl -sS http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $DEVIN_BRIDGE_API_KEY"

curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $DEVIN_BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"swe-2-medium","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":128,"stream":true,"stream_options":{"include_usage":true}}'
```

Use an exact ID returned by `GET /v1/models`; availability depends on your account.
The recorded response text was:

```text
OK
```

The stream ended normally with `data: [DONE]` and reported **472 input tokens /
34 output tokens**. This single observed call is not a latency guarantee or a
benchmark. Set `stream` to `false` to receive one JSON completion instead.

| Endpoint | Authentication | Result |
| --- | --- | --- |
| `GET /health` | None | Local service status and transport |
| `GET /v1/models` | Client Bearer key | Discovered, enabled, non-router model IDs |
| `POST /v1/chat/completions` | Client Bearer key | Text completion as JSON or SSE |

Accepted request fields: `model`, `messages`, `stream`, `max_tokens`,
`temperature`, `stop`, `n:1`, and `stream_options.include_usage`.
Message roles are `system`, `user`, and `assistant`, with string content only.
Other fields are rejected with 400 rather than silently ignored.

| Environment variable | Required | Behavior |
| --- | --- | --- |
| `DEVIN_BRIDGE_API_KEY` | Yes | Local client key; at least 16 characters |
| `DEVIN_BRIDGE_TOKEN` | Unless importing credentials | Upstream Devin session token |
| `DEVIN_BRIDGE_API_URL` | No | Explicit upstream base URL override |
| `XDG_DATA_HOME` | No | Existing credential file base directory |
| `PORT` | No | Local port; defaults to `8787` |

An explicit `DEVIN_BRIDGE_TOKEN` takes precedence over the credential file.
With that token and no URL override, the upstream base is
`https://server.codeium.com`. Otherwise the imported file may supply
`api_server_url`.

## How it works

1. Load the session token and discover the account's model catalog with `GetCliModelConfigs`.
2. Validate the HTTP request and require an exact, enabled, non-router model ID.
3. Obtain a user JWT through `GetUserJwt`; no browser or CLI is started.
4. Encode a `CASCADE` request with the pinned protobuf schema and call `GetChatMessage`.
5. Decode Connect frames into text and usage events, checking reported model identity.
6. Return OpenAI-shaped JSON/SSE; propagate errors and cancel inference when the consumer closes.

The caller supplies conversation history on each request. The bridge does not
execute tools, create a local agent workspace, or launch child agents.

## Verification

Run the same checks used before publication from `prototype/`:

```sh
bun run typecheck
bun test tests
bun run build
```

| Gate | Code / test | Failure it catches |
| --- | --- | --- |
| Wire request | [RPC tests](prototype/tests/rpc.test.ts) | Wrong `GENERAL`/`CASCADE` request discriminator |
| Error propagation | [RPC tests](prototype/tests/rpc.test.ts) | Truncated frames, invalid trailers, upstream rejection, or reported model substitution |
| HTTP contract | [HTTP tests](prototype/tests/http.test.ts) | Broken JSON/SSE responses, missing auth, unsupported inputs, or retries after rejection |
| Credential parsing | [TOML test](prototype/tests/creds.test.ts) | Quote delimiters accidentally becoming part of a token |

The automated tests use local fixtures and do not spend account credits.
The separate [live verification record](docs/VERIFICATION.md) covers the
authenticated SWE-2 call; it does not claim every discovered model was exercised.

## Repository layout

```text
prototype/src/         HTTP surface, direct RPC client, credentials
prototype/tests/       Deterministic local regression tests
prototype/vendor/      Pinned oh-my-pi wire code and MIT notice
docs/                 Verification, attribution views, banner
scripts/              Attribution registry renderer
```

## Attribution

The wire declarations and protobuf codec come from
[oh-my-pi](https://github.com/can1357/oh-my-pi) at commit
`3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`, under MIT.
The original notice remains in [prototype/vendor/LICENSE](prototype/vendor/LICENSE);
[SOURCE.md](prototype/vendor/SOURCE.md) records the small codec adaptations.
No upstream agent framework or model-routing policy is vendored.

Registry: [Markdown](docs/ATTRIBUTIONS.md) ·
[HTML](docs/attributions.html) · [JSON source](attributions.json).
Regenerate both views from the repository root with
`bun scripts/build-attributions.mjs`.

Third-party code remains subject to its original MIT terms; this project's
license does not replace, narrow, or relicense those terms.
Neither Cognition/Devin nor the listed upstream authors endorse this project.

## Current limitations

- **Text-only prototype:** no tools, images, Anthropic Messages endpoint, dashboard, or interactive OAuth. Unsupported fields return explicit errors; use a valid session token.
- **Private upstream interface:** wire behavior and account availability can change. Run the fixture tests and a small authorized smoke test after an update.
- **Local service only:** no remote-deployment automation or public listener. Keep access private and protect both the client key and upstream token.
- **Account-dependent usage:** subscription limits and service terms still apply. Model fallback is never used to bypass a rejection; inspect returned errors and account usage.

## License

The project license is **to be declared**. The separate
[vendored MIT license](prototype/vendor/LICENSE) applies to the upstream wire code.

<p align="center"><em>devin-bridge · local text inference</em></p>
