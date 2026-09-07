import type { I18nKey } from "./i18n";

/** Parsed status flags with individual booleans and computed severity. */
export interface StatusResult {
  /** Raw status string (e.g. "OL CHRG") */
  raw: string;
  /** Individual boolean flags */
  flags: Record<string, boolean>;
  /** Computed severity: 0=OK, 1=Info, 2=Warning, 3=Critical, 4=Emergency */
  severity: number;
}

/** One status-flag definition. Single source of truth for token, flag id, label, i18n key and role. */
interface StatusFlagDef {
  /** NUT ups.status token */
  token: string;
  /** ioBroker boolean state id (leaf under status.) */
  flag: string;
  /** admin/i18n key for the state name */
  i18nKey: I18nKey;
  /** ioBroker state role */
  role: string;
}

// Authoritative ups.status flag catalog, verified against the bundled NUT 2.8.5 source
// (`grep status_set(` across drivers/) and docs/new-drivers.txt. Documented standard set:
// the 14 core tokens (OL..FSD) + ALARM (set internally by alarm_set, not status_set) +
// WAIT (upsd's initial value while a driver connects). Non-documented but real extras
// emitted by multiple shipped drivers are also mapped: TEST (5 drivers incl. apc_modbus,
// powercom), OVERHEAT (belkinunv, microsol), and ECO (emerging eco-mode, real on Eaton
// Ellipse ECO; legacy name "HE" aliased via STATUS_ALIASES). Driver-private one-off tokens
// (ACFAIL/COMMFAULT/DEPLETED/BY/TIP/SD — mostly "self-invented" in a single driver) are
// intentionally NOT mapped: per new-drivers.txt clients MAY ignore unidentified tokens, and
// any such token still appears verbatim in status.raw / status.display.
const STATUS_CATALOG: StatusFlagDef[] = [
  { token: "OL", flag: "online", i18nKey: "flagOnline", role: "indicator" },
  { token: "OB", flag: "onBattery", i18nKey: "flagOnBattery", role: "indicator.alarm" },
  { token: "LB", flag: "lowBattery", i18nKey: "flagLowBattery", role: "indicator.lowbat" },
  { token: "HB", flag: "highBattery", i18nKey: "flagHighBattery", role: "indicator" },
  {
    token: "RB",
    flag: "replaceBattery",
    i18nKey: "flagReplaceBattery",
    role: "indicator.maintenance",
  },
  { token: "CHRG", flag: "charging", i18nKey: "flagCharging", role: "indicator" },
  { token: "DISCHRG", flag: "discharging", i18nKey: "flagDischarging", role: "indicator" },
  { token: "BYPASS", flag: "bypass", i18nKey: "flagBypass", role: "indicator" },
  { token: "CAL", flag: "calibrating", i18nKey: "flagCalibrating", role: "indicator" },
  { token: "OFF", flag: "off", i18nKey: "flagOff", role: "indicator" },
  { token: "OVER", flag: "overloaded", i18nKey: "flagOverloaded", role: "indicator.alarm" },
  { token: "TRIM", flag: "trimming", i18nKey: "flagTrimming", role: "indicator" },
  { token: "BOOST", flag: "boosting", i18nKey: "flagBoosting", role: "indicator" },
  {
    token: "FSD",
    flag: "forcedShutdown",
    i18nKey: "flagForcedShutdown",
    role: "indicator.alarm",
  },
  { token: "ALARM", flag: "alarm", i18nKey: "flagAlarm", role: "indicator.alarm" },
  { token: "WAIT", flag: "waiting", i18nKey: "flagWaiting", role: "indicator" },
  { token: "ECO", flag: "ecoMode", i18nKey: "flagEcoMode", role: "indicator" },
  { token: "TEST", flag: "testing", i18nKey: "flagTesting", role: "indicator" },
  { token: "OVERHEAT", flag: "overheat", i18nKey: "flagOverheat", role: "indicator.alarm" },
];

/** Legacy / alternative tokens mapped to a catalog token (e.g. legacy "HE" → "ECO"). */
const STATUS_ALIASES: Record<string, string> = {
  HE: "ECO",
};

/** token → flag id (incl. aliases). */
export const STATUS_FLAGS: Record<string, string> = {};
/**
 * flag id → { i18nKey, descKey, role } (for state-manager). The description key is derived from
 * the name key (`flagOnline` → `descFlagOnline`) so the catalog above stays the single place a
 * flag is declared; `admin/i18n/en.json` is what decides whether the key really exists.
 */
export const FLAG_META: Record<string, { i18nKey: I18nKey; descKey: I18nKey; role: string }> = {};
for (const d of STATUS_CATALOG) {
  STATUS_FLAGS[d.token] = d.flag;
  FLAG_META[d.flag] = {
    i18nKey: d.i18nKey,
    descKey: descKeyOf(d.i18nKey),
    role: d.role,
  };
}
for (const [alias, token] of Object.entries(STATUS_ALIASES)) {
  STATUS_FLAGS[alias] = STATUS_FLAGS[token];
}

/**
 * The description key that belongs to a name key: `flagOnline` → `descFlagOnline`.
 *
 * The convention is what keeps `admin/i18n/en.json` the single place that decides whether an
 * explanation exists — no second catalog listing the same entries again. Lives here because the
 * flag catalog above is its first user, and because `state-manager.ts` (its second user, for the
 * instant commands) already imports from this module: no new dependency edge, and this file stays
 * free of `adapter-core` so it remains testable on its own.
 *
 * @param nameKey The admin/i18n key of the name
 */
export function descKeyOf(nameKey: I18nKey): I18nKey {
  return `desc${nameKey.charAt(0).toUpperCase()}${nameKey.slice(1)}` as I18nKey;
}

/** All known flag keys for creating default-false states (catalog order). */
export const ALL_FLAG_KEYS = STATUS_CATALOG.map(d => d.flag);

/**
 * Parse ups.status space-separated flags into individual booleans and severity.
 *
 * @param rawStatus Raw ups.status value (e.g. "OL CHRG")
 * @param chargerStatus Optional battery.charger.status value (modern NUT source for charging/discharging)
 */
export function parseStatus(rawStatus: string, chargerStatus?: string): StatusResult {
  const tokens = rawStatus
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);

  const flags: Record<string, boolean> = {};
  for (const key of ALL_FLAG_KEYS) {
    flags[key] = false;
  }

  const activeTokens = new Set<string>();
  for (const token of tokens) {
    const flag = STATUS_FLAGS[token];
    if (flag) {
      flags[flag] = true;
      activeTokens.add(token);
    }
  }

  // Modern NUT exposes charging state via battery.charger.status instead of CHRG/DISCHRG
  // flags (e.g. Eaton Ellipse ECO). Derive charging/discharging from it when present.
  if (chargerStatus) {
    const cs = chargerStatus.trim().toLowerCase();
    if (cs === "charging") {
      flags.charging = true;
    } else if (cs === "discharging") {
      flags.discharging = true;
    }
    // "floating" (maintained) / "resting" (idle) → neither charging nor discharging
  }

  const severity = computeSeverity(activeTokens);

  return { raw: rawStatus, flags, severity };
}

/** One entry of the readable status line: the catalog key when known, else the raw token. */
export interface DisplayEntry {
  /** admin/i18n key of the flag label, absent for a token this adapter does not map. */
  i18nKey?: I18nKey;
  /** The raw NUT token — the fallback text for an unmapped token. */
  token: string;
}

/** token → the flag's admin/i18n key (incl. aliases), for the readable status line. */
const DISPLAY_I18N: Record<string, I18nKey> = {};
for (const d of STATUS_CATALOG) {
  DISPLAY_I18N[d.token] = d.i18nKey;
}
for (const [alias, token] of Object.entries(STATUS_ALIASES)) {
  DISPLAY_I18N[alias] = DISPLAY_I18N[token];
}

/**
 * Split raw ups.status into the entries of the readable status line. Kept as keys rather than
 * text because the line is user-facing and has to follow the system language — the caller
 * resolves the keys (this module stays pure and testable without adapter-core).
 *
 * @param rawStatus Raw ups.status value (e.g. "OL CHRG")
 */
export function getDisplayEntries(rawStatus: string): DisplayEntry[] {
  return rawStatus
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(token => (DISPLAY_I18N[token] ? { i18nKey: DISPLAY_I18N[token], token } : { token }));
}

// Severity reflects the POWER-SOURCE state only (OL → trimming → on battery → critical →
// forced shutdown). Fault flags such as OVER/ALARM/OFF are intentionally NOT folded in —
// they are exposed as their own booleans; conflating them here would dilute a single-meaning
// value. Design decision (krobi 2026-05-31), not an oversight.
function computeSeverity(tokens: Set<string>): number {
  if (tokens.has("FSD")) {
    return 4;
  }
  if (tokens.has("OB") && tokens.has("LB")) {
    return 3;
  }
  if (tokens.has("OB") || tokens.has("RB") || tokens.has("BYPASS")) {
    return 2;
  }
  if (tokens.has("TRIM") || tokens.has("BOOST") || tokens.has("CAL")) {
    return 1;
  }
  return 0;
}
