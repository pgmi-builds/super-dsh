/**
 * Static model catalog for the Gemini consumer surface. The google-antigravity
 * SDK has no model-list API and the CLI catalog path is auth-gated, so the
 * catalog is static AND endpoint-verified (2026-09-18 probes on both auth
 * planes; non-listed slugs 404 / are retired).
 *
 * Model ids are PLAIN slugs — thinking effort is a per-route option surfaced
 * through the adapter's reasoning metadata (WebUI Effort selector →
 * AgentOptions.reasoningEffort), NOT extra catalog entries (user ruling
 * 2026-09-18).
 */

export interface AgyCatalogModel {
  slug: string;
  label: string;
  /** Effort levels the CLI/SDK accept for this slug (absent = no effort param). */
  efforts?: readonly string[];
  defaultEffort?: string;
}

/**
 * The effort vocabulary is Antigravity's, not DSH's — the WebUI's Effort slot is
 * only a SLOT; the values offered through it are borrowed from the runtime
 * (2026-10-02 user ruling). `agy --help` advertises `low|medium|high|max`, so
 * `max` belongs in the list: the previous three-value vocabulary was DSH's own
 * and silently hid a level the CLI accepts.
 *
 * Capability stays per-model: a model without `efforts` gets NO effort flag at
 * all (see resolveEffort), and per-model acceptance of `max` still needs a
 * working auth plane to confirm — no live plane could be probed on 2026-10-02
 * (ADC serves no catalog; the account plane is eligibility-gated headless).
 */
/**
 * The catalog as the CLI ACTUALLY serves it (probed 2026-10-02 on dev3 against
 * the live key plane; the CLI answers `available: <levels>` when `--effort` is
 * omitted, which is the authoritative per-model vocabulary):
 *
 *   gemini-3.1-pro    low, high          (NO medium — a global list cannot say this)
 *   gemini-3.7-flash  low, medium, high
 *   gemini-3.6-flash  low, medium, high
 *   gemini-3.8-flash  low, medium, high
 *   gemini-2.5-pro / 2.5-flash / 3.5-flash → `not recognized as a known model`
 *
 * `efforts` therefore exists to describe a model's real vocabulary, NOT to be
 * transmitted as a default (see resolveEffort: undecided sends nothing).
 * `defaultEffort` is the Effort slot's display default only.
 *
 * MODEL LIST SOURCE: the CLI itself enumerates via
 * `POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
 * (+ `v1internal:listModelConfigs`), which needs an eligible account AND a
 * quota project with Cloud Code PA enabled. Neither transport could reach it on
 * this machine (ADC: API disabled / no bind permission on the project; account:
 * headless eligibility gate), so this table stays a static capture per
 * dev-rules §16a — with a probe path recorded for whoever has a working plane.
 */
export const AGY_MODEL_CATALOG: readonly AgyCatalogModel[] = [
  { slug: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { slug: "gemini-3.7-flash", label: "Gemini 3.7 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { slug: "gemini-3.6-flash", label: "Gemini 3.6 Flash", efforts: ["low", "medium", "high"], defaultEffort: "low" },
  { slug: "gemini-3.1-pro", label: "Gemini 3.1 Pro", efforts: ["low", "high"], defaultEffort: "low" },
];

/** Selectable model ids (plain slugs). */
export function modelIds(): string[] {
  return AGY_MODEL_CATALOG.map((m) => m.slug);
}

export function catalogSlugs(): string[] {
  return modelIds();
}

/** Parse a selectable model id: plain slug, or legacy `slug@level`. */
export function parseModelId(id: string | undefined): { slug: string; thinkingLevel?: string } | undefined {
  if (id === undefined) return undefined;
  const at = id.indexOf("@");
  const slug = at < 0 ? id : id.slice(0, at);
  if (!catalogSlugs().includes(slug)) return undefined;
  if (at < 0) return { slug };
  const level = id.slice(at + 1);
  const entry = AGY_MODEL_CATALOG.find((m) => m.slug === slug);
  if (entry?.efforts && entry.efforts.includes(level)) return { slug, thinkingLevel: level };
  return { slug };
}

/** Efforts for a slug (undefined = the slug takes no effort parameter). */
export function effortsFor(slug: string): readonly string[] | undefined {
  return AGY_MODEL_CATALOG.find((m) => m.slug === slug)?.efforts;
}

export function defaultEffortFor(slug: string): string | undefined {
  return AGY_MODEL_CATALOG.find((m) => m.slug === slug)?.defaultEffort;
}

/** Cheapest live pair on the CLI key path (probed 2026-09-18). CLI default. */
export const CLI_DEFAULT_MODEL: { slug: string; thinkingLevel: string } = {
  slug: "gemini-3.6-flash",
  thinkingLevel: "low",
};

/**
 * The `--effort` value to send for one model.
 *
 * `--effort` is REQUIRED, not optional: omitting it makes the CLI refuse to
 * start (`--model X requires --effort (available: low, high)` — verified
 * 2026-10-02 against 3.8-flash, 3.7-flash and 3.1-pro). So this always returns a
 * level for a known model; the only `undefined` case is a slug with no declared
 * vocabulary, where we forward exactly what was asked for.
 *
 * The per-model step is what matters: the original defect read
 * CLI_DEFAULT_MODEL's level wholesale (a 3.6-flash constant), so every model
 * got `--effort low` whatever the UI showed, and 3.1-pro — which serves only
 * low|high — could never start.
 *
 * Precedence: an explicit session choice (the WebUI Effort selector arrives as
 * `AgentOptions.reasoningEffort`) > a legacy `slug@level` id suffix > THIS
 * model's own declared default.
 *
 * The third arm is the one that matters: it used to read
 * {@link CLI_DEFAULT_MODEL}'s thinking level wholesale — a constant belonging
 * to the 3.6-flash cheap pair — so every model was sent `--effort low` no
 * matter what the UI showed (observed 2026-10-02: 3.7 Flash + UI "medium" →
 * the CLI received `--effort "low"` and refused it). A slug that declares no
 * effort support yields `undefined`: sending a flag the model rejects is worse
 * than sending none.
 *
 * `slug` is the model actually being launched; an unrecognised slug (the
 * caller already fell back to the CLI default pair) inherits that pair's level.
 *
 * @param slug - the model id being launched (a catalog slug).
 * @param explicit - the session's reasoning-effort choice, when it made one.
 * @param legacyLevel - effort decoded from a `slug@level` id, when present.
 * @returns the effort to pass, or `undefined` to pass no `--effort`.
 */
export function resolveEffort(
  slug: string,
  explicit?: string | undefined,
  legacyLevel?: string | undefined,
): string | undefined {
  const entry = AGY_MODEL_CATALOG.find((m) => m.slug === slug);
  const allowed = entry?.efforts;
  const wanted = firstNonEmpty(explicit, legacyLevel);

  // No declared vocabulary (a slug we do not know): forward exactly what was
  // asked for and no more. We cannot validate against a set we do not have.
  if (allowed === undefined) return wanted;

  if (wanted !== undefined && allowed.includes(wanted)) return wanted;

  // Either nothing was chosen or the chosen level is not one THIS model serves
  // (a stale session, a model swap). Either way we must still send a level:
  // the CLI refuses to start without one —
  //   `--model X requires --effort (available: low, high)`
  // verified 2026-10-02 against 3.8-flash, 3.7-flash and 3.1-pro. So fall back
  // to the model's own default, then to its cheapest available level, instead
  // of transmitting nothing (fatal) or another model's constant (the original
  // defect: every model got 3.6-flash's "low", and 3.1-pro has no medium).
  const fallback = entry?.defaultEffort;
  if (fallback !== undefined && allowed.includes(fallback)) return fallback;
  return allowed[0];
}

/** First non-empty string, or undefined. An empty value is an absent choice. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Normalize a model reference to an SDK-facing slug. The native TUI settings
 * store display names ("Gemini 3.7 Flash (Medium)"); slugs pass through;
 * unknown display names → undefined (caller uses the catalog head).
 */
export function toModelSlug(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const v = model.trim();
  if (!v) return undefined;
  if (/^[a-z0-9.-]+$/.test(v) && !v.includes(" ")) return v;
  const base = v.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  const slug = base.replace(/\s+/g, "-");
  if (catalogSlugs().includes(slug)) return slug;
  if (/^gemini-[0-9]/.test(slug)) return slug;
  return undefined;
}
