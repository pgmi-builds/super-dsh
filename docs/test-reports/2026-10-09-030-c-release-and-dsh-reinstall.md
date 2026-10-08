# 0.3.0-c release and registry DSH reinstall

2026-10-09, Asia/Hong_Kong. User explicitly authorized GitHub push and npm publication of both packages as `0.3.0-c`, then uninstall/reinstall of PC and dev3 DSH and plugins, preserving settings, sessions, env, auth, credential seed, Corti and MCP servers. User will install Super D manually.

## Release verification

The final pair is the unchanged, previously accepted delivery pair from [alignment report](2026-10-08-dsh-021-alpha-alignment.md), SHA256 Better `a9287af10438fc48ca32a048392cf5192f5cef864fe152eb2b50c99e58061563`, Super `d9a2402dde554204d703e7cc342762d66ffeec54e1c2faec9a36608b90e2a37a`. Pair verification and npm publish dry-runs succeeded. No production code changed after the accepted pack.

Fresh final-source verification: root 27 passed; Hub and nine adapters 1753 passed / 1 skipped; Better 67 files, 709 passed / 4 skipped. Total 2489 passed / 5 skipped, 0 failures in final runs. First Better retry was caused by the operator supplying CHROME_BIN instead of DASHR_BROWSER_BIN; corrected real-browser full suite passed. The old-host regression uses the actual installed rc.2 app-boot module. Independent final review found no code blockers.

Real PC4999 delivery/auth/unique client graph/seven worlds were checked again before finalization. Native eval and cold resume passed on PC4999, small Better4997 and registry-host dev3 test4998. Five foreign runtimes passed create/prompt/cold-resume on both machines. Antigravity prompt remains externally blocked by billing QUOTA; its missing behavior acceptance is disclosed in the alignment report and is not treated as passed. dev3 tunnel browser load timed out; HTTP graph/model acceptance passed.

## Authorized reinstall scope

Target the user-managed global `@deepseek-ai/dsh` installation and DSH-home profile dependencies on each machine. Development upstream checkout, repository test homes and independent test host are not production installation targets. Keep `corti-memory` as the user's specified plugin exception, keep MCP rows and native user patch/settings, all sessions, attachments, agents' user data and authentication. Back up each DSH home and preserved files before destructive steps. Remove obsolete installed plugin trees and dependency/bundle registrations; retain user plugin configuration disabled when its package is removed. Install exact registry `@deepseek-ai/dsh@0.2.1-alpha.1`; restore only Corti. Do not install Super or Better.

Publication and reinstall receipts will be appended after verification. Private logs, manifests and backups are outside Git; no credential values are included.
