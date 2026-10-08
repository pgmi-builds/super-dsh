# DSH runtime compatibility

Better Dash and Super Dash use the same DSH host APIs. The verified upstream source baseline for this alignment is `dsh-v0.2.1-alpha.1` (`5badb15009ae1756c3afe0ae0cef1faafc290ccc`). The pages in this directory include older official reference snapshots; check this baseline before using an API described by a snapshot.

On `0.2.1-alpha.1`:

- The runtime `dsh-invariants` plugin, `ctx.invariants`, and companion `./invariant` exports are removed. The archived invariant reference does not define an available extension API.
- Plugin subpaths provide display text through `<specifier>/locale/en.json` and localized sibling exports, and icons through `<specifier>/icon`. Subpaths do not read a separate `package.json`.
- Composer statistics use separate `activity` and `usage` entries.
- The native Plugin Manager refreshes profile package resolution when bundles are installed, enabled, disabled or removed. Replacing installed package code still requires a restart.
- Automation is part of the Web composition. Reminder tools depend on agent mode; they are absent in Minimal mode and subagents.

See the [official release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1) and the actual host package exports for the complete interface contract.
