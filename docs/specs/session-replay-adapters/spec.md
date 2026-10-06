# Session replay adapter repairs

4999 user acceptance reports, 2026-10-07.

- New Session must adopt a persisted, message-free draft with no native identity lazily; materialize the foreign session only at first prompt. Preserve draft id, cwd and existing settings. History-bearing sessions without native identity must still fail explicitly.
- OMP cold resume must append upstream interrupted-tail closers before future turn events. Old logs already containing invalid boundaries are not repaired or deleted.
- AGY must not close a step containing unresolved calls. Repeated native tool frames must not duplicate recorded calls/results. Native semantic tool names take precedence over numeric wire codes; unknown codes must not be presented as invented tool names.
- Native failed result/error steps must produce a failed turn with original error details. Missing authentication must also be visible as an AUTH failure and explanatory Chat text.
- Verify through whole-pack tarballs on 4999 and dev3. Preserve test homes, sessions and credential seed; keep Web test lines running. No registry publish is authorized for this repair round.
