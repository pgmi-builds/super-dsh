# 4999 replay and new-session adapter fixes

User reported Hermes/Codex New Session failure in base, OMP corrupted replay, AGY unresolved calls/numeric tool labels and silent billing failures. Preserve old broken logs, repair future event production; no registry release authorized for these fixes.

- Diagnose the provided persisted logs and native CLI frames; trace official controller reuse and adapter resume with LSP/AST.
- Test/fix Hermes and Codex blank draft lazy adoption without allowing history-bearing missing native identity.
- Test/fix OMP interrupted cold resume boundaries; preserve old corrupt log.
- Test/fix AGY repeated/parallel tool frames, stable semantic tool names and native failed-step/turn errors.
- Build next letter tarball; regressions, 4999 whole-pack install and dev3 install; exercise actual UI/consumer behavior, write report, retain test lines for user.

Implemented and verified in D whole-pack lines; full checks 1,414 pass / 1 skip. Real blank reuse and Hermes/Codex replies passed both ends; OMP tool round and cold resume passed both ends; AGY AUTH/QUOTA failures correctly surfaced. Old corrupt logs unchanged. See docs/test-reports/2026-10-07-session-replay-adapter-fixes.md for browser and AGY tool-model acceptance limitations. No registry release or Git finalization this round.
