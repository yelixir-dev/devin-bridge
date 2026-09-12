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

The original 20 automated tests additionally covered JSON/SSE output, exact-model routing,
Connect error propagation, truncated frames, invalid trailers, a reported
different model, and TOML credential parsing. They use local fixtures rather
than paid inference. The full suite, strict TypeScript check, and Bun bundle
completed successfully.

One regression was isolated before the successful inference: request field 7
was encoded as GENERAL=1 instead of CASCADE=5. A wire-boundary test failed with
expected 5 / received 1, then passed after correcting that discriminator.
Changing model identities had not addressed the actual defect.

## SWE-2 effort and native tools

The public catalog groups the three SWE-2 variants into one entry:

```json
{
  "id": "swe-2",
  "reasoning_efforts": ["medium", "high", "max"],
  "default_reasoning_effort": "high"
}
```

This is an excerpt of the catalog entry; the ordinary OpenAI model fields remain.
An actual `model: "swe-2"` / `reasoning_effort: "high"` HTTP request returned
`model: "swe-2-high"`, text `OK`, a normal `[DONE]`, and 472 input / 33 output
tokens in 3.832014 seconds. These are individual observations, not benchmarks.

A separate native function-tool round trip verified more than a text answer:

1. The client supplied `add_numbers` with an integer schema and
   `tool_choice: "required"`, requesting arguments 17 and 25.
2. SWE-2 returned `add_numbers_0`, `{"a": 17, "b": 25}` and
   `finish_reason: "tool_calls"` over five tool-call deltas, including the initial
   ID/name event.
3. The client executed the addition and sent `sum: 42` plus a freshly generated
   receipt string as a `role: "tool"` result using the same `tool_call_id`.
4. The next model response reported both 42 and the exact random receipt.
   This checks result consumption rather than relying on the model knowing
   simple arithmetic. The two-turn flow took 5.310944 seconds.

The first integration attempt exposed a wrong mapping copied from a reference:
`required` was translated to `any`, which this SWE-2 path rejected with
`invalid_argument`. Controlled requests showed that native `auto` and native
`required` both work. The bridge now forwards `required` unchanged.

Regression coverage now includes:

- All three efforts, the high default, grouped discovery, partial catalogs,
  old raw IDs, invalid/conflicting efforts, and refusal without fallback.
- Native tool schemas, choices, parallel flags, assistant call history,
  matching tool results, cumulative/incremental arguments and stable indices.
- Tool-only JSON/SSE responses, malformed arguments, and errors after partial
  tool output. The bridge never executes client tools.

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
