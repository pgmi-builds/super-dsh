# 0.3.0-c release and registry DSH reinstall

2026-10-09, Asia/Hong_Kong. User explicitly authorized GitHub push and npm publication of both packages as `0.3.0-c`, then uninstall/reinstall of PC and dev3 DSH and plugins, preserving settings, sessions, env, auth, credential seed, Corti and MCP servers. User will install Super D manually.

## Release verification

The final pair is the unchanged, previously accepted delivery pair from [alignment report](2026-10-08-dsh-021-alpha-alignment.md), SHA256 Better `a9287af10438fc48ca32a048392cf5192f5cef864fe152eb2b50c99e58061563`, Super `d9a2402dde554204d703e7cc342762d66ffeec54e1c2faec9a36608b90e2a37a`. Pair verification and npm publish dry-runs succeeded. No production code changed after the accepted pack.

Fresh final-source verification: root 27 passed; Hub and nine adapters 1753 passed / 1 skipped; Better 67 files, 709 passed / 4 skipped. Total 2489 passed / 5 skipped, 0 failures in final runs. First Better retry was caused by the operator supplying CHROME_BIN instead of DASHR_BROWSER_BIN; corrected real-browser full suite passed. The old-host regression uses the actual installed rc.2 app-boot module. Independent final review found no code blockers.

Real PC4999 delivery/auth/unique client graph/seven worlds were checked again before finalization. Native eval and cold resume passed on PC4999, small Better4997 and registry-host dev3 test4998. Five foreign runtimes passed create/prompt/cold-resume on both machines. Antigravity prompt remains externally blocked by billing QUOTA; its missing behavior acceptance is disclosed in the alignment report and is not treated as passed. dev3 tunnel browser load timed out; HTTP graph/model acceptance passed.

## Authorized reinstall scope

Target the user-managed global `@deepseek-ai/dsh` installation and DSH-home profile dependencies on each machine. Development upstream checkout, repository test homes and independent test host are not production installation targets. Keep `corti-memory` as the user's specified plugin exception, keep MCP rows and native user patch/settings, all sessions, attachments, agents' user data and authentication. Back up each DSH home and preserved files before destructive steps. Remove obsolete installed plugin trees and dependency/bundle registrations; retain user plugin configuration disabled when its package is removed. Install exact registry `@deepseek-ai/dsh@0.2.1-alpha.1`; restore only Corti. Do not install Super or Better.

## Publication receipt

Release commit `8ec860f9405b8dee2e4e3042c9d65c91c9af0943` fast-forwarded GitHub master; annotated `v0.3.0-c` peels to the same commit. Atomic push succeeded and remote refs were checked. No unrelated untracked local files were staged.

Each accepted tarball was submitted once from the existing authenticated dev3 npm account, Better first, then Super, using `npm publish <tarball> --ignore-scripts --access public --tag latest`. Both commands exited 0. After registry processing, both latest tags are `0.3.0-c`; Super next remains `0.1.12-a`. Registry SHA1 and SHA512 integrity match the exact accepted archives. Better's downloaded archive matched SHA256 locally; Super's full 31,441,804-byte registry download matched SHA256 on dev3. A PC download encountered ECONNRESET; it did not cause a repeat publish.

## Reinstall receipt

Both global installations were actually removed before fresh registry installation of `@deepseek-ai/dsh@0.2.1-alpha.1`. Both CLIs report the exact version and both `dsh.service` units are active. No Caddy, port3081, Corti source repository or other agent CLI installation was changed. Repository4999 and isolated target test environments remain separate and retained.

| Check | PC | dev3 |
| --- | --- | --- |
| Protected existing files unchanged immediately after installation | 3233 | 526 |
| Original MCP blocks byte-for-byte retained | 4 | 2 |
| Profile trees cleared of old plugin installs/adapter bundle registrations | 8 | 13 |
| Only user-installed bundle remaining | corti-memory 0.3.0 | corti-memory 0.1.0 |
| Enabled failed plugins | 0 | 0 |
| MCP/Corti host fibers | all active | all active |
| Native clients unique | 67 | 66 |
| Native old sessions listed | 978 | 70 |
| Anonymous API denied | 401 | 401 |

Profile dependencies removed on PC: dshmarket and obsolete direct schemastery declaration; on dev3: task-board, Super and Better. Rebuilt clean profile dependency trees with only the exact preserved Corti artifact and its real dependencies. Main profile Better compaction/failover rows retain their config values but are disabled because their packages are absent. Default native base/web bundles remain. World user homes and session/auth/env/settings files are preserved; obsolete world adapter bundle entries are removed.

Full private DSH-home backups and exact Corti artifacts are at `/home/u1/.local/state/dsh-reinstall-20261009-030c/` on each machine, in owner-only directories. Core installation and Corti reinstall exit 0 on both. node-pty and koffi load from the actual new registry installation on both machines; no additional global build-policy override was made.

PC Chrome rendered the new native UI with zero page errors. Native HTTP manager/session checks also passed on dev3. After service/browser use, PC's workspace view state changed; dev3's existing live session appended one event. The dev3 original 689-event history remains exactly unchanged as the prefix of the current 690 events. These are normal post-install runtime writes; the immediate post-install preservation checks above passed. No live user activity was rolled back to a backup.

Super and Better are not installed in either production profile. The user will install Super manually. Private logs, manifests and backups remain outside Git; no credential values are included.
