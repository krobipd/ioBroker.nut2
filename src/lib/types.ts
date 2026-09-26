/** Adapter configuration as stored in ioBroker native config. */
export interface AdapterConfig {
  /** NUT server hostname or IP */
  host: string;
  /** NUT server port */
  port: number;
  /** Local network interface for outgoing connections */
  networkInterface: string;
  /** Poll interval in seconds */
  pollInterval: number;
  /** NUT username (optional, for SET/INSTCMD) */
  username: string;
  /** NUT password (optional) */
  password: string;
  /** Use STARTTLS to encrypt the connection */
  useTls: boolean;
  /** Reject invalid/self-signed TLS certificates (default false) */
  tlsRejectUnauthorized: boolean;
  /** Path to a PEM CA certificate file on the ioBroker host — replaces the default trust store for the strict check (only with tlsRejectUnauthorized) */
  tlsCaFile: string;
  /** Per-command timeout in seconds */
  commandTimeout: number;
  /** Enable instant commands (INSTCMD) */
  enableCommands: boolean;
  /** Enable writable variables (SET VAR) */
  enableSetVar: boolean;
}

/** UPS device discovered via LIST UPS. */
export interface UpsInfo {
  /** UPS identifier */
  name: string;
  /** UPS description */
  description: string;
}

/** NUT variable from LIST VAR / LIST RW. */
export interface NutVariable {
  /** Variable name (e.g. battery.charge) */
  name: string;
  /** Raw string value */
  value: string;
}

/** NUT instant command from LIST CMD. */
export interface NutCommand {
  /** Command name (e.g. beeper.enable) */
  name: string;
}

/** NUT range constraint from LIST RANGE. */
export interface NutRange {
  /** Minimum value */
  min: string;
  /** Maximum value */
  max: string;
}

/** Logger interface for the NUT client. */
export interface NutLogger {
  /** Debug-level log */
  debug(message: string): void;
  /** Warning-level log */
  warn(message: string): void;
  /** Info-level log */
  info(message: string): void;
}

/** Options for NutClient constructor. */
export interface NutClientOptions {
  /** Local address to bind to (network interface selection) */
  localAddress?: string;
  /** Per-command timeout in milliseconds */
  commandTimeout?: number;
  /** Optional logger */
  logger?: NutLogger;
  /** Use STARTTLS to encrypt the connection (credentials otherwise travel in clear text). */
  useTls?: boolean;
  /** Reject self-signed/invalid TLS certs (default false — NUT servers are typically self-signed). */
  tlsRejectUnauthorized?: boolean;
  /** Path to a PEM CA certificate file trusted for the strict check (empty = system store only). */
  tlsCaFile?: string;
  /** Injected managed timer (adapter.setTimeout) — auto-cleared on unload. Defaults to the global timer. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  /** Injected managed clear (adapter.clearTimeout). Defaults to the global clear. */
  clearTimer?: (handle: unknown) => void;
}

/** Default NUT TCP port. */
export const NUT_DEFAULT_PORT = 3493;
/** Default per-command timeout in milliseconds. */
export const NUT_DEFAULT_COMMAND_TIMEOUT = 5000;

// Documented reference catalog of the 23 NUT protocol error codes (net-protocol.txt).
// NutError.code is typed `string` (not NutErrorCode) because a server may send codes
// outside this set; this list documents the meanings, it does not constrain the type.
export const NUT_ERRORS = [
  "ACCESS-DENIED",
  "UNKNOWN-UPS",
  "VAR-NOT-SUPPORTED",
  "CMD-NOT-SUPPORTED",
  "INVALID-ARGUMENT",
  "INSTCMD-FAILED",
  "SET-FAILED",
  "READONLY",
  "TOO-LONG",
  "FEATURE-NOT-SUPPORTED",
  "FEATURE-NOT-CONFIGURED",
  "ALREADY-SSL-MODE",
  "DRIVER-NOT-CONNECTED",
  "DATA-STALE",
  "ALREADY-LOGGED-IN",
  "INVALID-PASSWORD",
  "ALREADY-SET-PASSWORD",
  "INVALID-USERNAME",
  "ALREADY-SET-USERNAME",
  "USERNAME-REQUIRED",
  "PASSWORD-REQUIRED",
  "UNKNOWN-COMMAND",
  "INVALID-VALUE",
] as const;

/** Union type of all known NUT error codes. */
export type NutErrorCode = (typeof NUT_ERRORS)[number];
