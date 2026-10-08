# dev3 Plugin Manager: pnpm lookup diagnosis

Date: 2026-10-08 (Asia/Hong_Kong).

User reported that the native Web UI Add Plugin lookup for `super-dsh` failed with `spawn pnpm ENOENT`.

## Reproduction and cause

- dev3 production `dsh.service` is active and starts `/home/u1/.local/bin/dsh web`.
- Its running process PATH contains system directories but omits `/home/u1/.local/bin`.
- `/home/u1/.local/bin/pnpm` exists; its Corepack target also exists. Installing another package manager is unnecessary.
- A read-only probe in `/tmp`, using the running service PATH, reproduced `FileNotFoundError`, errno 2, when launching `pnpm view super-dsh name version description dsh --json --config.fetch-retries=0 --registry=https://registry.npmjs.org`.
- The identical probe with only `/home/u1/.local/bin` prepended exited 0 and returned `super-dsh`, version `0.3.0`, its description and declared bundle.
- The dev3 tarball test service `superd-4998-test.service` already includes `/home/u1/.local/bin` in PATH. This explains why the earlier test installation did not expose the production service environment discrepancy.

## Initially prepared remediation

The local candidate `.scratch/independent/dev3-dsh-package-manager-path.conf` adds the existing executable directory through an ordinary systemd `[Service]` Environment setting. Intended destination: `/home/u1/.config/systemd/user/dsh.service.d/20-package-manager-path.conf` on dev3.

After explicit user authorization, install that drop-in, reload the user systemd configuration, and restart `dsh.service`. Verify the new running process PATH and the native Plugin Manager registry inspection. Preserve the existing service settings and production user data.

At that stage, no production home files, service configuration, live Caddy configuration, production packages, or upstream source were changed. No production restart was performed. That initial probe established the cause and verified the proposed PATH change with a read-only registry query.

## Completed toolchain repair

The user subsequently reported restarting DSH without resolving the error and requested the latest npm/pnpm, with one installed version, matching the PC approach.

- The restarted production service PID was `386805`; its PATH still lacked `/home/u1/.local/bin`. The proposed drop-in had not been applied. Restarting alone therefore reproduced the same missing executable condition.
- Registry `latest` metadata read during this repair: npm **12.2.0**, pnpm **12.10.1**. npm's declared Node engine range includes dev3's existing Node **24.15.0**; changing Node was unnecessary.
- Updated dev3's canonical system-global packages in place with `sudo npm install --global --prefix /usr npm@12.2.0 pnpm@12.10.1`. Executables now resolve through `/usr/bin`, already present in the running production service PATH.
- Removed the old user-global npm **12.0.2** using npm's prefix-scoped uninstall, removed only the user-level pnpm/pnpx Corepack shims, and removed old pnpm **10.33.2** / **11.7.0** tool caches under Corepack and `.local/share/pnpm/.tools/pnpm`. Other user-global applications and package-content stores were retained.
- PC npm was already **12.2.0**. Updated its single global pnpm installation from **12.9.1** to **12.10.1**, in the existing `/opt/node-v26.10.0-linux-x64` prefix. The initial unprivileged update failed on filesystem permissions before replacing the package; the sudo update completed and executable verification passed.
- That initial inventory covered the standard system and `.local` prefixes and service PATH, but omitted the interactive shell's `.npm-global` prefix. Its initial claim of a complete single-version inventory was incorrect; see the correction below. `/bin` and `/usr/bin` aliases on dev3 do not represent distinct versions. Project dependency locks and intentional project pins were not changed.

### Actual running-service verification

1. The original `pnpm view super-dsh name version description dsh --json --config.fetch-retries=0` command, run with the production DSH process's actual PATH, now exited **0**, returned **0.3.0**, and emitted no stderr.
2. Authenticated to the existing production browser-auth endpoint using the service's own startup login URL, held only in memory. No login token or cookie was printed or saved. The native production HTTP RPC `pluginManager/inspect`, with `spec: super-dsh`, returned HTTP **200**, `result.ok: true`, `status: accepted`, `kind: registry`, `bundle: true`, and `version: 0.3.0`.
3. Both production `dsh.service` and tarball test `superd-4998-test.service` remained **active**. Production DSH PID remained **386805** throughout the repair. npm and pnpm on both hosts reported **12.2.0** and **12.10.1**, respectively.

No production restart, DSH/Super Dash package installation, service drop-in application, production home modification, Caddy change, upstream source modification, or npm publication was performed. The initial PATH drop-in is superseded by placing the single global package-manager executable in the already-visible system directory. The actual Plugin Manager lookup failure is resolved; the user can retry installation in the existing Web UI.

## Correction: interactive CLI selected an omitted pnpm installation

The user's subsequent CLI installation reported an existing `v11` store but a requested `v10` store. A read-only login/interactive-shell probe (`bash -lic`) found `.bashrc` prepending `/home/u1/.npm-global/bin` to PATH. That directory still contained pnpm **10.33.2**, taking precedence over `/usr/bin/pnpm` **12.10.1**. The CLI's default store was therefore `v10`, while the system pnpm used `v11`. This was a missed global installation in the initial inventory, not a Super Dash plugin version problem.

Under the user's continuing authorization to unify npm/pnpm and remove old versions, removed the old pnpm with `/usr/bin/npm uninstall --global --prefix /home/u1/.npm-global pnpm npm --ignore-scripts`. Only one package (the old pnpm) was present and removed. Other applications and shell PATH settings were retained. No plugin was installed on the user's behalf.

Fresh `bash -lic` verification after `hash -r`: `type -a pnpm npm` names only `/usr/bin` and its `/bin` alias; npm **12.2.0**, pnpm **12.10.1**, `pnpm store path` = `/home/u1/.local/share/pnpm/store/v11`. The PC `.npm-global` prefix was checked as well and contained neither npm nor pnpm. No production home file was read or modified, and no production service restart occurred. The user retains ownership of plugin installation and UI testing. The user's command also spelled the package `superd-dsh`; the published name is `super-dsh`.
