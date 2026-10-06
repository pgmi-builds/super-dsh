# Antigravity Hub plugin implementation plan

**Goal:** Complete the sixth foreign runtime's real Hub tool and bidirectional delivery before the authorized B release.

**Architecture:** The native CLI plugin packages an stdio MCP tool bridge to the existing loopback Hub. MCP supplies only the tool catalog/calls; incoming messages use the Hub's existing bound live agent and the owned CLI stream-json input, independent of any tool call. Native unbound sessions register the tool but receive the post office's address error. No skills, rules, prompt injection, SSE notifications, or native-home redirection.

**Spec:** `docs/specs/foreign-substrate-wave2/spec.md`. User authorized completing Antigravity before publishing 0.1.11b on 2026-10-07.

## Tasks

- [x] Test owned native installation, preserving native plugins, standalone no-address rejection, bound real HTTP calls, and capability revocation.
- [x] Implement the plugin under Hub delivery, official install/enable, public endpoint refresh, and lazy CLI preparation with private child environment.
- [x] Register create/resume delivery handles before tool use; close revokes bindings, including never-started clients.
- [ ] Build the whole tarball, run relevant regressions, install through both launchers, verify create/prompt/resume, real exec/send/reply, and a zero-tool passive receiver.
- [ ] Record evidence, review, commit/push master, publish the authorized canonical npm B version, retain 4999, clean development artifacts.

Current gate: code/build/regressions complete; actual model acceptance awaits native local authentication and dev3 project billing recovery. No AGY commit or B publish yet. Existing validated five already merged/pushed as 5bb69f1.
