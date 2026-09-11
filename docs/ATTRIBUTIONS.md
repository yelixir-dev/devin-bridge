# Attribution registry

Generated from attributions.json (2026-09-11) by scripts/build-attributions.mjs — do not edit by hand.

## Oh My Pi — Devin wire declarations and protobuf codec

- Source: https://github.com/can1357/oh-my-pi
- Revision: `3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`
- License: [MIT](../prototype/vendor/LICENSE)
- Copyright (c) 2025 Mario Zechner
- Copyright (c) 2025-2026 Can Bölük
- Copyright (c) 2026 Stencil Labs, Inc.

| Local file | Upstream source | Processing |
| --- | --- | --- |
| [prototype/vendor/devin-proto.ts](../prototype/vendor/devin-proto.ts) | [packages/catalog/src/discovery/devin-proto.ts](https://github.com/can1357/oh-my-pi/blob/3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec/packages/catalog/src/discovery/devin-proto.ts) | Verbatim protocol declarations. |
| [prototype/vendor/protobuf.ts](../prototype/vendor/protobuf.ts) | [packages/catalog/src/discovery/protobuf.ts](https://github.com/can1357/oh-my-pi/blob/3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec/packages/catalog/src/discovery/protobuf.ts) | Inline isRecord instead of importing pi-utils; guard indexed reads and use Object.entries for strict noUncheckedIndexedAccess. |
| [prototype/src/chat-request.ts](../prototype/src/chat-request.ts) | [packages/catalog/src/wire/devin.ts](https://github.com/can1357/oh-my-pi/blob/3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec/packages/catalog/src/wire/devin.ts) | Client metadata constants are adapted; request assembly is local. |

No upstream agent framework, provider implementation, or model-routing policy is included.

## License separation

Project license: to be declared. Original third-party licenses remain in force; the project license does not replace, narrow, or relicense them. No listed author or affiliated organization endorses this project.
