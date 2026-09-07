import * as fs from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import { computeReconnectDelay } from "./coerce";
import type { NutClientOptions, NutCommand, NutLogger, NutRange, NutVariable, UpsInfo } from "./types";
import { NUT_DEFAULT_COMMAND_TIMEOUT } from "./types";

/** Reconnect backoff bounds (exponential: 1s, 2s, 4s … capped at 60s). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/**
 * Hard bound for a single (incomplete) response line in the receive buffer. The command timeout
 * only bounds an ACTIVE command — between commands, a broken server streaming bytes without a
 * line break would grow the buffer without limit. No legitimate NUT line comes near this.
 */
export const MAX_LINE_BYTES = 1_048_576;

/** NUT protocol error with error code (see types.ts:NUT_ERRORS for the documented set). */
export class NutError extends Error {
  /**
   * @param code NUT error code (a server may send codes outside the documented set, so this is `string`)
   * @param message Optional custom message
   */
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `NUT error: ${code}`);
    this.name = "NutError";
  }
}

/** NUT command timeout error. */
export class NutTimeoutError extends Error {
  /**
   * @param command The command that timed out
   */
  constructor(public readonly command: string) {
    super(`NUT command timed out: ${command}`);
    this.name = "NutTimeoutError";
  }
}

/**
 * The connection is not usable right now — either it was never up, or it dropped while a command
 * was in flight. This is a STATE of the persistent client, not a fault: `start()`'s retry loop is
 * already bringing the connection back, so the caller should report it like any other "server not
 * reachable" condition, not as an unexpected error.
 *
 * Its own class because the poll classifies what it catches. Before this existed, both cases
 * arrived as a bare `Error` and fell through to `classifyError`'s "UNKNOWN" bucket, which logs at
 * ERROR level — a red line in the ioBroker log every time a NUT server was restarted, while the
 * warn line written for exactly that case ("Cannot reach NUT server — will keep retrying") could
 * never be reached on this path.
 */
export class NutConnectionError extends Error {
  /**
   * @param message Why the connection is unusable
   */
  constructor(message: string) {
    super(message);
    this.name = "NutConnectionError";
  }
}

// Errors from connect()/STARTTLS that signal a TLS *configuration* problem (server offers
// no TLS, or its certificate was rejected) rather than a transient network failure.
const TLS_FATAL_ERROR_CODES = new Set<string>([
  // NUT-level: the server cannot/does not start TLS
  "FEATURE-NOT-CONFIGURED",
  "FEATURE-NOT-SUPPORTED",
  "ALREADY-SSL-MODE",
  // Adapter-level: the configured CA file is missing/unreadable or not a PEM certificate
  "TLS-CA-UNREADABLE",
  "TLS-CA-INVALID",
  // Node certificate-verification failures (only reachable with tlsRejectUnauthorized=true)
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * Whether a failed TLS connect is a configuration problem (won't fix itself → go yellow,
 * no retry) as opposed to a transient network error (ECONNREFUSED/ETIMEDOUT → retry).
 *
 * @param err Caught value from a failed connect()/STARTTLS
 */
export function isTlsConfigError(err: unknown): boolean {
  if (err instanceof NutError) {
    return TLS_FATAL_ERROR_CODES.has(err.code);
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") {
    return false;
  }
  // Explicit set above, plus the whole OpenSSL/TLS-layer code family.
  return (
    TLS_FATAL_ERROR_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("ERR_OSSL_")
  );
}

/** NUT error codes that mean "the credentials or the login sequence were refused". */
const AUTH_ERROR_CODES = new Set<string>([
  "ACCESS-DENIED",
  "INVALID-USERNAME",
  "INVALID-PASSWORD",
  "USERNAME-REQUIRED",
  "PASSWORD-REQUIRED",
  "ALREADY-SET-USERNAME",
  "ALREADY-SET-PASSWORD",
]);

/**
 * Human-readable cause for a refused login, or null when the error is not about credentials.
 * upsd answers ACCESS-DENIED both for a wrong password and for a user without LOGIN rights
 * (server/user.c: password mismatch and missing `upsmon` action return the same failure), so
 * the text names both — the adapter cannot tell them apart from the wire.
 *
 * @param err Caught value from authenticate()/login()
 */
export function authFailureText(err: unknown): string | null {
  if (!(err instanceof NutError) || !AUTH_ERROR_CODES.has(err.code)) {
    return null;
  }
  if (err.code === "ACCESS-DENIED") {
    return "the NUT server rejected the login (ACCESS-DENIED): wrong password, or the user has no `upsmon secondary`/`upsmon primary` line in upsd.users";
  }
  return `the NUT server rejected the credentials (${err.code})`;
}

interface QueueEntry {
  command: string;
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer: unknown;
  multiLine: boolean;
}

/** Persistent TCP client for the NUT protocol (port 3493), with optional STARTTLS. */
export class NutClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private queue: QueueEntry[] = [];
  private active: QueueEntry | null = null;
  private multiLineBuffer: string[] = [];
  private multiLineExpectedEnd = "";
  private connected = false;
  /**
   * True once connect() resolved (TCP up AND, with TLS, the handshake done). `connected` alone
   * turns true at the TCP level so STARTTLS can be sent; a drop between the two is a failed
   * connect attempt, not a lost connection — the retry loop handles it through connect()'s
   * rejection, the close handler must not schedule a second reconnect or warn "lost".
   */
  private ready = false;
  private destroyed = false;
  private tlsActive = false;

  private readonly host: string;
  private readonly port: number;
  private readonly localAddress?: string;
  private readonly commandTimeout: number;
  private readonly useTls: boolean;
  private readonly tlsRejectUnauthorized: boolean;
  private readonly tlsCaFile?: string;
  private readonly log?: NutLogger;
  // Injected managed timers (adapter.setTimeout/clearTimeout in production → auto-cleared on
  // unload; global timers as fallback for standalone use/tests).
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  // Persistent mode (set by start()) owns the unified retry loop: it retries the initial
  // connect, reconnects on drops, and stops yellow on a fatal TLS-config error. A plain
  // connect() (e.g. the connection test) leaves this false — one-shot, never retries.
  private persistent = false;
  private onConnectHandler: (() => void) | null = null;
  private onFatalHandler: ((err: unknown) => void) | null = null;

  /**
   * @param host NUT server hostname or IP
   * @param port NUT server port
   * @param options Connection options
   */
  constructor(host: string, port: number, options?: NutClientOptions) {
    this.host = host;
    this.port = port;
    this.localAddress = options?.localAddress;
    this.commandTimeout = options?.commandTimeout ?? NUT_DEFAULT_COMMAND_TIMEOUT;
    this.useTls = options?.useTls ?? false;
    this.tlsRejectUnauthorized = options?.tlsRejectUnauthorized ?? false;
    this.tlsCaFile = options?.tlsCaFile?.trim() || undefined;
    this.log = options?.logger;
    this.setTimer = options?.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimer = options?.clearTimer ?? (h => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Register a callback invoked after every successful (re)connection in persistent mode.
   * Runs the post-connect setup (discover/auth/poll); must be idempotent.
   *
   * @param handler Connect callback
   */
  setOnConnect(handler: () => void): void {
    this.onConnectHandler = handler;
  }

  /**
   * Register a callback invoked when the persistent connection fails fatally (TLS
   * misconfiguration) — the retry loop stops and the caller should go yellow.
   *
   * @param handler Fatal-error callback
   */
  setOnFatal(handler: (err: unknown) => void): void {
    this.onFatalHandler = handler;
  }

  /**
   * Start the persistent runtime connection: connect now and keep retrying with exponential
   * backoff, reconnecting automatically on later drops. A fatal TLS-config error stops the
   * loop (onFatal). Use connect() directly for a one-shot (e.g. the connection test).
   */
  start(): void {
    this.persistent = true;
    this.reconnectAttempt = 0;
    this.attemptConnect();
  }

  /** One iteration of the persistent loop: connect, then fire onConnect or handle the failure. */
  private attemptConnect(): void {
    // Shortcut, deliberately without its own test: connect() rejects on a
    // destroyed client and handleConnectFailure bails on it too, so removing
    // this check changes nothing observable (equivalent mutant, 2026-08-22 test
    // audit). It stays because it keeps a torn-down client from even entering
    // the loop.
    if (this.destroyed) {
      return;
    }
    this.connect()
      .then(() => {
        this.reconnectAttempt = 0;
        this.onConnectHandler?.();
      })
      .catch((err: unknown) => this.handleConnectFailure(err));
  }

  /**
   * Decide a failed persistent connect: a TLS-config error stops the loop (onFatal, yellow);
   * any other error schedules a backed-off retry.
   *
   * @param err The connect/STARTTLS failure
   */
  private handleConnectFailure(err: unknown): void {
    if (this.destroyed) {
      return;
    }
    // Tear down the failed socket so the next attempt starts clean. Clearing `connected`
    // first means the close handler sees wasConnected=false and won't double-schedule.
    this.connected = false;
    this.ready = false;
    const sock = this.socket;
    this.socket = null;
    sock?.destroy();

    const msg = err instanceof Error ? err.message : String(err);
    if (this.useTls && isTlsConfigError(err)) {
      // The adapter reports this at error level through onFatal — one line for the user, not two.
      this.log?.debug(`TLS connection to NUT server ${this.host}:${this.port} failed — not retrying: ${msg}`);
      this.onFatalHandler?.(err);
      return;
    }
    this.log?.debug(`Connect attempt failed: ${msg}`);
    this.scheduleReconnect();
  }

  /** Establish TCP connection (and STARTTLS upgrade if configured) to the NUT server. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.destroyed) {
        reject(new NutConnectionError("Client has been destroyed"));
        return;
      }

      // Bound the connect phase (TCP connect + optional STARTTLS handshake). net/tls have no
      // built-in deadline here, and the per-command timeout only applies once connected, so a
      // blackholed SYN or a stalled TLS handshake would otherwise hang for the OS timeout
      // (~1-2 min) — freezing reconnect attempts and the admin connection test.
      let settled = false;
      const deadline = this.setTimer(() => {
        if (settled) {
          return;
        }
        settled = true;
        const sock = this.socket;
        this.socket = null;
        this.connected = false;
        this.ready = false;
        sock?.destroy();
        reject(new NutConnectionError(`Connect to NUT server ${this.host}:${this.port} timed out`));
      }, this.commandTimeout);
      const settle = (err?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimer(deadline);
        if (err) {
          reject(err);
        } else {
          this.ready = true;
          resolve();
        }
      };

      const opts: net.NetConnectOpts = { host: this.host, port: this.port };
      if (this.localAddress) {
        opts.localAddress = this.localAddress;
      }

      const socket = net.createConnection(opts, () => {
        this.connected = true;
        this.tlsActive = false;
        this.buffer = "";
        this.log?.debug(`Connected to NUT server ${this.host}:${this.port}`);
        if (this.useTls) {
          this.startTls()
            .then(() => settle())
            .catch(settle);
        } else {
          settle();
        }
      });
      this.socket = socket;
      // Detect a dead peer (NAT/firewall idle-drop leaves a half-open socket otherwise).
      socket.setKeepAlive(true, 30000);
      this.wireSocket(socket, settle);
    });
  }

  /**
   * Attach data/error/close handlers to the current socket.
   *
   * @param socket The socket (plaintext or TLS) to wire up
   * @param rejectConnect Optional connect() rejector, called if the socket errors before connecting
   */
  private wireSocket(socket: net.Socket | tls.TLSSocket, rejectConnect?: (err: Error) => void): void {
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => this.onData(data));
    socket.on("error", (err: Error) => {
      this.log?.debug(`Socket error: ${err.message}`);
      if (!this.connected && rejectConnect) {
        rejectConnect(err);
      }
    });
    socket.on("close", () => {
      const wasReady = this.ready;
      this.ready = false;
      this.connected = false;
      // Drain the WHOLE queue, not just the active command: a queued entry left behind would keep
      // a live command timer that fires later and tears down a subsequently-reconnected socket.
      this.rejectAll(new NutConnectionError("Connection closed"));
      // Only the persistent runtime connection auto-reconnects on a drop; a one-shot
      // connect() (e.g. the connection test) must not.
      if (wasReady && !this.destroyed && this.persistent) {
        this.log?.warn(`Connection to NUT server ${this.host}:${this.port} lost`);
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Read the configured CA file (strict certificate check against a private CA). Both failure
   * modes are configuration errors — fatal, not retried — and are checked BEFORE the server is
   * asked for STARTTLS, so a bad path never opens a half-upgraded connection.
   *
   * The file is only read when the strict check is actually on: `tls.connect` ignores `ca`
   * entirely with `rejectUnauthorized: false`, so reading it then turned a stale path into a
   * FATAL error on a connection that never needed the file. The admin only HIDES the field when
   * the strict check is off (`"hidden": "!data.useTls || !data.tlsRejectUnauthorized"`) — hiding
   * does not clear the stored value, so the path outlives the setting that gave it a purpose.
   * Skipping it silently would be the next trap (the value is then dead until someone re-enables
   * the check and the fatal error returns without warning), hence the debug line.
   *
   * @returns the PEM certificate(s) to trust, or undefined when no CA file is configured or used
   */
  private loadTlsCa(): string[] | undefined {
    if (!this.tlsCaFile) {
      return undefined;
    }
    if (!this.tlsRejectUnauthorized) {
      this.log?.debug(
        `TLS CA file ${this.tlsCaFile} is configured but not used — "Require valid certificate" is off, so no certificate is verified`,
      );
      return undefined;
    }
    let pem: string;
    try {
      pem = fs.readFileSync(this.tlsCaFile, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NutError("TLS-CA-UNREADABLE", `TLS CA file ${this.tlsCaFile} cannot be read: ${msg}`);
    }
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      throw new NutError("TLS-CA-INVALID", `TLS CA file ${this.tlsCaFile} is not a PEM certificate`);
    }
    return [pem];
  }

  /** Upgrade the plaintext socket to TLS via STARTTLS. */
  private async startTls(): Promise<void> {
    const plain = this.socket as net.Socket;
    const ca = this.loadTlsCa();
    await this.sendOk("STARTTLS"); // throws NutError on FEATURE-NOT-CONFIGURED/-SUPPORTED
    // After "OK STARTTLS" the server begins TLS immediately — nothing plaintext may follow.
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.buffer = "";

    // SNI must be a hostname — RFC 6066 forbids an IP literal (Node warns + ignores it).
    const servername = net.isIP(this.host) === 0 ? this.host : undefined;
    await new Promise<void>((resolve, reject) => {
      const tlsSocket = tls.connect(
        { socket: plain, rejectUnauthorized: this.tlsRejectUnauthorized, servername, ca },
        () => {
          this.tlsActive = true;
          this.log?.debug(`STARTTLS established with ${this.host}:${this.port}`);
          resolve();
        },
      );
      tlsSocket.once("error", (err: Error) => reject(err));
      this.socket = tlsSocket;
      this.wireSocket(tlsSocket);
    });
  }

  /** Synchronous teardown — destroys socket, no LOGOUT sent. */
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cancelAll();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.ready = false;
  }

  /**
   * Synchronous graceful teardown for onUnload — sends a best-effort LOGOUT and half-closes
   * so the write flushes (vs. destroy()'s hard reset). Any server reply is ignored.
   */
  shutdown(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cancelAll();
    const sock = this.socket;
    this.socket = null;
    this.connected = false;
    this.ready = false;
    if (sock) {
      try {
        sock.end("LOGOUT\n");
      } catch {
        sock.destroy();
      }
    }
  }

  /** Reject all pending and queued commands. */
  cancelAll(): void {
    this.rejectAll(new NutConnectionError("Client cancelled"));
  }

  /**
   * Reject the active command AND every queued command (clearing their timers), then reset the
   * multi-line parse state. Used by cancelAll (destroy/resync) and by the socket-close handler —
   * a queued entry left behind with a live timer would fire later and tear down a
   * subsequently-reconnected socket.
   *
   * @param err Rejection reason handed to every pending command
   */
  private rejectAll(err: Error): void {
    if (this.active) {
      this.clearTimer(this.active.timer);
      this.active.reject(err);
      this.active = null;
    }
    for (const entry of this.queue) {
      this.clearTimer(entry.timer);
      entry.reject(err);
    }
    this.queue = [];
    this.multiLineBuffer = [];
    this.multiLineExpectedEnd = "";
  }

  /** Whether the TCP connection is currently established. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Whether the connection is TLS-encrypted. */
  get isTls(): boolean {
    return this.tlsActive;
  }

  /** Discover all UPS devices on the NUT server. */
  listUps(): Promise<UpsInfo[]> {
    return this.parseList("LIST UPS", /^UPS\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/, m => ({
      name: m[1],
      description: unescapeNut(m[2]),
    }));
  }

  /**
   * List all variables for a UPS.
   *
   * @param ups UPS name
   */
  listVar(ups: string): Promise<NutVariable[]> {
    const bad = tokenError(ups, "UPS name");
    if (bad) {
      return Promise.reject(bad);
    }
    return this.parseList(`LIST VAR ${ups}`, /^VAR\s+\S+\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/, m => ({
      name: m[1],
      value: unescapeNut(m[2]),
    }));
  }

  /**
   * List writable variables for a UPS.
   *
   * @param ups UPS name
   */
  listRw(ups: string): Promise<NutVariable[]> {
    const bad = tokenError(ups, "UPS name");
    if (bad) {
      return Promise.reject(bad);
    }
    return this.parseList(`LIST RW ${ups}`, /^RW\s+\S+\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/, m => ({
      name: m[1],
      value: unescapeNut(m[2]),
    }));
  }

  /**
   * List available instant commands for a UPS.
   *
   * @param ups UPS name
   */
  listCmd(ups: string): Promise<NutCommand[]> {
    const bad = tokenError(ups, "UPS name");
    if (bad) {
      return Promise.reject(bad);
    }
    return this.parseList(`LIST CMD ${ups}`, /^CMD\s+\S+\s+(\S+)/, m => ({ name: m[1] }));
  }

  /**
   * List enum values for a variable.
   *
   * @param ups UPS name
   * @param varName Variable name
   */
  listEnum(ups: string, varName: string): Promise<string[]> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(varName, "variable name");
    if (bad) {
      return Promise.reject(bad);
    }
    return this.parseList(`LIST ENUM ${ups} ${varName}`, /^ENUM\s+\S+\s+\S+\s+"((?:[^"\\]|\\.)*)"/, m =>
      unescapeNut(m[1]),
    );
  }

  /**
   * List range constraints for a variable.
   *
   * @param ups UPS name
   * @param varName Variable name
   */
  listRange(ups: string, varName: string): Promise<NutRange[]> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(varName, "variable name");
    if (bad) {
      return Promise.reject(bad);
    }
    return this.parseList(
      `LIST RANGE ${ups} ${varName}`,
      /^RANGE\s+\S+\s+\S+\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/,
      m => ({ min: unescapeNut(m[1]), max: unescapeNut(m[2]) }),
    );
  }

  /**
   * Generic LIST/multi-line parser — runs a regex per response line and maps matches.
   *
   * @param command The LIST command to send
   * @param lineRegex Regex applied to each response line
   * @param map Maps a matched line to a result item
   */
  private async parseList<T>(command: string, lineRegex: RegExp, map: (m: RegExpExecArray) => T): Promise<T[]> {
    const lines = await this.sendCommand(command, true);
    const result: T[] = [];
    for (const line of lines) {
      const match = lineRegex.exec(line);
      if (match) {
        result.push(map(match));
      }
    }
    return result;
  }

  /**
   * Set a writable variable.
   *
   * @param ups UPS name
   * @param varName Variable name
   * @param value New value
   */
  async setVar(ups: string, varName: string, value: string): Promise<void> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(varName, "variable name");
    if (bad) {
      throw bad;
    }
    await this.sendOk(`SET VAR ${ups} ${varName} "${escapeNut(value)}"`);
  }

  /**
   * Execute an instant command.
   *
   * @param ups UPS name
   * @param cmd Command name
   */
  async instCmd(ups: string, cmd: string): Promise<void> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(cmd, "command name");
    if (bad) {
      throw bad;
    }
    await this.sendOk(`INSTCMD ${ups} ${cmd}`);
  }

  /**
   * Authenticate with the NUT server.
   *
   * @param username NUT username
   * @param password NUT password
   */
  async authenticate(username: string, password: string): Promise<void> {
    // The protocol token guard covers every other unquoted wire argument; these two used to slip
    // past it, and the failure was unreadable. `USERNAME`/`PASSWORD` take exactly one argument
    // (`numarg != 1` → ERR INVALID-ARGUMENT, server/netuser.c:147 and :167 of NUT 2.8.5), so a
    // space turns one argument into two and upsd answers with a bare INVALID-ARGUMENT that names
    // nothing. Refuse it here and say what is wrong instead.
    //
    // Not quoted on the wire on purpose: NUT's own clients all send these unquoted
    // (clients/upsmon.c:571/585, upscmd.c:504/522, upsrw.c:286/301, upsset.c:528/550), so a
    // credential with a space is a NUT-wide limitation, not something this adapter may paper over
    // with a behaviour no official client has.
    const bad = credentialError(username, "username") ?? credentialError(password, "password");
    if (bad) {
      throw bad;
    }
    // upsd only STORES these two (server/netuser.c) — nothing is verified until login().
    await this.sendOk(`USERNAME ${username}`);
    await this.sendOk(`PASSWORD ${password}`);
  }

  /**
   * Register as monitoring client for a UPS.
   *
   * @param ups UPS name
   */
  async login(ups: string): Promise<void> {
    const bad = tokenError(ups, "UPS name");
    if (bad) {
      throw bad;
    }
    await this.sendOk(`LOGIN ${ups}`);
  }

  /** Best-effort LOGOUT (graceful lifecycle; ignores errors). */
  async logout(): Promise<void> {
    try {
      await this.sendOk("LOGOUT");
    } catch {
      // Ignore — we are shutting down anyway.
    }
  }

  /**
   * Send a command whose only valid answer is `OK` — plain, or with a trailer such as
   * `OK STARTTLS` / `OK TRACKING <id>`. Anything else that is not an `ERR` line used to count as
   * success; now it is a protocol error, so a stray or desynced answer can never confirm a
   * login, a write or a TLS upgrade that did not happen.
   *
   * @param command The protocol line to send
   */
  private async sendOk(command: string): Promise<void> {
    const [line] = await this.sendCommand(command, false);
    if (!/^OK(\s|$)/.test(line)) {
      throw new NutError("UNEXPECTED-RESPONSE", `Unexpected answer to ${redactForLog(command)}: ${line}`);
    }
  }

  private sendCommand(command: string, multiLine: boolean): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      // A NUT command is exactly one protocol line — guard the wire against a stray line break in
      // any argument. SET VAR values are already safe on their own: they go out quoted and
      // escapeNut turns every " into \", so the quote cannot be closed, and upsd keeps a newline
      // inside quotes literal (verified against the bundled parseconf.c `quotecollect`). The one
      // UNquoted path is USERNAME/PASSWORD — a line break there (a pasted credential with a
      // trailing newline) would otherwise split into a bogus second command line and desync auth.
      // Reject before anything reaches the wire; no real NUT argument contains a line break.
      if (/[\r\n]/.test(command)) {
        reject(new Error("NUT command must not contain line breaks"));
        return;
      }
      if (!this.connected || !this.socket) {
        reject(new NutConnectionError("Not connected"));
        return;
      }

      // The command timeout is armed when the command becomes ACTIVE (processQueue), not here:
      // otherwise the time a command waits in the queue behind a slower one eats into its budget,
      // and a queued command can spuriously time out — dropping an otherwise-healthy connection.
      const entry: QueueEntry = { command, resolve, reject, timer: null, multiLine };
      this.queue.push(entry);

      if (!this.active) {
        this.processQueue();
      }
    });
  }

  /**
   * Drop the desynced connection and reconnect on a clean stream (resync).
   *
   * @param command The command that timed out
   */
  private resyncAfterTimeout(command: string): void {
    // Only the active command carries a live timer (armed in processQueue), so a fired timeout
    // always refers to the active command — already rejected in its timer callback. Null it so
    // the cancelAll() below doesn't reject it a second time.
    if (this.active?.command === command) {
      this.active = null;
    }
    // Drop the socket — reflect it synchronously so callers see the desync immediately and the
    // async 'close' handler sees wasConnected=false (no double-schedule). cancelAll() drains the
    // rest of the queue; scheduleReconnect() brings the connection back on a clean stream.
    this.connected = false;
    this.ready = false;
    this.cancelAll();
    this.socket?.destroy();
    this.scheduleReconnect();
  }

  private processQueue(): void {
    if (this.active || this.queue.length === 0) {
      return;
    }

    const entry = this.queue.shift()!;
    this.active = entry;

    // Arm the command timeout now that the command is active (see sendCommand): the full budget
    // applies to active time only, never to queue-wait. A fired timer therefore always refers to
    // the active command.
    entry.timer = this.setTimer(() => {
      entry.reject(new NutTimeoutError(entry.command));
      // A timed-out command desyncs the stream (NUT has no request IDs — a late reply would be
      // mis-attributed to the next command). Drop the connection and reconnect to resync.
      this.resyncAfterTimeout(entry.command);
    }, this.commandTimeout);

    this.log?.debug(`>> ${redactForLog(entry.command)}`);

    if (entry.multiLine) {
      this.multiLineBuffer = [];
      const query = entry.command.replace(/^LIST\s+/, "");
      this.multiLineExpectedEnd = `END LIST ${query}`;
    }

    this.socket?.write(`${entry.command}\n`);
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      // NUT uses LF; tolerate CRLF from non-conformant servers.
      this.processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }

    // The remainder is one incomplete line. Past the cap it can only be a broken (or hostile)
    // stream — treat it like a timeout desync: drop the connection so the buffer cannot grow
    // without bound; the persistent loop reconnects on a clean stream.
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.log?.warn(`NUT response line exceeded ${MAX_LINE_BYTES} bytes — dropping the connection`);
      this.buffer = "";
      this.connected = false;
      this.ready = false;
      this.rejectAll(new Error("NUT response line exceeded the size limit"));
      this.socket?.destroy();
      this.scheduleReconnect();
    }
  }

  private processLine(line: string): void {
    if (!this.active) {
      this.log?.debug(`<< (no active command) ${line}`);
      return;
    }

    if (line.startsWith("ERR ")) {
      const code = line.slice(4).trim();
      this.clearTimer(this.active.timer);
      const entry = this.active;
      this.active = null;
      this.multiLineBuffer = [];
      this.multiLineExpectedEnd = "";
      entry.reject(new NutError(code));
      this.processQueue();
      return;
    }

    if (this.active.multiLine) {
      if (line.startsWith("BEGIN LIST ")) {
        return;
      }
      if (line === this.multiLineExpectedEnd) {
        this.clearTimer(this.active.timer);
        const entry = this.active;
        const result = [...this.multiLineBuffer];
        this.active = null;
        this.multiLineBuffer = [];
        this.multiLineExpectedEnd = "";
        entry.resolve(result);
        this.processQueue();
        return;
      }
      this.multiLineBuffer.push(line);
      return;
    }

    // Single-line response
    this.clearTimer(this.active.timer);
    const entry = this.active;
    this.active = null;
    entry.resolve([line]);
    this.processQueue();
  }

  private scheduleReconnect(): void {
    // Only the persistent runtime loop reconnects; guard against double-scheduling.
    if (this.destroyed || this.reconnectTimer || !this.persistent) {
      return;
    }

    this.reconnectAttempt += 1;
    const delay = computeReconnectDelay(this.reconnectAttempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
    this.log?.debug(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.log?.debug(`Attempting reconnect to ${this.host}:${this.port}`);
      this.attemptConnect();
    }, delay);
  }
}

/**
 * NUT command arguments are whitespace-separated, unquoted tokens (only the SET VAR value is
 * quoted). A name carrying a space, a quote or a backslash would re-split or re-quote the line
 * on the server. Variable and command names come from the object tree, where a user can create
 * states by hand — refuse anything that is not one clean token before it reaches the wire.
 *
 * @param value The argument about to be placed on the command line
 * @param what What it is, for the error message
 * @returns the error to reject with, or null when the token is clean
 */
function tokenError(value: string, what: string): Error | null {
  if (value.length === 0 || /[\s"\\]/.test(value)) {
    return new Error(`Invalid NUT ${what}: ${JSON.stringify(value)}`);
  }
  return null;
}

/**
 * Same wire rule as {@link tokenError}, for the two credential arguments — but the message never
 * shows the value. Username and password are `protectedNative`/`encryptedNative`; an error text
 * ends up in the log and in the admin's connection-test answer, so it says WHAT is wrong, not what
 * was entered.
 *
 * @param value The credential about to be placed on the command line
 * @param what "username" or "password", for the message
 * @returns the error to throw with, or null when the credential can go on the wire
 */
function credentialError(value: string, what: string): Error | null {
  if (value.length === 0) {
    return new Error(`The NUT ${what} is empty`);
  }
  if (/\s/.test(value)) {
    return new Error(
      `The NUT ${what} contains a space (or tab) — the NUT protocol cannot carry one: upsd reads the rest as a second argument and answers ERR INVALID-ARGUMENT. Choose a ${what} without whitespace in upsd.users.`,
    );
  }
  if (/["\\]/.test(value)) {
    return new Error(
      `The NUT ${what} contains a quote or a backslash — the NUT protocol cannot carry those unquoted; the server would read a different value than you entered. Choose a ${what} without " and \\ in upsd.users.`,
    );
  }
  return null;
}

function unescapeNut(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function escapeNut(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Redact NUT credential commands before they are logged. USERNAME/PASSWORD carry values declared
 * protected/encrypted in io-package.json — they must never reach the log file, even at debug level.
 * The wire write still uses the unredacted command; only the log line is masked.
 *
 * @param command The raw NUT command about to be sent
 */
function redactForLog(command: string): string {
  if (command.startsWith("PASSWORD ")) {
    return "PASSWORD ***";
  }
  if (command.startsWith("USERNAME ")) {
    return "USERNAME ***";
  }
  return command;
}
