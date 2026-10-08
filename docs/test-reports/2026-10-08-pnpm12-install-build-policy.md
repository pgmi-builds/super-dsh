# Super Dash 0.3.0: pnpm 12 default-install policy

Date: 2026-10-08 (Asia/Hong_Kong).

## Distinct failure stages

The earlier `spawn pnpm ENOENT` was caused by the production DSH service PATH omitting the directory containing pnpm. It occurred before package lookup and was not an npm/pnpm version incompatibility. The canonical global executable repair resolved that lookup, verified through the actual production Plugin Manager HTTP RPC.

The new `pnpm blocked install scripts` failure occurs during package installation. pnpm 12.10.1 defaults to strict dependency-build decisions; packages with an undecided install script fail installation. npm is not executing this installation.

## Reproduction

Used the actual dev3-installed DSH 0.2.0-rc.2 public `runPluginCommand` entry point, with the published `super-dsh@0.3.0`, pnpm 12.10.1, and an isolated profile at `.tests/pnpm12-install/profiles/repro`. No production home was read or modified. The profile disabled automatic peer installation and used a hoisted linker; no global build-policy relaxation or `--ignore-scripts` was used.

The default install exited **1**, reporting `ERR_PNPM_IGNORED_BUILDS` for:

- `@google/genai@1.52.0`: `preinstall` prints `preinstall: no-op`.
- `protobufjs@7.6.6`: `postinstall` checks dependent version declarations and may print a warning; it generates no runtime build artifact.

Inspected the actual installed package manifests and protobufjs postinstall source in this isolated profile. These registry packages ship their runtime code already built.

The failed pnpm 12 run left no `allowBuilds` placeholders in this profile's workspace YAML. The installed DSH build-approval reader recognizes pending names only from `allowBuilds` scalar entries whose value is `set this to true or false`. That observed mismatch explains why a manual-policy fallback can appear instead of the UI's normal approval button. Upstream source was not modified.

## Verified scoped decision

Added only these exact package-version entries in the isolated profile:

```yaml
allowBuilds:
  "@google/genai@1.52.0": false
  "protobufjs@7.6.6": false
```

`false` is an explicit decision to skip the script; unlike an undecided package, it satisfies pnpm's strict policy. It does not disable strict checks for other dependencies.

Retried the same native install without `--ignore-scripts` or a strict-policy override. It exited **0** and installed Super Dash **0.3.0**. Imported the resulting Google SDK and verified the `GoogleGenAI` export; encoded and decoded a protobuf message through the installed protobufjs runtime, obtaining the original text.

Evidence copied to the PC: `.scratch/independent/dev3-pnpm12-install-repro.log` and `.scratch/independent/dev3-pnpm12-install-explicit-policy.log`. Prepared merge fragment: `.scratch/independent/pnpm12-super-dsh-build-policy.yml`.

The earlier release acceptance used `--ignore-scripts`, so it did not exercise the default installation's undecided-script gate. This report adds that installation-policy reproduction; it does not claim new browser/model acceptance or successful production installation.

## Superseded production proposal

The user rejected a consumer policy requirement. Do not apply the fragment to production. The product fix physically bundles the full prebuilt Pi SDK closure; see [complete tarball and native URL installation report](2026-10-08-pi-bundled-delivery.md). The production command is `dsh web`, selecting the `web` profile. No production profile file, running service configuration, Caddy configuration, or upstream source was changed during this investigation.

Official reference: [pnpm build settings](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/settings/build.md), `strictDepBuilds` and `allowBuilds`.
