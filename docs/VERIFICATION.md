# Local verification

Observed on 2026-09-11 using Bun 1.4.1 on Linux x86-64.
These results describe this prototype, not the complete planned bridge.

## Real SWE-2 call

A request to local `POST /v1/chat/completions` used:

```json
{
  "model": "swe-2-medium",
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 128,
  "messages": [{ "role": "user", "content": "Reply with exactly: OK" }]
}
```

| Observable | Result |
| --- | --- |
| HTTP status | 200 |
| Content type | text/event-stream |
| Model | swe-2-medium |
| Visible response | OK |
| Finish reason | stop |
| End marker | data: [DONE] |
| Input tokens | 472 |
| Output tokens | 34 |
| Total tokens | 506 |
| curl total time | 6.515067 seconds |

The request used the direct Connect RPC path with oh-my-pi wire code.
No Devin executable or ACP process was launched and no alternate model was tried.
This is one observed request, not a benchmark. It does not establish a speed
advantage over the CLI or prove support for every model in the account catalog.

## Failure behavior

Real local HTTP requests returned 404 for an unknown model, 400 for malformed
JSON, and 401 for a missing local client key.

The 20 automated tests additionally cover JSON/SSE output, exact-model routing,
Connect error propagation, truncated frames, invalid trailers, a reported
different model, and TOML credential parsing. They use local fixtures rather
than paid inference. The full suite, strict TypeScript check, and Bun bundle
completed successfully.

One regression was isolated before the successful inference: request field 7
was encoded as GENERAL=1 instead of CASCADE=5. A wire-boundary test failed with
expected 5 / received 1, then passed after correcting that discriminator.
Changing model identities had not addressed the actual defect.

## Reproduce

Follow the [README](../README.md) to start the service and make an authorized
small request. From `prototype/`, run:

```sh
bun run typecheck
bun test tests
bun run build
```

The verification server and test resources were stopped afterward. Private
research transcripts, local paths, account tokens, and machine-specific logs
are not included in the public repository.
