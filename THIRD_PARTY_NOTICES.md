# Third-party notices

This repository develops two independently published npm packages (`better-dsh/`,
`super-dsh/`). License headers: root [LICENSE](LICENSE) covers the repository;
each package directory carries its own LICENSE where the lineage differs.

| Component | Relationship | License | Upstream |
|---|---|---|---|
| [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) | Host runtime / optional peer; consulted as development reference | MIT | <https://github.com/deepseek-ai/deepseek-harness> |
| `better-dsh` lineage: `pi-hashline-edit` / `pi-hashline-edit-pro` | Original work this toolchain derives from | MIT | see [`better-dsh/LICENSE`](better-dsh/LICENSE) (RimuruW and Yugimob) |
| `@deepseek-ai/schemastery`, `@deepseek-ai/cosmokit`, `@standard-schema/spec` | Vendored source copies inside better-dsh | MIT | see [`better-dsh/THIRD_PARTY_NOTICES.md`](better-dsh/THIRD_PARTY_NOTICES.md) |
| `@ast-grep/wasm`, `web-tree-sitter`, `@lumis-sh/wasm-*` grammars | Vendored source copies inside better-dsh | MIT | see [`better-dsh/THIRD_PARTY_NOTICES.md`](better-dsh/THIRD_PARTY_NOTICES.md) |
| `@earendil-works/pi-coding-agent` | Embedded runtime tree inside `super-dsh/agent-pi/runtime/` (lockfile-pinned, bundled dependency delivery) | MIT | <https://www.npmjs.com/package/@earendil-works/pi-coding-agent> |
| `@openai/codex`, OpenAI Codex desktop core | Fetched at runtime into the agent world home on first use (never bundled, no install-time download) | upstream terms | <https://github.com/openai/codex> |
| OMP, Claude Code, Hermes Agent, Antigravity | External foreign-agent runtimes discovered and connected at runtime; source not embedded | upstream terms | respective vendors |

Package-level attribution details and pinned versions live in
[`better-dsh/THIRD_PARTY_NOTICES.md`](better-dsh/THIRD_PARTY_NOTICES.md);
provenance for the generated `super-dsh/remote/` closure is recorded in
`super-dsh/remote/provenance.json`.
