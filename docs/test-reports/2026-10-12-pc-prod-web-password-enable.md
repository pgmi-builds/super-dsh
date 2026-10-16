# PC production: better-dsh `web-password` gate turned ON

Date: 2026-10-12 (Asia/Hong_Kong). Request: "Turn the pc prod dsh better-dsh 'web-password' on." Verdict: **the gate is on and functional on PC production**, applied to the live process without a restart; one documented tradeoff is called out below.

## What was changed

`/home/u1/.dsh/profiles/web/cordis.patch.yml` — the row override that disabled the gate:

```yaml
- id: dashr-web-password
  disabled: true      # 2026-10-04: gate claims exact `/` and turns the native ?token= door off
```

was replaced (2026-10-12 10:12:54 HKT) with:

```yaml
- id: dashr-web-password
  disabled: false
```

plus a comment recording the re-enable and the retained tradeoff. No other row, profile file, package or service definition was touched.

## How it took effect (no restart)

- The production process is **unchanged**: `dsh.service`, MainPID `1196187`, `ExecMainStartTimestamp=2026-10-12 09:40:31 HKT` — the same process from the `0.3.1` cutover.
- Immediately after the patch rewrite the same process began serving the gate (before: `/` 401 with `{"passwordForm":false}`; after: `/` 200 with the password form and `{"passwordForm":true}`).
- The process holds **163 inotify watches**, including `~/.dsh`, the profile directory `~/.dsh/profiles/web`, `cordis.yml`, `package.json` and `pnpm-lock.yaml`. So DSH re-reads profile configuration live; the patch did not require a service restart.
- A `systemctl --user restart dsh.service` was attempted as part of the change and was blocked by the file sandbox (user-bus isolation); it turned out to be unnecessary and **no production restart occurred in this step**.

## Verification (all against the running production instance)

| Probe | Result |
| --- | --- |
| `GET http://127.0.0.1:3080/` | **200** with `name="password"` (x3 stable) |
| `GET https://dsh.pc.internal.test/` | **200** with the password form |
| `check-pair-login.mjs` (launcher probe) | `{"passwordForm":true,"anonymousApiStatus":401}` |
| Anonymous `POST /api/session/list` | **401** (fence intact) |
| `POST /` wrong password | **401**, no `Set-Cookie` |
| `POST /` password `admin` | **303 See Other**, `Location: /`, **1 `Set-Cookie`** (native session cookie minted) |
| `GET /?token=deadbeef` | 200 — the form, i.e. the token exchange is no longer the door at exact `/` |

Password: the row's credential record `dashr-web-password/passphrase` (created 2026-10-07) is seeded to **`admin`**; the successful login above proves it. Rotate by replacing that credential record; the login page has no self-service change flow.

## Tradeoff to be aware of (kept from 2026-10-04)

The gate claims exact `/`, so the native `?token=…` exchange stops being a door there (`/index.html` and `/api` keep native verification). The 2026-10-04 disable was made exactly because **SuperD mesh-link pairing from another machine mints its cookie through that token exchange** and failed with `no dsh-auth-* Set-Cookie in response (status 200)`. Enabling the gate therefore restores password-form admission but may re-break token-based pairing clients. Revert is a one-line change: `disabled: false` → `disabled: true` in the same row (and it will apply live by the same mechanism).

Parity note: dev3 production already had the gate on (its patch carries no `dashr-web-password` row, so the `better-dsh` bundle default applies); PC production now matches dev3.

## Boundaries

No npm publish, no commit/tag/push, no Caddy/DNS change, no production restart, no change to any other plugin row. Artifacts: patch file above; probe/test log `.scratch/web-password-on-pc-prod.log`.
