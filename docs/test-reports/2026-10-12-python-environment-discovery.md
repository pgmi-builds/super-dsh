# Python interpreter discovery correction

Date: 2026-10-12. Status: correction, independent review, full Better tests and PC/dev3 dual-tarball consumer acceptance complete. Test pair0.3.1-c remains available for user review. No npm publication or production change.

User explicitly requested aligning environment readiness with OMP after identifying legacy uv/3.11 provisioning and package-local Python environments in0.3.1. The fix changes environment discovery only; original OMP runner, dill and checkpoint implementation remain unchanged.

Existing explicit executable/path selection takes precedence. Otherwise probe an existing active/project environment and PATH `python3`, then `python`; broken automatic candidates fall back, explicit failures remain explicit. Session workspace determines project environments and relative explicit paths. Resolved absolute executable and environment activation reach the actual child. No interpreter/venv install, uv/pip execution, package-directory environment/cache or CPython/3.11 preference. Packaged dill0.4.1 still requires Python >=3.9. Native profile checkpoint ownership is retained. Old package-local environments are not deleted or automatically selected; incompatible old checkpoints receive the established recovery notice.

Removed startup provisioning and obsolete `kernelEnvDir`, `kernelPythonVersion`, `kernelAutoInstall` configuration. Replaced `kernel:venv` with read-only `kernel:check`. Updated README, guide and test interpreter selection so a package-local development venv cannot hide the consumer discovery behavior.

## Source investigation and regression

Pinned OMP reference: [runtime discovery](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/eval/py/runtime.ts). It reuses existing environments and probes interpreters; the discovery path does not create an environment. Better omits OMP's own managed-home candidate, uses its native profile for state, and tries both PATH names with Python3 first.

TypeScript LSP definitions, references and incoming/outgoing call hierarchy and TypeScript AST call-site inspection were actually used before implementation. Regression tests use real Python subprocesses under isolated PATH: default system selection even with uv present, python-only PATH, broken-python3 fallback, uv-only without Python, explicit python3 executable semantics, broken explicit selection, project/active environment reuse, broken environment fallback, relative explicit paths, and distinct session workspaces. Ten new assertions failed against old behavior and one existing explicit-failure behavior passed; all eleven pass after correction. The initial session test had a request-shape typo, corrected before the recorded RED run.

Independent review caught a delivery omission: renamed kernel-check script was missing from the package whitelist. Corrected before consumer use; the first `a` build was superseded by `b`. A final `c` rebuild also carries the corrected canonical discovery specification and marks the shipped old provisioning specification as historical. All pairs use the normal build channel. Final installed command execution is required below.

Initial full Better run:853 passed,12 skipped,6 browser failures because this invocation omitted the already available Chrome path. With the Chrome fixture supplied, a second run had857 passed,12 skipped and2 optional cross-package Hub failures while a concurrent rebuild removed its dist fixtures. The final full run is sequenced after the completed build to avoid that race; no source guard or test skip was added. Initial root test invocation overlapped the normal build's lib-directory cleanup and had one ENOENT in addition to the two known companion bugs; root rerun after the completed b build returned40/42 with only those two unchanged companion failures. No product workaround was added for either test setup error.

## Final delivery acceptance

Normal dual pack `0.3.1-c` completed and passed the pair verifier and original-resource verifier. Better SHA256 `21c90e58eb324433067542fb7f0e4a384f3a223caa8af17d6d5f2cdcfed55baf`; Super SHA256 `1ddd01aeb9ef1b1a57361de72f25cf7baadcdd2724515f25fecb7ef167f694a5`. OMP runner hash remains `e0e660ca44193735a2de467254b050109bb23028aca71af01b9365b9ab88e974`; all15 original dill/license resources verified. No kernel install hooks or retired transport files. [Pair](assets/2026-10-12-python-environment-discovery/pair-c.json), [resource proof](assets/2026-10-12-python-environment-discovery/artifacts-c.json).

Final full Better run after the completed c build: **859 passed,12 skipped;89 files passed,1 skipped**,206.77s. Both host/client typechecks passed. Final root suite:40/42; only the same two genuine unchanged companion bugs remain (legacy receipt rearming and lost native-operation diagnosis during polling). This correction does not fix or conceal those bugs. [Source checks and initial setup failures](assets/2026-10-12-python-environment-discovery/source-checks.json), [independent review](assets/2026-10-12-python-environment-discovery/review.md), [LSP](assets/2026-10-12-python-environment-discovery/lsp.jsonl), [AST before](assets/2026-10-12-python-environment-discovery/ast.json), [AST after](assets/2026-10-12-python-environment-discovery/ast-after.json).

### PC4999 actual consumer

Canonical launcher consumed the exact c pair, then native Plugin Manager installed Better c through the test pair registry; actual TEST restart loaded it. Fresh actual model session `session-489039ce-cdea-45e7-87e2-8f20f83b7611` ran native `eval`: call19/result22 printed existing PATH `/home/u1/.local/bin/python3` **3.14.8**, asserted no venv (`sys.prefix == sys.base_prefix`), no package executable, set142 and used native `tool.read` with hashline output. After TEST restart, call39/result40 asserted the existing142 without reconstruction and returned a turn1 snapshot restore notice. Final checkpoint turn2/hash verified, no omissions; actual model eval descriptor equals installed markdown (3029 bytes).

The existing PC PATH Python itself was previously installed by the user through uv: its base prefix is `/home/u1/.local/share/uv/python/cpython-3.14.8-linux-x86_64-gnu`. This acceptance reuses that existing executable; it does not claim an OS-package installation or a new uv download. No uv process/provisioning is required. The independent installed-command fixture below uses `/usr/bin/python3`3.14.4. [PC native events, surface, manifest and installed checks](assets/2026-10-12-python-environment-discovery/pc-c.json).

### Dev3 independent installed host

Exact received c archive hashes verified. Canonical launcher used retained `.tests/foreign-substrate`, profile `superd-pub`, test4998 and independent installed DSH0.2.1-alpha.1 anchor. Native Plugin Manager installed Better c, then TEST restart. Fresh model session `session-96f5b3d5-1f0d-4318-b9e8-60d71923ac59`: call18/result21 directly used **`/usr/bin/python3`3.14.4**, prefixes `/usr`/`/usr`, native hashline read and142. Actual TEST restart followed by one same-session assertion restored142 from turn1. Final checkpoint turn2/payload hash verified, no omissions, original runner/dill resource hashes verified and3029-byte native model description equals the installed document. [Dev3 actual evidence](assets/2026-10-12-python-environment-discovery/dev3-c.json).

Before model submission, target launcher preparation needed the already existing `SUPERD_SOCAT_BIN=$REPO/.scratch/socat` and `SUPERD_TEST_DEV_WEBMCP_PREBUILT=1` knobs (the consumer target has no TypeScript compiler). Initial missing-socat attempt exited before mutation; the missing-compiler attempt stopped own TEST/relay units and exited before product/model execution. A moved read-only preflight driver's cookie path was corrected to reuse the retained RPC cookie. These preparation failures submitted no target model cell. No business source or alternative startup mechanism was introduced; normal launcher then restored the owned units. Homes, credentials, pairing and sessions were retained throughout.

### Installed availability-command checks

On BOTH installed Better c packages, ran the delivered `scripts/kernel-check.mjs` through Node under an isolated PATH. With only an executable uv present and no Python, it returned an actionable missing-Python error and never executed uv (marker absent). Adding only an existing `/usr/bin/python3` interpreter under the name `python` made the command succeed, still without executing uv. Neither installed package gained `.venv-kernel` or `.uv-cache`. These checks exercise delivered compiled code and the script whitelist, not source-only helpers.

### Retained test line and limits

PC [public test URL](https://test.pc.internal.test/) and [LAN4999](http://192.0.2.130:4999/) returned200. PC4999 and dev3 TEST4998 each have14 ready agents,0 world-failed logs in their current invocation and three active TEST/registry/relay units. Existing4996 dev3 review forwarding remains active. Production homes/ports/services were untouched.

Actual environment execution was verified on Linux CPython3.14.8/3.14.4 and existing-project environments in real-process tests. This report does not claim runtime verification of PyPy or Windows; the resolver applies no CPython implementation gate. Tests of interpreter discovery are Unix fixtures, clearly marked in the suite.

Changes remain on `codex/omp-python-environment` for review, with unrelated local reports and the earlier unrelated-work stash preserved. No git commit/tag/push or npm publish was performed for this correction. Public registry `latest` remains0.3.1 for both packages; c is the tested local delivery pair.
