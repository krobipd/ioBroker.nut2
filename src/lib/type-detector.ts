import { parseDecimal } from "./coerce";

/** Known-string suffixes — always string regardless of numeric parsing. */
const KNOWN_STRING_SUFFIXES = new Set([
  "model",
  "mfr",
  "serial",
  "firmware",
  "status",
  "alarm",
  "date",
  "type",
  "id",
  "name",
  "desc",
  "location",
  "contact",
  "vendorid",
  "productid",
  // Opaque identifiers per the NUT catalog — keep as strings (leading zeros etc. must survive).
  "part",
  "address",
  "color",
  "groupid",
  // Text by definition in nut-names.txt; every one of these endings names exactly one catalog
  // variable, and each can arrive as bare digits from some driver: ups.firmware.aux ("4Kx", but
  // also "02.08"), ups.contacts and input.quality (apcsmart passes raw hex such as "00"/"0F"/"FF",
  // apcsmart_tabs.c:34/39), ups.test.result ("NO"/"OK" from apcsmart), input.transfer.reason,
  // ups.time, ups.display.language, device.macaddr, device.description, battery.date.maintenance,
  // outlet.n.designator, input.sensitivity ("H"), ambient.n.contacts.x.config,
  // experimental.ups.mode.buzzwords. As a number the first value would fix the type and every
  // later non-numeric reading would be lost.
  "aux",
  "contacts",
  "quality",
  "result",
  "reason",
  "time",
  "language",
  "macaddr",
  "description",
  "maintenance",
  "designator",
  "sensitivity",
  "config",
  "buzzwords",
]);

/** Known-string exact names — text although their last segment says nothing. */
const KNOWN_STRING_NAMES = new Set([
  // "Current UPS mode" (nut-names.txt). Not a "mode" ending: experimental.ups.relay.mode
  // (bicker_ser.c:504) and the experimental.*.mode bits of meanwell_ntu are numbers.
  "ups.mode",
  // "Rough approximation of battery charge (opaque, percent)", only ever "<85"/">85"
  // (drivers/nutdrv_siemens_sitop.c:237) — with the "charge" unit rule it was discarded as garbage.
  "battery.charge.approx",
]);

/** Known-string exact prefixes — always string. */
const KNOWN_STRING_PREFIXES = ["driver.version."];

/**
 * `driver.parameter.<key>` echoes the driver's ups.conf setting verbatim (drivers/main.c prints
 * every one with "%s"): `runtimecal = 240,100,720,50`, `bus = "001"`, `port = auto`. A config echo
 * is text — as a number `001` would lose its zeros and `runtimecal` would be discarded for its
 * "runtime" substring. The two exceptions are the poll timings the driver core itself publishes as
 * numbers (drivers/main.c:3177, `%jd`).
 */
const NUMERIC_DRIVER_PARAMETERS = new Set(["driver.parameter.pollinterval", "driver.parameter.pollfreq"]);

/**
 * Words drivers put into numeric fields to say "no reading right now" — a state, not garbage.
 * apc_modbus writes these for ups.efficiency (drivers/apc_modbus.c:509-545); NA/N/A, "not
 * available", "overrange" and "none" come from other drivers (metasys.c, belkinunv.c).
 */
const NUMERIC_STATE_WORDS = new Set([
  "notavailable",
  "not available",
  "loadtoolow",
  "outputoff",
  "onbattery",
  "inbypass",
  "batterycharging",
  "pooracinput",
  "batterydisconnected",
  "na",
  "n/a",
  "overrange",
  "none",
]);

/**
 * Namespaces outside the NUT catalog (driver-private additions). A unit guessed from their name is
 * a guess, not a contract: a non-numeric value stays text there instead of becoming an empty number
 * (apcmicrolink's experimental.output.voltage.setting reads "VAC230").
 */
const NON_CATALOG_PREFIXES = ["experimental.", "unmapped.", "vendor."];

/**
 * Countdown timers (`ups.timer.*`, `outlet[.n].timer.*`, `outlet.group.n.timer.*`). Drivers
 * disagree on how they say "no countdown running": the HID drivers report the raw `-1` (measured
 * on an Eaton Ellipse PRO 1600), apc_modbus converts it to the words `NotActive` and
 * `CountdownExpired` (drivers/apc_modbus.c). Both are mapped onto one meaning below.
 */
const TIMER_VARIABLE_RE = /(^|\.)timer\.(shutdown|start|reboot)$/;

/** Result of type detection for a NUT variable. */
export interface TypeDetectResult {
  /** ioBroker state type */
  type: "number" | "string" | "boolean";
  /** ioBroker state role */
  role: string;
  /** Unit string if applicable */
  unit?: string;
  /** Always true */
  read: true;
  /** Whether the variable is writable via SET VAR */
  write: boolean;
  /** Parsed value (number, string or boolean; null for a countdown that is not running) */
  parsedValue: number | string | boolean | null;
  /**
   * True when the variable name denotes a numeric quantity (carries a unit) but the raw value is
   * not a strict number. The result is then already a number without a value (`parsedValue: null`,
   * role and unit as for a reading): the datapoint stays a number and shows "no reading" instead of
   * keeping a stale one.
   */
  expectedNumeric?: boolean;
  /**
   * With expectedNumeric: the value is one of the words drivers use for "no reading right now"
   * (a state, logged at debug) rather than garbage (warned about once).
   */
  stateWord?: boolean;
}

/**
 * Detect ioBroker state type, role, and unit from a NUT variable name and raw value.
 *
 * @param varName NUT variable name (e.g. battery.charge)
 * @param rawValue Raw string value from LIST VAR
 * @param isWritable Whether the variable appears in LIST RW
 */
export function detectType(varName: string, rawValue: string, isWritable: boolean): TypeDetectResult {
  // Trim at the boundary: NUT pads some fields (measured on an Eaton Ellipse PRO 1600, whose
  // device.model reads "Ellipse PRO 1600 " with a trailing space). A padded string would show up
  // in every UI and break every comparison; the numeric and yes/no parsers trim anyway, so this
  // only ever changes text values.
  rawValue = rawValue.trim();
  // driver.flag.* is a NUT-core on/off flag (nut-names.txt: "Flag xxx"), reported by drivers as
  // enabled/disabled or 0/1. Model it as a real boolean instead of dead text. Kept read-only: the
  // only writable one (allow_killpower, ST_FLAG_NUMBER) is a dangerous kill-power switch whose SET
  // wire token (1/0) differs from the boolean write path's yes/no — read-only avoids both a silent
  // SET failure and an accidental toggle. An unrecognised value is kept as an opaque string
  // (below), never guessed as a number.
  if (varName.startsWith("driver.flag.")) {
    const flag = parseFlagValue(rawValue);
    if (flag !== undefined) {
      return {
        type: "boolean",
        role: "indicator",
        unit: undefined,
        read: true,
        write: false,
        parsedValue: flag,
      };
    }
    // A flag reporting an unexpected value stays an opaque string. Do NOT fall through to the
    // numeric heuristic: a value like "2" must not become a number state and flip the state's
    // type between polls. "Don't guess" — the flag namespace is only ever on/off in practice.
    return {
      type: "string",
      role: "text",
      unit: undefined,
      read: true,
      write: false,
      parsedValue: rawValue,
    };
  }

  // A countdown that is not running is EMPTY, not "minus one second" — and the apc_modbus wording
  // must not be discarded as garbage in a numeric field (it would warn on every poll).
  if (TIMER_VARIABLE_RE.test(varName)) {
    const idle = rawValue.toLowerCase();
    // The role has to match what the RUNNING countdown gets from detectRole below, or a writable
    // timer would carry a different role depending on which value the first poll happened to see.
    const idleRole = detectRole(varName, "number", isWritable);
    // "-1.0" is the same idle marker as "-1" — any driver printing it with "%.1f".
    if (idle === "notactive" || parseDecimal(rawValue) === -1) {
      return { type: "number", role: idleRole, unit: "s", read: true, write: isWritable, parsedValue: null };
    }
    if (idle === "countdownexpired") {
      return { type: "number", role: idleRole, unit: "s", read: true, write: isWritable, parsedValue: 0 };
    }
  }

  if (isKnownString(varName)) {
    return {
      type: "string",
      role: detectRole(varName, "string", isWritable),
      unit: undefined,
      read: true,
      write: isWritable,
      parsedValue: rawValue,
    };
  }

  // A yes/no reading is a real boolean state, not a text dump — even when the variable name
  // carries a numeric-unit substring (e.g. input.frequency.extended = "no", ambient.n.present =
  // "yes"). Value-driven so it covers every driver's yes/no variables, not a hand-kept list.
  // After the known-string check so an opaque text field that happens to read "no" stays a string.
  const bool = parseYesNo(rawValue);
  if (bool !== undefined) {
    return {
      type: "boolean",
      role: isWritable ? "switch" : "indicator",
      unit: undefined,
      read: true,
      write: isWritable,
      parsedValue: bool,
    };
  }

  // Strict decimal only (same fleet line as the config coerce): garbage suffixes
  // ("12abc" → 12) and non-finite tokens ("Infinity" → null on setState) must NOT
  // become numbers — a number field never holds letters. Such values stay raw strings.
  const num = parseDecimal(rawValue);
  if (Number.isFinite(num)) {
    return {
      type: "number",
      role: detectRole(varName, "number", isWritable),
      unit: detectUnit(varName),
      read: true,
      write: isWritable,
      parsedValue: num,
    };
  }

  // Not a known string and not a strict number. A catalog variable whose name carries a unit is a
  // measurement: the datapoint stays a number and gets no value (null) — a driver saying "no reading"
  // (apc_modbus: ups.efficiency = OnBattery while on battery) must not leave the last reading
  // standing, and must not turn the datapoint into text either.
  const unit = detectUnit(varName);
  if (unit !== undefined && !NON_CATALOG_PREFIXES.some(p => varName.startsWith(p))) {
    return {
      type: "number",
      role: detectRole(varName, "number", isWritable),
      unit,
      read: true,
      write: isWritable,
      parsedValue: null,
      expectedNumeric: true,
      stateWord: NUMERIC_STATE_WORDS.has(rawValue.toLowerCase()),
    };
  }
  // Everything else is an opaque string.
  return {
    type: "string",
    role: detectRole(varName, "string", isWritable),
    unit: undefined,
    read: true,
    write: isWritable,
    parsedValue: rawValue,
  };
}

/**
 * Whether a raw value is one of the words drivers put into a numeric field for "no reading right
 * now" (see NUMERIC_STATE_WORDS).
 *
 * @param rawValue Raw string value from LIST VAR
 */
export function isNumericStateWord(rawValue: string): boolean {
  return NUMERIC_STATE_WORDS.has(rawValue.trim().toLowerCase());
}

/**
 * NUT yes/no fields become real boolean states (the point of the typed rewrite), not text.
 *
 * @param rawValue Raw string value from LIST VAR
 */
function parseYesNo(rawValue: string): boolean | undefined {
  const v = rawValue.trim().toLowerCase();
  if (v === "yes") {
    return true;
  }
  if (v === "no") {
    return false;
  }
  return undefined;
}

/**
 * driver.flag.* surfaces as a NUT-core on/off flag whose textual form varies by driver
 * (enabled | disabled | 0 | 1). Map it to boolean; anything else is not a flag we recognise.
 * Scoped to driver.flag.* so bare 0/1 stays numeric for every other variable.
 *
 * @param rawValue Raw string value from LIST VAR
 */
function parseFlagValue(rawValue: string): boolean | undefined {
  const v = rawValue.trim().toLowerCase();
  if (v === "enabled" || v === "on" || v === "yes" || v === "true" || v === "1") {
    return true;
  }
  if (v === "disabled" || v === "off" || v === "no" || v === "false" || v === "0") {
    return false;
  }
  return undefined;
}

function isKnownString(varName: string): boolean {
  if (KNOWN_STRING_NAMES.has(varName)) {
    return true;
  }
  const lastDot = varName.lastIndexOf(".");
  if (lastDot >= 0) {
    // Case-insensitive: drivers are not consistent (driver.parameter.productID, vendorID).
    const suffix = varName.slice(lastDot + 1).toLowerCase();
    if (KNOWN_STRING_SUFFIXES.has(suffix)) {
      return true;
    }
  }

  if (varName.startsWith("driver.parameter.") && !NUMERIC_DRIVER_PARAMETERS.has(varName)) {
    return true;
  }

  for (const prefix of KNOWN_STRING_PREFIXES) {
    if (varName.startsWith(prefix)) {
      return true;
    }
  }

  if (varName.includes(".version")) {
    return true;
  }

  return false;
}

// Transfer/bypass voltage set-points (input.transfer.{low,high,min,max}, input.transfer.hysteresis)
// carry no "voltage" token in the name but are volts — used for both unit and role detection.
function isTransferVoltage(varName: string): boolean {
  return /^input\.transfer\.(.*\.)?(low|high|min|max)$/.test(varName) || varName === "input.transfer.hysteresis";
}

// Only called for numeric variables (string vars never carry a unit).
function detectUnit(varName: string): string | undefined {
  // Percent-of-nominal ranges carry "frequency" in the name but are a percentage, and every
  // *.percent is a share (output.L1.power.percent, power.maximum.percent) — checked first, before
  // the quantity its name mentions.
  if (/\.frequency\..+\.range$/.test(varName) || isPercent(varName)) {
    return "%";
  }
  // Minutes (checked before the generic seconds rules that also match ".delay").
  if (varName === "battery.energysave.delay") {
    return "min";
  }
  if (varName.includes("voltage") || isTransferVoltage(varName)) {
    return "V";
  }
  if (varName.includes("frequency")) {
    return "Hz";
  }
  if (varName.includes("current")) {
    return "A";
  }
  if (varName.includes("charge")) {
    return "%";
  }
  if (varName.includes("humidity")) {
    return "%";
  }
  if (
    varName.endsWith(".load") ||
    varName.endsWith(".load.high") ||
    varName.endsWith(".efficiency") ||
    varName.endsWith(".percent")
  ) {
    return "%";
  }
  if (varName.includes("temperature")) {
    return "°C";
  }
  if (
    varName.includes("runtime") ||
    varName.includes(".delay.") ||
    varName.endsWith(".delay") ||
    varName.includes(".timer.") ||
    varName.endsWith(".uptime") ||
    varName.endsWith(".test.interval") ||
    varName.endsWith(".latency")
  ) {
    return "s";
  }
  // Real power in W; apparent power in VA — including the seen extremes (nut-names.txt:
  // "Maximum seen apparent power (VA)").
  if (/(^|\.)realpower(\.(nominal|maximum|minimum))?$/.test(varName)) {
    return "W";
  }
  if (/(^|\.)power(\.(nominal|maximum|minimum))?$/.test(varName)) {
    return "VA";
  }
  if (varName.includes("capacity")) {
    return "Ah";
  }
  if (varName === "input.phase.shift") {
    return "°";
  }
  return undefined;
}

/**
 * Whether a variable is a share in percent (`*.percent`, `percent`).
 *
 * @param varName NUT variable name
 */
function isPercent(varName: string): boolean {
  return varName === "percent" || varName.endsWith(".percent");
}

/**
 * Whether a variable is a duration or interval in seconds (or minutes for the energy-save delay).
 *
 * @param varName NUT variable name
 */
function isDuration(varName: string): boolean {
  return (
    varName.includes("runtime") ||
    varName.includes(".delay.") ||
    varName.endsWith(".delay") ||
    varName.includes(".timer.") ||
    varName.endsWith(".uptime") ||
    varName.endsWith(".test.interval") ||
    varName.endsWith(".latency")
  );
}

function detectRole(varName: string, type: "number" | "string", isWritable: boolean): string {
  // ups.status is the one string that always gets a text role.
  if (varName === "ups.status") {
    return "text";
  }
  // String states never get a value.* role — they are text (or a writable text field).
  if (type === "string") {
    return "text";
  }

  // Numeric roles. A writable variable is a set-point: it gets the level.* role of its quantity
  // where ioBroker has one (level.voltage/.current/.temperature/.frequency/.humidity/.timer; the
  // repochecker requires write:false for every value.* role), the plain `level` otherwise.
  if (varName === "battery.charge") {
    return "value.battery";
  }
  // A share is a share, whatever quantity its name mentions — never value.power with unit "%".
  if (isPercent(varName)) {
    return isWritable ? "level" : "value";
  }
  if (varName.includes("voltage") || isTransferVoltage(varName)) {
    return isWritable ? "level.voltage" : "value.voltage";
  }
  if (varName.includes("temperature")) {
    return isWritable ? "level.temperature" : "value.temperature";
  }
  if (varName.includes("current")) {
    return isWritable ? "level.current" : "value.current";
  }
  // Real frequency (Hz) → value.frequency. A "*.frequency.*.range" is a percentage-of-nominal
  // band (unit %), not a frequency reading, so it stays the generic value role.
  if (varName.includes("frequency") && !/\.frequency\..+\.range$/.test(varName)) {
    return isWritable ? "level.frequency" : "value.frequency";
  }
  if (varName.includes("humidity")) {
    return isWritable ? "level.humidity" : "value.humidity";
  }
  // "powerfactor" contains "power" but is a 0..1 factor, not a power value.
  if (varName.includes("power") && !varName.includes("powerfactor")) {
    if (isWritable) {
      return "level";
    }
    // Real power is value.power.active (W). Apparent power (VA) has no role of its own —
    // value.power requires W/kW in the role catalog, and value.power.apparent does not exist — so
    // it is the generic value with unit VA.
    return varName.includes("realpower") ? "value.power.active" : "value";
  }
  if (varName === "battery.energysave.delay") {
    // Minutes; value.interval is documented for seconds.
    return isWritable ? "level.timer" : "value";
  }
  if (isDuration(varName)) {
    return isWritable ? "level.timer" : "value.interval";
  }

  return isWritable ? "level" : "value";
}

const KNOWN_ENUM_STATES: Record<string, Record<string, string>> = {
  "battery.charger.status": {
    charging: "charging",
    discharging: "discharging",
    floating: "floating",
    resting: "resting",
  },
  "ups.beeper.status": {
    enabled: "enabled",
    disabled: "disabled",
    muted: "muted",
  },
  // Device type is a fixed enumeration per the NUT catalogue (nut-names.txt: device.type).
  "device.type": {
    ups: "ups",
    pdu: "pdu",
    scd: "scd",
    psu: "psu",
    ats: "ats",
  },
};

const OUTLET_ON_OFF: Record<string, string> = { on: "on", off: "off" };

// good / warning-low / warning-high / critical-low / critical-high — threshold status enum for
// *.voltage.status, *.current.status, ambient.*.{temperature,humidity}.status (incl. three-phase
// variants like input.L1.voltage.status).
const THRESHOLD_STATUS: Record<string, string> = {
  good: "good",
  "warning-low": "warning-low",
  "warning-high": "warning-high",
  "critical-low": "critical-low",
  "critical-high": "critical-high",
};

// Frequency status additionally reports "out-of-range".
const FREQUENCY_STATUS: Record<string, string> = { ...THRESHOLD_STATUS, "out-of-range": "out-of-range" };

// Two-state toggles reported as a word (ups.watchdog.status, ups.shutdown,
// input.transfer.bypass.{forced,overload,outlimits}, input.bypass.switchable,
// ambient.*.{temperature,humidity}.alarm) — an enum, not bare text.
const ENABLED_DISABLED: Record<string, string> = { enabled: "enabled", disabled: "disabled" };

// Dry-contact sensor status: raw open/closed, or active/inactive relative to its configuration.
const CONTACTS_STATUS: Record<string, string> = {
  open: "open",
  closed: "closed",
  active: "active",
  inactive: "inactive",
};

/**
 * Detect common.states for known enum variables.
 *
 * @param varName NUT variable name
 */
export function detectStates(varName: string): Record<string, string> | undefined {
  if (KNOWN_ENUM_STATES[varName]) {
    return KNOWN_ENUM_STATES[varName];
  }
  // on/off switches — individual outlets and outlet groups.
  if (/^outlet(\.\d+)?\.(switch|status)$/.test(varName) || /^outlet\.group(\.\d+)?\.status$/.test(varName)) {
    return OUTLET_ON_OFF;
  }
  // Threshold status enums (frequency additionally reports out-of-range). The (^|\.) anchor also
  // catches the top-level forms (voltage.status, current.status, frequency.status) the NUT catalogue
  // lists alongside the input.*/output.* variants — otherwise they fell through to opaque text.
  if (/(^|\.)frequency\.status$/.test(varName)) {
    return FREQUENCY_STATUS;
  }
  if (/(^|\.)(voltage|current|temperature|humidity)\.status$/.test(varName)) {
    return THRESHOLD_STATUS;
  }
  // Two-state enabled/disabled toggles that would otherwise fall through to bare text.
  if (
    varName === "ups.watchdog.status" ||
    varName === "ups.shutdown" ||
    varName === "input.bypass.switchable" ||
    /^input\.transfer\.bypass\.(forced|overload|outlimits)$/.test(varName) ||
    /^ambient(\.\d+)?\.(temperature|humidity)\.alarm$/.test(varName)
  ) {
    return ENABLED_DISABLED;
  }
  // Dry-contact sensor status.
  if (/^ambient(\.\d+)?\.contacts\.\d+\.status$/.test(varName)) {
    return CONTACTS_STATUS;
  }
  return undefined;
}
