# Shared documentation and provenance

Super D now owns the active source, shared documentation and references for both npm packages. Start with the [development guide](07-cordis-dsh-dev-test-guides.md), [current Hub blueprint](00-blueprint.md), [boundaries](01-component-boundaries.md) and [root glossary](../CONTEXT.md).

| Collection | Purpose |
| --- | --- |
| `specs/`, `superpowers/plans/`, `test-reports/` | Active feature specifications, plans and delivery evidence |
| `00_adr/`, `10_plans/`, `20_specs/`, `50_test-reports/` | Preserved dated Better Dash design and change history |
| `80_upstream-docs-and-skills/` | Shared public upstream references and skill sources imported from Better Dash |
| `legacy/better-dash/` | Conflicting original root rules, glossary, README and environment notes; preserved with provenance |
| `package-catalog.json` | Explicit Better Dash npm documentation selection; supports source-to-target aliases for historical package paths |

Matching shared files were reused. Different root documents were preserved rather than overwritten. Earlier reports describe their original environments and keep those paths; they are historical evidence. The original `/home/u1/workspaces/dashr` checkout is retained unchanged and is not a build input.

`docs/60_exploration-and-research/` and local skill variants are ignored working references. Published reference/skill source is under `80_upstream-docs-and-skills/`; local agent skill installations are development tooling, outside both npm packs.

The version/history/layout decision is recorded in [the monorepo spec](specs/monorepo-030/spec.md). Hub-only documents remain in the shared tree but are absent from the Better Dash package unless deliberately selected. Better runtime resources in `better-dsh/dsh-docs/` remain package-owned assets.
