import { NUT_DEFAULT_COMMAND_TIMEOUT, NUT_DEFAULT_PORT } from "./types";
import type { AdapterConfig, NutClientOptions } from "./types";

// Strict decimal-only number parsing (fleet line, hassemu E8 origin): a plain
// float parse would half-accept garbage suffixes ("34abc" → 34) and allow
// hex/exponential notation. Only `-?\d+(\.\d+)?` counts as a number.
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Strict decimal parse: returns the number only for a plain finite decimal
 * (`-?\d+(\.\d+)?`), otherwise NaN. Rejects garbage suffixes ("12abc"),
 * non-finite tokens ("Infinity") and hex/exponential notation. Shared by the
 * config validators and the device-value type detector.
 *
 * @param raw Raw value (string from NUT/admin config, or already a number)
 */
export function parseDecimal(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : NaN;
  }
  if (typeof raw === "string" && DECIMAL_NUMBER_RE.test(raw.trim())) {
    return Number(raw.trim());
  }
  return NaN;
}

/**
 * Extract a log-friendly message from a thrown / rejected value.
 *
 * @param err Caught value of unknown shape
 */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return "null";
  }
  if (err === undefined) {
    return "undefined";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    // JSON.stringify(Symbol()) returns undefined (it does NOT throw), so the
    // catch below never runs and the declared `string` return would be a lie.
    // String(symbol) is the only safe conversion — `${symbol}` throws.
    return String(err);
  }
  // Plain objects would otherwise stringify to "[object Object]". Prefer JSON so
  // the log is at least diagnosable; circular structures fall back to the tag.
  try {
    // A function, or an object whose toJSON drops everything, also yields
    // undefined here — fall back rather than returning a non-string.
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

/**
 * Validate and return the NUT server host. Returns null if the host
 * is missing or not a non-empty string after trimming.
 *
 * @param raw Raw host value from admin config
 */
export function coerceHost(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the outgoing source-bind address from the admin `networkInterface`.
 * Empty or the "all interfaces" sentinel `0.0.0.0` mean "let the OS choose the
 * source" → undefined (no explicit bind).
 *
 * @param raw Raw networkInterface value from admin config
 */
export function localAddressOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed !== "0.0.0.0" ? trimmed : undefined;
}

/**
 * Coerce NUT port to a valid integer in [1, 65535], default NUT_DEFAULT_PORT.
 *
 * @param raw Raw port value from admin config
 */
export function coercePort(raw: unknown): number {
  const n = parseDecimal(raw);
  if (!Number.isFinite(n)) {
    return NUT_DEFAULT_PORT;
  }
  return Math.max(1, Math.min(65535, Math.floor(n)));
}

/**
 * Coerce poll interval to seconds, clamped to [2, 300], default 15.
 * Matches admin/jsonConfig min/max.
 *
 * The lower bound is where NUT itself stops producing new data: ups.conf's
 * `pollinterval` — how often the driver refreshes the UPS status — defaults to
 * 2 seconds, and `pollfreq` (the full variable set, usbhid-ups/snmp-ups/nutdrv_qx)
 * to 30. Polling faster than the driver only re-reads unchanged values.
 *
 * @param raw Raw pollInterval from admin config (seconds)
 */
export function coercePollIntervalSec(raw: unknown): number {
  const n = parseDecimal(raw);
  if (!Number.isFinite(n)) {
    return 15;
  }
  return Math.max(2, Math.min(300, Math.floor(n)));
}

/**
 * Coerce command timeout from seconds to milliseconds,
 * clamped to [1s, 30s] → [1000, 30000], default 5000ms.
 *
 * @param raw Raw commandTimeout from admin config (seconds)
 */
export function coerceCommandTimeoutMs(raw: unknown): number {
  const n = parseDecimal(raw);
  if (!Number.isFinite(n)) {
    return NUT_DEFAULT_COMMAND_TIMEOUT;
  }
  return Math.max(1, Math.min(30, Math.floor(n))) * 1000;
}

/**
 * The connection options every NutClient in this adapter is built with, derived from the config.
 *
 * ONE source for all of them — the live connection, the short-lived credential probe and the
 * admin's connection-test client. Design #32 asks the probe to walk the same path as the adapter
 * and #40 asks the test to tell the same story; both used to be honoured by two independent
 * copies of this mapping (main.ts and message-router.ts), so an option added to one silently
 * missed the other and the test button would have exercised a different connection than the one
 * it reports on.
 *
 * The runtime-only fields (`setTimer`/`clearTimer`/`logger`) stay with the caller: they are not
 * configuration, and the connection test deliberately runs on the plain global timers.
 *
 * @param config Adapter config (partial — the connection test receives it from the admin message)
 */
export function nutClientOptionsFrom(config: Partial<AdapterConfig>): NutClientOptions {
  return {
    localAddress: localAddressOf(config.networkInterface),
    commandTimeout: coerceCommandTimeoutMs(config.commandTimeout),
    useTls: !!config.useTls,
    tlsRejectUnauthorized: !!config.tlsRejectUnauthorized,
    tlsCaFile: typeof config.tlsCaFile === "string" ? config.tlsCaFile : "",
  };
}

/**
 * Exponential reconnect backoff: attempt 1 → baseMs, doubling each attempt, capped at maxMs.
 *
 * @param attempt 1-based attempt counter (values < 1 are treated as 1)
 * @param baseMs Delay for the first attempt
 * @param maxMs Upper bound for the delay
 */
export function computeReconnectDelay(attempt: number, baseMs: number, maxMs: number): number {
  const a = Math.max(1, Math.floor(attempt));
  return Math.min(baseMs * 2 ** (a - 1), maxMs);
}

/** Parsed write to the `notify` trigger state. */
export interface NotifyTrigger {
  /** upsmon $NOTIFYTYPE (first token), "" for a bare manual refresh. */
  type: string;
  /** upsmon $UPSNAME with the `@host[:port]` part stripped, "" when absent. */
  upsRef: string;
  /**
   * The value as it is kept: trimmed and capped. Echoed back into the trigger state as the
   * acknowledgement instead of the raw write — an object or an overlong blob must not land in
   * a string state through the doorbell.
   */
  text: string;
}

// The state is writable from outside (REST API) — cap what we keep so a stray
// blob cannot be pushed into the object DB through the doorbell.
const NOTIFY_MAX_LENGTH = 200;

/**
 * Parse a write to the `notify` trigger state into event type + UPS reference.
 * The documented format is `$NOTIFYTYPE $UPSNAME` as upsmon delivers them; the
 * UPS part is optional (manual refresh) and may itself contain spaces, so the
 * reference is everything after the first whitespace run. upsmon's $UPSNAME
 * carries the monitored system as `name@host[:port]` — only the name matters
 * here, the host is already fixed in the adapter config.
 *
 * @param raw Raw state value (boundary: any shape can arrive)
 */
export function parseNotifyTrigger(raw: unknown): NotifyTrigger {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    text = String(raw);
  } else {
    // null/undefined/objects — no usable trigger value.
    text = "";
  }
  text = text.trim().slice(0, NOTIFY_MAX_LENGTH);

  const firstWs = text.search(/\s/);
  if (firstWs < 0) {
    return { type: text, upsRef: "", text };
  }
  const type = text.slice(0, firstWs);
  let upsRef = text.slice(firstWs).trim();
  const at = upsRef.indexOf("@");
  if (at >= 0) {
    upsRef = upsRef.slice(0, at).trim();
  }
  return { type, upsRef, text };
}
