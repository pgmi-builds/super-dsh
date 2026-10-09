# Native companion installation and stable web listener

Approved by the user on 2026-10-09 after the dependency, onboarding and listener investigation.

## Delivery and ownership

Super Dash and Better Dash remain two synchronized-version npm packages and two independent native DSH bundles. Super declares no dependency, optional dependency, peer dependency, physical payload or bundle row for Better. Super obtains its own installed package version at runtime, requests `better-dsh@<that exact version>` through the current host's `pluginManager.installBundle`, then tries `better-dsh@latest`, then bare `better-dsh` if each preceding request fails (user clarification on 2026-10-09). Do not implement a second package manager, registry resolver, install hook or store.

The same operation serves first-run installation and the Hub Settings button. Honor native `ChangeResult.application` / errors, not merely promise resolution. Concurrent triggers share one operation. Do not start a nested HMR transaction or wait for a child installation inside the parent installation transaction. An unavailable manager or failed installation leaves Super usable and exposes an actionable retry error.

## Companion choices and UI

Keep profile-specific companion state under `$DSH_HOME/superd/companions/`; migrate existing `companion-registration` receipts without resurrecting an intentionally removed Better. Automatic installation runs once for first use, not every restart or Super upgrade. An already installed Better is never automatically upgraded, enabled or replaced. Native disable and uninstall remain authoritative. The user can explicitly reinstall after removal via Settings.

Hub Settings' first row is Better Dash, showing installed / not installed, installed version and enabled state when available, operation progress/error, and an Install button when missing. Refresh state after native Plugin Manager changes and explicit installation. The Settings entry manages the local ctx0 profile even while a foreign runtime is selected. No remote package installation.

## Web and onboarding

Remove Better's replacement `WebServer`, wide-bind default and server-side welcome acknowledgement. Use official `settings.onboarding` list-slot priority to shadow `welcome-notice` and its owner `complete()` to skip it every time it is selected, including first visit, new chat and an explicitly reopened notice. Keep unrelated onboarding steps. Remove the contribution when the corresponding Better component is disabled/uninstalled; never synthesize clicks, write upstream private state, or mutate the upstream source.

Preserve native WebServer and existing public event contributions for WebTrust/mobile. Hub routes, reprobe sweep and asynchronous PTY registration must share the native Connection injection lifetime; a Connection reload must neither retain old routes nor replace the listener. Production Caddy targets loopback and is untouched. Test launcher explicitly binds `127.0.0.1` and uses its existing LAN relay where applicable.

## Verification and scope

Begin with test version `0.3.0-f` for both local tarballs, advancing the synchronized letter for subsequent artifact iterations (final acceptance: `0.3.0-i`); this is not publication authorization. Keep the existing test home and shared credential seed. Verify exact request, ordered latest/bare-name fallbacks, failure/retry, receipt migration, removal across restarts/upgrades, explicit reinstall and independent native enable/disable/uninstall. Exercise the actual 4999 tarball consumer, browser first visit/new chat/Settings/native Plugin Manager, and a DEV3 pairing. The user explicitly narrows DEV3 testing to pairing; no production package update or service restart. Keep 4999 running and provide its URL and a report under `docs/test-reports/`.

No npm publish, git commit/tag/push, production restart, Caddy edit, pairing-data deletion or upstream source edit in this task.
