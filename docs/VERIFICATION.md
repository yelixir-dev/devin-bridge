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

## Remote tool-call stress baseline

A later run used the installed OmO ModelRuntime and its configured
`yorha/swe-2` model without changing the endpoint, flattening user content, or
substituting another model. All 38 primary requests used text-block arrays and
returned HTTP 200. Eighteen of twenty checks passed, including:

- Six parallel calls followed by results submitted in reverse order.
- Five dependent steps whose next arguments used fresh random tool results.
- Tool-error recovery and three independent tool-result round trips.
- Typed/nested arguments, optional fields, no-tool instructions and a long
  Unicode payload.

The two first-run failures were retained. One response exposed an XML invocation
as ordinary text instead of a native tool call. Another native call omitted six
NUL characters from a mixed escaping/control-character argument.

Three additional diagnostic requests did not replace those first outcomes.
The short case passed on repeat; the repeated-string case failed again, this
time by double-escaping quotes, backslashes and whitespace; the control with
NUL removed passed. The remote SSE arguments already contained the same values
as the final SDK arguments. This rules out SDK delta assembly for that observed
corruption, but does not by itself isolate the inference model from an upstream
tool parser.

These 41 calls are a diagnostic sample, not a reliability estimate or proof
that NUL always fails. Tool executors were simulated fixtures; the inference
requests and result-consumption checks were real. No remote deployment was
performed by the test runner.

## Native RPC comparison

The bridge-side investigation compared decoded `GetChatMessage` protobuf tool
fragments with the HTTP accumulator, bypassing OmO and the remote proxy. Four
fixed-model `swe-2-high` requests used the repeated mixed-control-character case:

| Diagnostic request | Exact argument match | Raw fragments equal bridge arguments |
| --- | --- | --- |
| Existing defaults | Yes | Yes |
| XML parsing experiment disabled | No | Yes |
| Strict tool definition | Yes | Yes |
| Named tool choice | No | Yes |

The two failures were already double-escaped in native upstream tool arguments.
The bridge accumulator did not introduce that escaping. The diagnostic
experiment was not made a production default, and the isolated strict success
is not proof that strict mode fixes string fidelity. Three additional local
HTTP baseline calls (short, repeated, and no-NUL control) all passed, further
showing that this is not a deterministic NUL rejection.

The bridge must preserve valid argument bytes rather than globally unescaping
strings or inventing missing characters. Text that merely describes an XML
invocation must not automatically become an executable tool call.

## Tool-response contract hardening

The bridge now enforces declared names and required/named/none choices, rejects
upstream invalid-parser/custom-tool flags, and checks complete native JSON against
its terminal reason. JSON failures return 502 with `invalid_tool_call`; SSE
failures emit an error without a successful terminal marker. XML examples remain
literal text when a native call is not required.

Before the guard, the new boundary suite recorded 9 passing and 19 failing
tests: invalid responses returned JSON 200 or a successful SSE `[DONE]`.
Afterward, all 118 tests passed, including wire fidelity for all C0 controls,
Unicode and literal escapes. Type checking, diagnostics and the build passed.

Post-patch live validation used a restarted local server and the real upstream:

- Short mixed-control-character and repeated no-NUL requests passed.
- The repeated NUL/escape request still returned a valid but double-escaped
  string (450 UTF-16 units instead of 408). This is an unresolved upstream
  semantic-fidelity failure, not a successful repair.
- Installed OmO ModelRuntime completed a native `add_numbers(17, 25)` call and
  consumed a correlated tool result containing 42 and a fresh random receipt.

No heuristic string repair, XML-to-call conversion, retry, model fallback,
experimental request mode, or strict-default change was introduced. This
increment fixes false-success handling for detectable contract violations; it
does not fix arbitrary upstream generation errors. Deploying the commit to a
remote service is a separate operator action, followed by another live test.

## Completion pipeline consolidation

A supplied third-party reference implementation was compared read-only against
this bridge. Its protobuf schema differed from the vendored schema only by a
trailing blank line and its string codec path was equivalent, so it offered no
fix for the upstream escaping failures above. It did motivate three changes:

- **JWT caching.** `GetUserJwt` was called once per completion. The user JWT is
  now cached per credential and refreshed one minute before its `exp` claim,
  with concurrent callers sharing one in-flight fetch and failures never cached.
  A live check against the real auth endpoint made three concurrent and one
  later request: one upstream call, one distinct token, 612 ms for the first
  caller and 0 ms for the cached caller. The observed JWT lifetime is 900 seconds;
  the fallback lifetime without a readable `exp` is five minutes.
- **One completion validator.** JSON and SSE previously ran separate event loops
  with different failure codes for a stream that ended without a terminal event
  (`empty_response` versus `protocol_error`). Both now consume a shared
  `CompletionState`; the boundary suite asserts identical failure behavior.
- **Newline-limit truncation.** `StopReason.MAX_NEWLINES` previously surfaced as
  `unsupported_stop_reason`; it is now reported as `finish_reason: "length"`.
  A live probe requesting 260 numbered lines returned all 260 lines with a
  normal stop under both the default `maxNewlines` of 200 and 4096, so the
  configured limit was not enforced upstream in that sample; the mapping is a
  correctness fix for the case where it is.

Tools declared `strict: true` are now checked against their declared JSON
Schema before a call is returned (52 validator tests cover the supported
keywords; unknown keywords are ignored). Non-strict tools keep OpenAI
pass-through semantics. Red tests captured 9 failures before the change
(schema violations returned 200, JSON missing-terminal returned
`empty_response`, `MAX_NEWLINES` errored); afterward all 189 tests passed with
type checking, diagnostics and the build.

Post-change live checks against the restarted local server and real upstream:
a strict `add_numbers` call returned `{"a": 17, "b": 25}` with
`finish_reason: "tool_calls"`; three sequential text completions returned
`OK`; the three mixed-control-character HTTP cases repeated their earlier
outcome (the repeated NUL/escape case remains an upstream fidelity failure);
and the installed OmO ModelRuntime completed the two-turn native tool round
trip with a fresh random receipt.

## Second remote run after redeployment

After the operator redeployed the remote gateway, the same 20-check live suite
(38 real requests through the installed OmO runtime, block-array content,
`max_tokens`, high reasoning, no fallback) was run again:

| Measure | First run | Second run | Third run |
| --- | --- | --- | --- |
| Checks passed | 18 of 20 | 18 of 20 | 19 of 20 |
| HTTP 200 responses | 38 of 38 | 38 of 38 | 38 of 38 |
| Total wall time for 38 turns | 502 s | 195 s | 287 s |
| Total reported tokens | 25,708 | 24,504 | 25,754 |
| Turns with upstream prefix-cache reads | 15 | 15 | 16 |

The third run followed the deployment of the build-identity release: a request
through the remote gateway returned `system_fingerprint: "devin-bridge-0.1.0"`
before the suite started, which is the first deployment confirmed from outside
the proxy. Its only failure was the 64-line NUL case (NUL characters dropped);
the short and streamed NUL cases passed on that run.

Every baseline workflow passed again: parallel calls with reverse-order results,
five random dependent steps, error recovery, repeated round trips, enum and
optional-field handling. The wall-time drop cannot be attributed to the bridge
alone; upstream latency varied widely between runs.

The failures moved between runs: the streamed six-copy case failed only in the
first run, the short case failed in the first two, and the 64-line case failed
in the last two. Every failure observed so far, across three remote runs and
the native diagnostics, involved a requested `\u0000` (NUL) character, and the
failure shape changed each time: dropped NUL, `\null` in place of
`\u0000null`, double-escaped quotes and backslashes, or an XML invocation
returned as text. No case without NUL has failed in any run. This is an observed
correlation in a small sample, not a specification; the bridge forwards the
bytes it receives and cannot detect or repair a syntactically valid string that
differs from what was requested. The live harness now reports these three NUL
scenarios separately from unexpected failures so that a bridge regression is
not masked by the known upstream class.

Prefix-cache reads occurred with a fresh `cascadeId` on every request, so the
reference implementation's per-conversation `cascadeId` reuse is not required
for upstream caching and was not adopted.

The deployed build could not be identified from outside because the remote
gateway sits behind a proxy and the bridge exposed no build identity. A baseline
request through the remote gateway returned no `system_fingerprint`. Completions
and SSE chunks now carry `system_fingerprint: "devin-bridge-<version>"` and
`/health` reports `version`; a test keeps the runtime constant equal to
`package.json`. The 191-test suite, type check, diagnostics and build passed.

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
