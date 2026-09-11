# oh-my-pi wire provenance

Only wire declarations and the codec are vendored. No agent/provider/router code.

Repository: https://github.com/can1357/oh-my-pi
Commit: `3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`
License: MIT, retained in `LICENSE`.

| Local file | Upstream path | Changes |
| --- | --- | --- |
| devin-proto.ts | packages/catalog/src/discovery/devin-proto.ts | None |
| protobuf.ts | packages/catalog/src/discovery/protobuf.ts | Inline isRecord to remove pi-utils dependency; guard indexed reads and iterate Object.entries for strict noUncheckedIndexedAccess |

The generated schema and complete shared codec intentionally retain upstream
structure rather than being split into invented abstraction layers.
Schema: 2,649 lines. Codec: approximately 1,080 lines.

`src/chat-request.ts` uses the metadata tuples from
`packages/catalog/src/wire/devin.ts` at the same SHA. No installed CLI is invoked.

The prior temporary devin-gateway codec and guessed field-number probe were
removed. Contrary to the earlier note, oh-my-pi's wire source is directly
available; it is not an inaccessible generated package.
