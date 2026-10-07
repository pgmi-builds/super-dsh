import * as React from 'react'
import {
  IconCopyOutlineRegular,
  IconPlayOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { HubGlyph } from './glyph.js'
import { RuntimeMark } from './runtime-icons.js'
import { StatusMark } from './status-mark.js'
import { currentMountPath, fetchRoster, NATIVE_LINK, rosterFromGlobal, type AgentLink } from './roster.js'
import {
  addMachine,
  fetchMachines,
  fetchPairingUrl,
  removeMachine,
  reprobeMachine,
  machineVersionChip,
  validTokenUrl,
  type MeshList,
  type MeshMachineStatus,
  type MeshMachineView,
} from './mesh-api.js'
import { AUTO_REFRESH_NOTE } from './mesh-api.js'
import { showSuperdToast } from './toast.js'
import { groupByMachine, machineLabelsFrom } from './mesh-groups.js'
import { attemptSwitch, fusionPage, uiState } from './switch.js'
import { hubRowActive, seatClickDecision, switchAffordance } from '../switch-core.js'
import {
  activeMethod,
  authKindOptions,
  nativeDescription,
  nativePathsLine,
  selectable,
  settingsPanelFor,
  toggleExpanded,
  type RuntimeAuthView,
  type RuntimeProvidersView,
} from './agent-settings.js'
import {
  fetchAuthView,
  fetchProvidersView,
  removeProvider,
  saveProvider,
  setAuthMode,
  settingsErrorText,
} from './runtime-settings-api.js'

/**
 * The Hub main panel (`main`, key `hub`): the hub-functionality home page.
 * The hub is this tool as a whole; machines are the sources of agent
 * runtimes. Home lists the machines with the add-machine form, then the
 * agent-adapter roster the hub currently bridges. Machines ride the real
 * mesh API (mesh-api.ts — `/api/superd/machines`: the self block + paired
 * remotes, same-origin fetch, one reload after every mutating op); the
 * adapter list is the live `/api/agent-runtime` roster, grouped by machine
 * (mesh-groups.ts, mesh P2 Task 4): 'This machine' first, then one section
 * per remote machine by display label — the machines answer doubles as the
 * label map, and without it (load failed) the rows stay flat.
 *
 * Switch surface (T-B, switch-only since T-C): the Agent Runtimes rows are
 * the agent selector. Every row click runs the `seatClickDecision` table —
 * intercepted, in-place `switchAgent`, NO navigation ever; the active row
 * tracks the `__SUPERD_UI_STATE__` atom. There is no non-fusion navigation
 * arm: the per-label URL family is retired (path-separation T-C — `/hub` is
 * the sole entry), so a row never links anywhere. Flag off (T-E): the switch
 * affordance does not render at all — rows stay informational and the
 * degradation hint renders once under the section head, never a dead
 * control (`switchAffordance`).
 *
 * @module superd-hub/client/HubPage
 */

/** The add-machine form's editable fields — the name IS the machine's display identity. */
interface AddDraft {
  readonly name: string
  readonly tokenUrl: string
}

const EMPTY_DRAFT: AddDraft = { name: '', tokenUrl: '' }

/** Chip text: drop the trailing slash for concision ('/claude/' → '/claude'). */
function displayPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** Shared chip look (status pills, path tags). */
const chip: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1.4,
  padding: '2px 7px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
  background: 'color-mix(in srgb, currentColor 10%, transparent)',
}

const chipSelf: React.CSSProperties = {
  ...chip,
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
  color: 'var(--dsw-alias-state-success-primary)',
}

const chipWarn: React.CSSProperties = {
  ...chip,
  color: 'var(--dsw-alias-state-warn-primary)',
}

/** Machine id chip (the m4): the monospace chip look the roster's path tags use. */
const chipMonoId: React.CSSProperties = {
  ...chip,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
}

/** The status dot's fixed part (the color is decided per row). */
const dotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flex: 'none',
}

/** The machine origin column: monospace, eats the leftover row width. */
const originStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * The row's switch control (P3: the `switch` word is a real BUTTON now — the
 * row body toggles the settings panel instead, so the switch needs its own
 * hit target that stops propagation).
 */
const switchButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  font: 'inherit',
  fontSize: 12.5,
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap',
}

/** The inline settings panel a row body expands into (P3 accordion). */
const panelStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: '0 -8px 4px',
  padding: '10px 12px 12px 42px',
  borderRadius: 12,
  background: 'var(--dsw-alias-interactive-bg-hover)',
  fontSize: 12.5,
}

/** The icon action (remove / refresh / copy) seat. */
const iconActionStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-caption)',
  font: 'inherit',
  cursor: 'pointer',
}
/** The row's settings panel heading. */
const panelHeadStyle: React.CSSProperties = {
  margin: '0 0 6px',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
}

/** One auth-method option's row in the panel. */
const optionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'transparent',
  padding: '5px 6px',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  color: 'var(--dsw-alias-label-primary)',
}
/** One line of error text for the panel's inline error line. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l3)',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 11,
  color: 'var(--dsw-alias-label-caption)',
}

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

/** The machine section head inside the roster list (the grouped shape's caption row). */
const sectionHeadStyle: React.CSSProperties = {
  padding: '8px 8px 2px',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-caption)',
  whiteSpace: 'nowrap',
  listStyle: 'none',
}

/**
 * A row that lights its surface on hover (inline styles have no :hover).
 *
 * P3: the row BODY is the settings-panel toggle, not the switch — `expanded`
 * keeps the surface lit while its panel is open, so the open row stays
 * identifiable after the pointer leaves. The switch lives in the row's button.
 */
function HoverRow({ children, onClick, clickable, expanded }: {
  children: React.ReactNode
  /** Row-body click handler (P3: the settings accordion toggle). */
  onClick?: (event: React.MouseEvent) => void
  /** Pointer cursor while the row body is interactive. */
  clickable?: boolean
  /** The row's settings panel is open. */
  expanded?: boolean
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false)
  return (
    <li
      onClick={onClick}
      aria-expanded={expanded}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '0 -8px',
        padding: '9px 8px',
        borderRadius: 12,
        listStyle: 'none',
        background: hover || expanded ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        cursor: clickable ? 'pointer' : undefined,
      }}
    >
      {children}
    </li>
  )
}

/** Section head: title, count, and a trailing action slot. */
function GroupHead({ title, count, action }: { title: string; count: number; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500 }}>{title}</h2>
      <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      <span style={{ flex: 1 }} />
      {action}
    </div>
  )
}

/**
 * One runtime's settings, rendered inside its expanded row (P3/P4).
 *
 * The adapter owns the config, so this component owns no config knowledge: each
 * body asks the adapter's Remote and renders what comes back. The round trip
 * after a change is authoritative — the adapter re-reads the machine and
 * answers with the new state, which is why nothing is optimistically patched
 * here (a selection can fall through a ladder, or a switch can leave a provider
 * the runtime is still running).
 *
 * Mounted only while its row is open, so expanding always re-reads the
 * machine rather than replaying a stale first read.
 */
function RuntimeSettingsPanel({ agent }: { agent: AgentLink }): React.JSX.Element {
  const panel = settingsPanelFor(agent.key)
  if (panel === undefined) {
    return (
      <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>
        No settings for this runtime yet.
      </p>
    )
  }
  return panel.kind === 'providers'
    ? <ProvidersPanel agent={agent} namespace={panel.namespace} />
    : <AuthSettingsPanel agent={agent} namespace={panel.namespace} />
}

/**
 * The sign-in-form body (Antigravity): one form picked from the adapter's
 * ladder. `namespace` always resolves — the row would not mount this body
 * otherwise.
 */
function AuthSettingsPanel({ agent, namespace }: { agent: AgentLink; namespace: string }): React.JSX.Element {
  const [view, setView] = React.useState<RuntimeAuthView | undefined>(undefined)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  React.useEffect(() => {
    let live = true
    setLoading(true)
    fetchAuthView(agent.key, namespace)
      .then((next) => { if (live) { setView(next); setError(null) } })
      .catch((err: unknown) => { if (live) { setView(undefined); setError(settingsErrorText(err)) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [agent.key, namespace])

  const choose = (mode: string): void => {
    if (busy !== null) return
    setBusy(mode)
    setAuthMode(agent.key, namespace, mode)
      .then((next) => { setView(next); setError(null) })
      .catch((err: unknown) => { setError(settingsErrorText(err)) })
      .finally(() => { setBusy(null) })
  }

  if (loading) {
    return <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>Loading settings…</p>
  }

  if (view === undefined) {
    return (
      <p style={{ margin: 0, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' }}>
        {error ?? 'Settings are unavailable for this runtime.'}
      </p>
    )
  }

  const current = activeMethod(view)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <p style={panelHeadStyle}>Sign-in method</p>
      {view.methods.map((option) => {
        const isCurrent = current?.key === option.key
        const disabled = !selectable(option) || busy !== null
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={isCurrent}
            disabled={disabled}
            onClick={() => { choose(option.key) }}
            style={{
              ...optionStyle,
              color: disabled ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
              cursor: disabled ? 'default' : 'pointer',
              background: isCurrent ? 'var(--dsw-alias-bg-elevated, transparent)' : 'transparent',
            }}
          >
            <span aria-hidden style={{ width: 12, flex: '0 0 12px' }}>
              {isCurrent ? '\u25CF' : '\u25CB'}
            </span>
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{option.label}</span>
            {isCurrent && <span style={chipSelf}>in force</span>}
            {!option.available && <span style={chip}>not detected</span>}
            {option.placeholder && <span style={chip}>placeholder</span>}
            <span style={{ flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-tertiary)' }}>{option.hint}</span>
            {busy === option.key && <span style={chip}>applying…</span>}
          </button>
        )
      })}
      {view.note !== undefined && (
        <p style={{ margin: '2px 0 0', color: 'var(--dsw-alias-label-tertiary)' }}>{view.note}</p>
      )}
      {error !== null && (
        <p style={{ margin: '2px 0 0', color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>
      )}
      {view.settingsPath !== undefined && (
        <p style={{ margin: '4px 0 0', color: 'var(--dsw-alias-label-caption)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>
          writes {view.settingsPath}
        </p>
      )}
    </div>
  )
}

/** Field and control styling for the providers body — same visual language as the auth list. */
const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  fontSize: 12.5,
  color: 'var(--dsw-alias-label-secondary)',
}

const buttonStyle: React.CSSProperties = {
  font: 'inherit',
  fontSize: 12.5,
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.3))',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  border: 'none',
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-base, #fff)',
  fontWeight: 500,
}

/** The blank draft the Add form starts from. */
const EMPTY_PROVIDER_DRAFT = {
  id: '',
  label: '',
  baseUrl: '',
  protocol: 'responses',
  // The view's own vocabulary decides what this may be (authKindOptions).
  authKind: 'apiKey',
  apiKey: '',
  envName: '',
  modelIds: '',
  contextWindow: '',
}

type ProviderDraft = typeof EMPTY_PROVIDER_DRAFT

/** `a, b c` → `['a','b','c']` — the model field takes whatever separator is natural. */
function parseModelIds(text: string): string[] {
  return text.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * The multi-provider body (Codex 2026-10-03 ruling; Claude 2026-10-04 rides
 * the same body with its own view shape — no `protocols` field, two header
 * auth kinds, an endpoint-URL native).
 *
 * Super D hosts the list cc-switch otherwise holds: add, edit and remove only.
 * The active/select half is gone — which provider a Codex session runs on is
 * DSH's own per-session model selection, so no row is marked "in force". What
 * the user's OWN config.toml names is rendered as a passive fact (the adapter
 * reconciles the list against that file), and the files it touches are named so
 * an edit is never a surprise.
 *
 * Keys are write-only by construction: the adapter answers `hasKey`, never a
 * value, so the field is blank on every open and blank means "leave whatever is
 * already there".
 */
function ProvidersPanel({ agent, namespace }: { agent: AgentLink; namespace: string }): React.JSX.Element {
  const [view, setView] = React.useState<RuntimeProvidersView | undefined>(undefined)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  /** The id being edited, `NEW_PROVIDER` for the add form, `null` when closed. */
  const [editing, setEditing] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT)

  React.useEffect(() => {
    let live = true
    setLoading(true)
    fetchProvidersView(agent.key, namespace)
      .then((next) => { if (live) { setView(next); setError(null) } })
      .catch((err: unknown) => { if (live) { setView(undefined); setError(settingsErrorText(err)) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [agent.key, namespace])

  /** One mutation, one authoritative re-read; `key` drives the busy chip. */
  const run = (key: string, call: () => Promise<RuntimeProvidersView>): void => {
    if (busy !== null) return
    setBusy(key)
    call()
      .then((next) => { setView(next); setError(null); setEditing(null); setDraft(EMPTY_PROVIDER_DRAFT) })
      .catch((err: unknown) => { setError(settingsErrorText(err)) })
      .finally(() => { setBusy(null) })
  }

  const openNew = (): void => { setEditing(NEW_PROVIDER); setDraft(EMPTY_PROVIDER_DRAFT); setError(null) }
  const openEdit = (provider: RuntimeProvidersView['providers'][number]): void => {
    setEditing(provider.id)
    setDraft({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      authKind: provider.authKind,
      // Never an existing value — see the module note; blank keeps it.
      apiKey: '',
      envName: provider.envName ?? '',
      modelIds: provider.models.map((model) => model.id).join(', '),
      contextWindow: provider.models[0]?.contextWindow === undefined ? '' : String(provider.models[0].contextWindow),
    })
    setError(null)
  }

  const submit = (): void => {
    const ids = parseModelIds(draft.modelIds)
    const window = draft.contextWindow.trim() === '' ? undefined : Number(draft.contextWindow)
    const provider = {
      id: draft.id.trim(),
      label: draft.label.trim(),
      baseUrl: draft.baseUrl.trim(),
      protocol: draft.protocol,
      auth: draft.authKind === 'env'
        ? { kind: 'env', name: draft.envName.trim() }
        : { kind: draft.authKind === 'authToken' ? 'authToken' : 'apiKey', value: draft.apiKey },
      models: ids.map((id) => ({
        id,
        ...(window !== undefined && Number.isSafeInteger(window) && window > 0 ? { contextWindow: window } : {}),
      })),
    }
    run('save', () => saveProvider(agent.key, namespace, provider))
  }

  if (loading) {
    return <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>Loading providers…</p>
  }

  if (view === undefined) {
    return (
      <p style={{ margin: 0, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' }}>
        {error ?? 'Providers are unavailable for this runtime.'}
      </p>
    )
  }

  // The claude face names one native file (settings.json), codex three; a face
  // that named none renders no second footer line at all.
  const nativePaths = nativePathsLine(view.paths)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={panelHeadStyle}>Model provider</p>

      {/* The user's own file, shown as a fact and never as a control: the
          adapter reconciles the list from it, but DSH's per-session model
          selection is what a session actually runs. */}
      {view.native !== null && (
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>
          Your own {agent.label} config currently runs {nativeDescription(view.native)}.
        </p>
      )}
      {view.syncedAt !== undefined && (
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-caption)', fontSize: 11 }}>
          synced from your native config {new Date(view.syncedAt).toLocaleString()}
        </p>
      )}

      {view.providers.length === 0 && (
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>
          No providers yet — add one to pin a model and endpoint.
        </p>
      )}

      {view.providers.map((provider) => (
        <div key={provider.id} style={optionStyle}>
          <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{provider.label}</span>
          {provider.authKind === 'env' && <span style={chip}>env {provider.envName}</span>}
          {provider.authKind === 'authToken' && <span style={chip}>token</span>}
          {provider.authKind === 'oauth' && <span style={chip}>native OAuth</span>}
          {!provider.hasKey && <span style={chip}>no key</span>}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            {provider.baseUrl}
            {provider.models.length === 0 ? '' : ` · ${provider.models.map((model) => model.id).join(', ')}`}
          </span>
          {/* A provider folded in from config.toml may carry no discoverable
              model list; say so instead of a bare " · " and an empty tail. */}
          {provider.models.length === 0 && <span style={chipWarn}>{provider.authKind === 'oauth' ? 'model cache unavailable — open Codex to refresh' : 'no models yet — add one'}</span>}
          {busy === `remove:${provider.id}` && <span style={chip}>removing…</span>}
          {provider.authKind !== 'oauth' && <>
          <button type="button" style={buttonStyle} disabled={busy !== null}
            onClick={() => { openEdit(provider) }}>Edit</button>
          <button
            type="button"
            style={{ ...buttonStyle, color: 'var(--dsw-alias-state-error-primary, #c66)' }}
            disabled={busy !== null}
            aria-label={`Delete ${provider.label}`}
            onClick={() => { run(`remove:${provider.id}`, () => removeProvider(agent.key, namespace, provider.id)) }}
          >
            Delete
          </button>
          </>}
        </div>
      ))}

      {editing === null && (
        <div>
          <button type="button" style={buttonStyle} disabled={busy !== null} onClick={openNew}>
            + Add provider
          </button>
        </div>
      )}

      {editing !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
          <p style={panelHeadStyle}>{editing === NEW_PROVIDER ? 'Add provider' : `Edit ${editing}`}</p>

          <label style={fieldStyle}>
            Provider id
            <input
              style={inputStyle}
              value={draft.id}
              disabled={editing !== NEW_PROVIDER}
              placeholder="zai-plan"
              onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }}
            />
          </label>

          <label style={fieldStyle}>
            Display name
            <input
              style={inputStyle}
              value={draft.label}
              placeholder="Z.ai Plan"
              onChange={(event) => { setDraft({ ...draft, label: event.target.value }) }}
            />
          </label>

          <label style={fieldStyle}>
            Base URL
            <input
              style={inputStyle}
              value={draft.baseUrl}
              placeholder="https://api.z.ai/api/coding/paas/v4"
              onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }) }}
            />
          </label>

          {/* A face with no wire-protocol choice (claude) omits the control
              entirely: the field is absent from its view, and inventing options
              the runtime cannot run would be worse than no dropdown. */}
          {view.protocols.length > 0 && (
            <>
              <label style={fieldStyle}>
                API protocol
                <select
                  style={inputStyle}
                  value={draft.protocol}
                  onChange={(event) => { setDraft({ ...draft, protocol: event.target.value }) }}
                >
                  {view.protocols.map((option) => (
                    <option key={option.value} value={option.value} disabled={!option.available} title={option.hint}>
                      {option.label}{option.available ? '' : ' — unsupported'}
                    </option>
                  ))}
                </select>
              </label>
              {(() => {
                const option = view.protocols.find((candidate) => candidate.value === draft.protocol)
                return option === undefined || option.available ? null : (
                  <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary, #c66)', fontSize: 12 }}>
                    {option.hint}
                  </p>
                )
              })()}
            </>
          )}

          <label style={fieldStyle}>
            Model IDs
            <input
              style={inputStyle}
              value={draft.modelIds}
              placeholder="glm-5.2, glm-5.2-air"
              onChange={(event) => { setDraft({ ...draft, modelIds: event.target.value }) }}
            />
          </label>

          <label style={fieldStyle}>
            Context window (tokens, optional)
            <input
              style={inputStyle}
              value={draft.contextWindow}
              inputMode="numeric"
              placeholder="1000000"
              onChange={(event) => { setDraft({ ...draft, contextWindow: event.target.value }) }}
            />
          </label>

          {/* The key shapes on offer are the VIEW's (authKindOptions): codex
              offers a stored key or an env-var name, claude its two header
              shapes. One dropdown, never two parallel inputs — each adapter
              rejects the other face's kind on save. */}
          <label style={fieldStyle}>
            Key shape
            <select
              style={inputStyle}
              value={draft.authKind}
              onChange={(event) => { setDraft({ ...draft, authKind: event.target.value }) }}
            >
              {authKindOptions(view).map((option) => (
                <option key={option.value} value={option.value} title={option.hint}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {draft.authKind === 'env' ? (
            <label style={fieldStyle}>
              Environment variable
              <input
                style={inputStyle}
                value={draft.envName}
                placeholder="DEEPSEEK_API_KEY"
                onChange={(event) => { setDraft({ ...draft, envName: event.target.value }) }}
              />
            </label>
          ) : (
            <label style={fieldStyle}>
              {draft.authKind === 'authToken' ? 'Bearer token' : 'API key'} {editing !== NEW_PROVIDER && <span style={{ color: 'var(--dsw-alias-label-caption)' }}>(leave blank to keep the saved one)</span>}
              <input
                style={inputStyle}
                type="password"
                value={draft.apiKey}
                autoComplete="off"
                onChange={(event) => { setDraft({ ...draft, apiKey: event.target.value }) }}
              />
            </label>
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={primaryButtonStyle} disabled={busy !== null} onClick={submit}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              style={buttonStyle}
              disabled={busy !== null}
              onClick={() => { setEditing(null); setDraft(EMPTY_PROVIDER_DRAFT) }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {view.note !== undefined && (
        <p style={{ margin: '2px 0 0', color: 'var(--dsw-alias-label-tertiary)' }}>{view.note}</p>
      )}
      {error !== null && (
        <p style={{ margin: '2px 0 0', color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>
      )}

      <p style={{ margin: '4px 0 0', color: 'var(--dsw-alias-label-caption)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>
        list {view.paths.store}
      </p>
      {nativePaths !== undefined && (
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-caption)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>
          native {nativePaths}
        </p>
      )}
    </div>
  )
}

/** Sentinel for "the add form", distinct from any real provider id. */
const NEW_PROVIDER = '\u0000new'

export function HubPage(): React.JSX.Element {
  const [mesh, setMesh] = React.useState<MeshList>({ machines: [] })
  const [meshLoaded, setMeshLoaded] = React.useState(false)
  const [meshError, setMeshError] = React.useState<string | null>(null)
  const [meshBusy, setMeshBusy] = React.useState(false)
  const [meshReloads, setMeshReloads] = React.useState(0)
  const [showAdd, setShowAdd] = React.useState(false)
  const [draft, setDraft] = React.useState<AddDraft>(EMPTY_DRAFT)
  /** The self row's pairing-URL mint/clipboard round trip is in flight. */
  const [pairingBusy, setPairingBusy] = React.useState(false)
  const [agents, setAgents] = React.useState<AgentLink[] | null>(() => rosterFromGlobal() ?? null)
  const [rosterFailed, setRosterFailed] = React.useState(false)
  const [tab, setTab] = React.useState<'home' | 'workflows' | 'settings'>('home')
  // Baked before app boot and never mutated afterwards: per-page constant.
  const fusion = fusionPage()
  // The flag-off shape (T-E): with no /<label>/ routes and no world UIs left
  // in the product, a flag-off page has NO foreign entry — the switch
  // affordance does not render and the rows stay informational with the
  // degradation hint (never a dead control; no hrefs ship either way).
  const switchUi = switchAffordance(fusion)
  // The fusion selection: the page atom is the authority (the URL is
  // irrelevant on a fused page). The atom seeds the first paint and the
  // subscription follows every switch — including one issued from another
  // surface or the revert of a failed attempt.
  const [activeKey, setActiveKey] = React.useState<string | undefined>(
    () => (fusion ? uiState()?.activeAgent : undefined),
  )
  /**
   * The open settings panel (P3 accordion): one runtime key at a time, or
   * `null` when every row is collapsed. `toggleExpanded` owns the transition.
   */
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void fetchRoster()
      .then((list) => { if (!cancelled) { setAgents(list); setRosterFailed(false) } })
      .catch(() => {
        if (!cancelled) {
          setAgents((prev) => prev ?? [NATIVE_LINK])
          setRosterFailed(true)
        }
      })
    return () => { cancelled = true }
  }, [])

  // The machines panel's data plane: initial load on mount, then one reload
  // after every mutating op (add/remove/reprobe bump `meshReloads` — the
  // server's registry + status table are the single source of truth; a
  // failed load degrades to the inline error line, never a crash).
  React.useEffect(() => {
    let cancelled = false
    fetchMachines()
      .then((list) => { if (!cancelled) { setMesh(list); setMeshError(null); setMeshLoaded(true) } })
      .catch((err: unknown) => { if (!cancelled) { setMeshError(errText(err)); setMeshLoaded(true) } })
    return () => { cancelled = true }
  }, [meshReloads])

  React.useEffect(() => {
    if (!fusion) return
    const state = uiState()
    if (state === undefined) return
    return state.subscribe((label) => { setActiveKey(label) })
  }, [fusion])

  const here = currentMountPath()
  // The self row's origin: where this page is served from (the API's self
  // block carries the identity, not the origin).
  const hereOrigin = typeof location === 'undefined' ? '' : location.origin
  const isActive = (agent: AgentLink): boolean => hubRowActive({
    fusion,
    agentKey: agent.key,
    agentPath: agent.path,
    activeAgent: activeKey,
    mountPath: here,
  })

  /**
   * The row's click decision — the SAME table the retired sidebar seat ran:
   * on a fusion page EVERY left click is intercepted (active entry included),
   * the attempt runs for non-active entries only, and `preventDefault` keeps
   * the page exactly where it is. Non-fusion pages have no navigation arm to
   * fall back to (T-C retired the URL family), so the pass-through decision
   * is simply inert.
   */
  const rowDecision = (agent: AgentLink, event: React.MouseEvent): void => {
    const decision = seatClickDecision({
      fusion,
      active: isActive(agent),
      attempt: () => attemptSwitch(agent.key),
    })
    if (decision.preventDefault) event.preventDefault()
  }

  // The roster's machine sections (mesh P2 Task 4): the machines panel's
  // own answer doubles as the label map — 'This machine' first, then one
  // section per remote machine by display label. A failed (or still
  // loading) machines face leaves the rows flat — today's shape — rather
  // than guessing section heads from raw m4 ids.
  const machineLabels = meshLoaded && meshError === null ? machineLabelsFrom(mesh) : undefined
  const groups = agents !== null && machineLabels !== undefined ? groupByMachine(agents, machineLabels) : undefined

  /**
   * One Agent Runtimes row — the SAME row in both shapes; `showMachine`
   * keeps the flat fallback's per-row machine text (the grouped shape moves
   * it onto the section head).
   *
   * P3 interaction (2026-10-02 user ruling): the ROW BODY expands this
   * runtime's OWN settings inline (accordion — one panel at a time), and the
   * right-hand `switch` is the row's ONLY switch, now a real button. The two
   * are separate controls on purpose: expanding is navigation of config, the
   * button performs `seatClickDecision` (intercept + in-place switchAgent).
   */
  const renderRow = (agent: AgentLink, showMachine: boolean): React.JSX.Element => {
    const expanded = expandedKey === agent.key
    return (
      <React.Fragment key={agent.key}>
        <HoverRow
          clickable
          expanded={expanded}
          onClick={() => { setExpandedKey((current) => toggleExpanded(current, agent.key)) }}
        >
          {/* The runtime's own mark (runtime-icons.tsx), resolved through
              the unified runtimeId so LOCAL and FEDERATED rows draw the same
              artwork — NOT the disclosure chevron: the arrow was removed
              because the whole row is the expand target, but this glyph is
              the runtime's identity and was never part of that affordance. */}
          <RuntimeMark runtimeId={agent.runtimeId} agentKey={agent.key} size={20} />
          <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{agent.label}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12.5,
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            {showMachine ? agent.machine : null}
          </span>
          {isActive(agent) && <span style={chipSelf}>current</span>}
          {/* The row's ONLY switch (T-C switch-only; T-E flag-off shape).
              A real button: it runs the same `seatClickDecision` table as
              before and stops propagation so the row-body expand does not also
              fire — one click, one effect.

              Deliberately NOT `disabled`: a runtime that is already current was
              rendered with a disabled button, which reads as inert plain text
              and (reported 2026-10-02) looked like the control had broken after
              a row was expanded. The current row keeps a live button whose
              decision table is simply a no-op — `seatClickDecision` already
              knows an active entry is not worth attempting. */}
          {switchUi.available && (
            <button
              type="button"
              aria-current={isActive(agent) ? 'page' : undefined}
              aria-label={isActive(agent) ? `${agent.label} is current` : `Switch to ${agent.label}`}
              style={{
                ...switchButtonStyle,
                color: isActive(agent)
                  ? 'var(--dsw-alias-label-tertiary)'
                  : 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
              }}
              onClick={(event) => {
                event.stopPropagation()
                rowDecision(agent, event)
              }}
            >
              {/* Official DSH primitive, not a bespoke glyph (2026-10-02 user
                  ruling): the launch/play mark the rest of the UI already uses,
                  so this control speaks the same visual language. */}
              <IconPlayOutlineRegular size={16} />
            </button>
          )}
        </HoverRow>
        {expanded && (
          <li style={panelStyle}>
            <RuntimeSettingsPanel agent={agent} />
          </li>
        )}
      </React.Fragment>
    )
  }

  /** Bump the reload sequence — every mutating op refreshes through the API. */
  const reloadMachines = (): void => { setMeshReloads((n) => n + 1) }

  const addRemote = (): void => {
    const name = draft.name.trim()
    const tokenUrl = draft.tokenUrl.trim()
    if (name === '' || !validTokenUrl(tokenUrl)) return
    setMeshBusy(true)
    void addMachine({ name, tokenUrl })
      .then((out) => {
        setDraft(EMPTY_DRAFT)
        setShowAdd(false)
        setMeshError(null)
        reloadMachines()
        // Mutual pairing (2026-10-08 user ruling): the peer is offered our own
        // pairing input as part of this pair. Say both halves out loud — a
        // failed reverse leg is actionable (the row IS in, the peer's half is
        // not) without being an error state.
        if (out.mutual !== undefined && !out.mutual.ok) {
          showSuperdToast(`Super D: paired with ${name}, but the mutual half failed (${out.mutual.error}) — add this machine from the peer manually.`)
        } else {
          showSuperdToast(`Super D: paired with ${name} — the peer also added this machine (mutual).`, { tone: 'success' })
        }
      })
      .catch((err: unknown) => { setMeshError(errText(err)) })
      .finally(() => { setMeshBusy(false) })
  }

  const removeRemote = (id: string): void => {
    void removeMachine(id)
      .then(() => { setMeshError(null); reloadMachines() })
      .catch((err: unknown) => { setMeshError(errText(err)) })
  }

  const reprobeRemote = (id: string): void => {
    void reprobeMachine(id)
      .then(() => { setMeshError(null); reloadMachines() })
      .catch((err: unknown) => { setMeshError(errText(err)) })
  }

  /** The self row's copy affordance: one explicit mint (the token rides no
   *  GET), one clipboard write, the outcome on the shared toast. */
  const copyPairingUrl = (): void => {
    if (pairingBusy) return
    const origin = typeof location === 'undefined' ? '' : location.origin
    if (origin === '') return
    setPairingBusy(true)
    void fetchPairingUrl(origin)
      .then((url) => writeClipboard(url))
      .then((copied) => {
        showSuperdToast(copied
          ? 'Pairing URL copied — paste it into Add machine on the other machine'
          : 'Copy failed — the browser refused clipboard access', copied ? { tone: 'success' } : {})
      })
      .catch((err: unknown) => { setMeshError(errText(err)) })
      .finally(() => { setPairingBusy(false) })
  }

  const draftValid = draft.name.trim() !== '' && validTokenUrl(draft.tokenUrl.trim())

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '28px clamp(24px, 4vw, 48px) 48px',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Head */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <HubGlyph size={36} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' }}>Hub</h1>
            <p style={{ margin: '2px 0 0', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>
              Multi-agent across machines in one hub by SuperD
            </p>
          </div>
        </div>

        {/* Sub-tab strip: Home is the machine/roster overview; Workflows is
            the orchestration surface (placeholder until the hub service
            lands). */}
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l3)' }}>
          {([['home', 'Home'], ['workflows', 'Workflows'], ['settings', 'Settings']] as const).map(([id, label]) => {
            const active = tab === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => { setTab(id) }}
                style={{
                  padding: '8px 10px',
                  border: 'none',
                  background: 'transparent',
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 500 : 400,
                  color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  borderBottom: `2px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
                  marginBottom: -1,
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {tab === 'workflows' && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GroupHead title="Workflows" count={0} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
              Orchestration across the machines and runtimes above — workflow authoring lands with the hub service.
            </p>
          </section>
        )}

        {tab === 'settings' && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GroupHead title="Settings" count={0} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
              Hub preferences — pairing, runtime visibility, and orchestration defaults land with the hub service.
            </p>
          </section>
        )}

        {tab === 'home' && (<>

        {/* Machines */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <GroupHead
            title="Machines"
            count={(mesh.self !== undefined ? 1 : 0) + mesh.machines.length}
            action={(
              <button
                type="button"
                onClick={() => { setShowAdd((value) => !value) }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  font: 'inherit',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <path d="M5.5 1.5V9.5M1.5 5.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                Add machine
              </button>
            )}
          />
          <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' }}>
            Add another DSH from remote machines, provide the token URL. Pairing is mutual — the peer adds this machine back automatically. Status {AUTO_REFRESH_NOTE}.
          </p>
          {meshError !== null && (
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)' }}>
              {meshError}
            </p>
          )}
          <ul style={listStyle}>
            {!meshLoaded && (
              <li style={{ padding: '9px 8px', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', listStyle: 'none' }}>
                Loading machines…
              </li>
            )}
            {meshLoaded && meshError === null && mesh.machines.length === 0 && mesh.self === undefined && (
              <li style={{ padding: '9px 8px', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', listStyle: 'none' }}>
                No machines yet — add the first one with its token URL.
              </li>
            )}
            {/* The self row: rendered from the response's self block (never a
                wire row) — its origin is where this page is served from. The
                URL shows the token TRUNCATED (`/?token=d_3txYKhc_…`, the wire
                carries only the preview) so the user can see it IS a token,
                and the copy affordance rides directly after it — the pairing
                entry (spec hub-roster-identity §3): the hub tokenizes THIS
                page's origin with its live launch token, and the paste target
                is the other machine's Add-machine form (mutual pairing —
                either side's copy pairs both). */}
            {mesh.self !== undefined && (
              <HoverRow>
                <span aria-hidden style={{ ...dotStyle, background: 'var(--dsw-alias-state-success-primary)' }} />
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{mesh.self.label}</span>
                <span style={{ ...originStyle, flex: '0 0 auto' }}>
                  {hereOrigin}{mesh.self.tokenPreview !== undefined ? `/?token=${mesh.self.tokenPreview}` : ''}
                </span>
                <button
                  type="button"
                  aria-label="Copy this machine's pairing URL"
                  title={pairingBusy ? 'Minting pairing URL…' : 'Copy the token URL another machine can Add machine with'}
                  disabled={pairingBusy}
                  onClick={() => { copyPairingUrl() }}
                  style={iconActionStyle}
                >
                  <IconCopyOutlineRegular size={15} />
                </button>
                <span style={{ flex: 1 }} />
                <span style={chipMonoId}>{mesh.self.id}</span>
                <span style={chipSelf}>self</span>
              </HoverRow>
            )}
            {mesh.machines.map((machine) => (
              <HoverRow key={machine.id}>
                {/* Connection mark (2026-10-07 user ruling): the Wi-Fi-style
                    signal glyph replaces the text chip; the word survives on
                    the title/aria-label. The dot goes with it — the mark IS
                    the status. */}
                <span title={machine.status}>
                  <StatusMark status={machine.status} size={16} />
                </span>
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{machine.name}</span>
                <span style={originStyle}>{machine.origin}</span>
                <span style={chipMonoId}>{machine.id}</span>
                {/* I2 version-mismatch chip: present exactly when the hub's
                    probe found the peer's superd version incompatible —
                    full warning text as the chip (compact by construction),
                    machine id context on hover. */}
                {machineVersionChip(machine) !== undefined && (
                  <span style={chipWarn} title={`machine ${machine.id}`}>{machine.versionWarning}</span>
                )}
                <button
                  type="button"
                  aria-label={`Refresh ${machine.name}`}
                  title={`Refresh ${machine.name}`}
                  onClick={() => { reprobeRemote(machine.id) }}
                  style={iconActionStyle}
                >
                  <IconRefreshOutlineRegular size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${machine.name}`}
                  title={`Remove ${machine.name}`}
                  onClick={() => { removeRemote(machine.id) }}
                  style={iconActionStyle}
                >
                  <IconTrashOutlineRegular size={15} />
                </button>
              </HoverRow>
            ))}
          </ul>
          {showAdd && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '0.5fr 1.4fr',
                gap: 10,
                padding: 12,
                margin: '0 -8px',
                borderRadius: 12,
                border: '1px solid var(--dsw-alias-border-l3)',
              }}
            >
              <label>
                <span style={fieldLabel}>Name</span>
                <input
                  style={inputStyle}
                  value={draft.name}
                  placeholder="dev3"
                  onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }}
                />
              </label>
              <label>
                <span style={fieldLabel}>Token URL</span>
                <input
                  style={inputStyle}
                  value={draft.tokenUrl}
                  placeholder="https://192.0.2.130:4999/?token=…"
                  onChange={(event) => { setDraft({ ...draft, tokenUrl: event.target.value }) }}
                />
              </label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setDraft(EMPTY_DRAFT) }}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    font: 'inherit',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!draftValid || meshBusy}
                  onClick={() => { addRemote() }}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'color-mix(in srgb, currentColor 16%, transparent)',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: draftValid ? 'pointer' : 'default',
                    opacity: draftValid ? 1 : 0.5,
                  }}
                >
                  Add machine
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Agent runtimes */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <GroupHead title="Agent Runtimes" count={agents?.length ?? 0} />
          {/* Flag-off degradation hint (T-E shape, final-review polish): one
              chip for the whole section, not one per row — the roster stays
              informational and nothing navigates. The hint text names the
              degradation itself; no tooltip prefix re-states the flag. */}
          {!switchUi.available && (
            <div style={{ display: 'flex' }}>
              <span style={{ ...chip, color: 'var(--dsw-alias-label-caption)' }}>
                {switchUi.hint}
              </span>
            </div>
          )}
          {rosterFailed && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' }}>
              Live roster unavailable — showing the last known list.
            </p>
          )}
          <ul style={listStyle}>
            {agents === null && (
              <li style={{ padding: '9px 8px', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', listStyle: 'none' }}>
                Loading roster…
              </li>
            )}
            {groups !== undefined && groups.map((group) => (
              <React.Fragment key={group.key}>
                <li aria-hidden style={sectionHeadStyle}>{group.label}</li>
                {group.agents.map((agent) => renderRow(agent, false))}
              </React.Fragment>
            ))}
            {/* Flat fallback (the machines face never answered): today's
                rows, the raw machine id riding each row. */}
            {groups === undefined && agents?.map((agent) => renderRow(agent, true))}
          </ul>
        </section>
        </>)}
      </div>
    </div>
  )
}
