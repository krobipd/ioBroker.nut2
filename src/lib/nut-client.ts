import * as fs from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import { computeReconnectDelay, errText } from "./coerce";
import type { NutClientOptions, NutCommand, NutLogger, NutRange, NutVariable, UpsInfo } from "./types";
import { NUT_DEFAULT_COMMAND_TIMEOUT } from "./types";

/** Reconnect backoff bounds (exponential: 1s, 2s, 4s … capped at 60s). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/**
 * upsd drops every client that has not sent a line for 60 seconds (server/upsd.c:1647 of NUT
 * 2.8.5, "shed clients after 1 minute of inactivity"; only a received command refreshes the
 * timestamp, :945 — TCP keepalive does not count). Poll intervals up to 300 s are allowed, so the
 * persistent connection sends a cheap `VER` after this much silence.
 */
export const KEEPALIVE_IDLE_MS = 30000;

/**
 * Hard bound for a single (incomplete) response line in the receive buffer, in bytes. The command
 * timeout only bounds an ACTIVE command — between commands, a broken server streaming bytes
 * without a line break would grow the buffer without limit. No legitimate NUT line comes near this.
 */
export const MAX_LINE_BYTES = 1_048_576;

/**
 * Hard bound for the complete answer to one multi-line command, in bytes. A server that streams
 * valid lines without ever sending `END LIST` would otherwise grow the list buffer until the
 * command timeout fires. The largest real dump in the NUT device-dump library (an Eaton ePDU with
 * 581 variables) is below 40 KB.
 */
export const MAX_RESPONSE_BYTES = 4 * 1_048_576;

/** NUT protocol error with error code (see types.ts:NUT_ERRORS for the documented set). */
export class NutError extends Error {
  /**
   * @param code NUT error code (a server may send codes outside the documented set, so this is `string`)
   * @param message Optional custom message
   * @param detail Extra text the server appended after the code (`ERR <code> [<extra>...]`)
   */
  constructor(
    public readonly code: string,
    message?: string,
    public readonly detail?: string,
  ) {
    super(message ?? (detail ? `NUT error: ${code} (${detail})` : `NUT error: ${code}`));
    this.name = "NutError";
  }
}

/**
 * An argument the adapter was asked to put on the wire cannot be sent as it is — a name, a
 * command parameter, a credential or a value the NUT protocol cannot carry. Nothing reached the
 * server. Its own class so the caller reports it as the input problem it is, not as a connection
 * failure or an unexpected error.
 */
export class NutInputError extends Error {
  /** Stable code, like the protocol errors. */
  public readonly code = "INVALID-INPUT";

  /**
   * @param message What is wrong with the input
   */
  constructor(message: string) {
    super(message);
    this.name = "NutInputError";
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
 * line written for exactly that case ("Cannot reach NUT server — will keep retrying", a debug
 * line since design #70) could never be reached on this path.
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
  // NUT-level: the server cannot/does not start TLS. UNKNOWN-COMMAND is what a server answers
  // that does not know STARTTLS at all (net-protocol.txt, "Error responses") — retrying cannot
  // change that. The set is only consulted for a failed connect, where STARTTLS is the only
  // command sent.
  "FEATURE-NOT-CONFIGURED",
  "FEATURE-NOT-SUPPORTED",
  "ALREADY-SSL-MODE",
  "UNKNOWN-COMMAND",
  // Adapter-level: the configured CA file is missing/unreadable or not a PEM certificate
  "TLS-CA-UNREADABLE",
  "TLS-CA-INVALID",
  // Node certificate-verification failures (only reachable with tlsRejectUnauthorized=true).
  // Node reports the OpenSSL X509 verification result by name (X509ErrorCode); every one of them
  // is a certificate the configuration does not trust, none of them heals on a retry.
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
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
  private multiLineBytes = 0;
  /** Tokens of the `END LIST …` line that closes the active multi-line answer. */
  private multiLineExpectedEnd: string[] = [];
  private keepAliveTimer: unknown = null;
  private connected = false;
  /**
   * True once connect() resolved (TCP up AND, with TLS, the handshake done). `connected` alone
   * turns true at the TCP level so STARTTLS can be sent; a drop between the two is a failed
   * connect attempt, not a lost connection — the retry loop handles it through connect()'s
   * rejection, the close handler must not schedule a second reconnect or report the connection as lost.
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
  private onDisconnectHandler: (() => void) | null = null;

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
   * Register a callback invoked the moment an established persistent connection drops — before
   * the reconnect is scheduled, so the caller can mark its state unreachable right away instead
   * of at the end of the next poll interval.
   *
   * @param handler Disconnect callback
   */
  setOnDisconnect(handler: () => void): void {
    this.onDisconnectHandler = handler;
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
    // The backoff is NOT reset here: a server that accepts the TCP connection and drops it right
    // away (a Docker port proxy in front of a upsd that is not listening, a crashing upsd under
    // systemd) would otherwise be retried every second forever. It resets once the server has
    // answered a command (see listUps), which is what "the connection works" means.
    this.connect()
      .then(() => {
        this.armKeepAlive();
        this.onConnectHandler?.();
      })
      .catch((err: unknown) => this.handleConnectFailure(err));
  }

  /**
   * (Re)arm the idle timer of the persistent connection: after {@link KEEPALIVE_IDLE_MS} without a
   * command, send `VER` so upsd does not drop the client (server/upsd.c:1647). Any answer — also
   * an `ERR` from a server that does not know `VER` — refreshes upsd's timestamp and is ignored.
   */
  private armKeepAlive(): void {
    this.stopKeepAlive();
    if (!this.persistent || !this.ready || this.destroyed) {
      return;
    }
    this.keepAliveTimer = this.setTimer(() => {
      this.keepAliveTimer = null;
      if (!this.ready || this.active || this.queue.length > 0) {
        this.armKeepAlive();
        return;
      }
      this.sendCommand("VER", false).catch((err: unknown) => {
        this.log?.debug(`Keepalive VER: ${errText(err)}`);
      });
    }, KEEPALIVE_IDLE_MS);
  }

  /** Stop the idle timer (connection gone or client torn down). */
  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      this.clearTimer(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
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

    const msg = errText(err);
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
      this.log?.debug(`Socket error: ${errText(err)}`);
      if (!this.connected && rejectConnect) {
        rejectConnect(err);
      }
    });
    socket.on("close", () => {
      const wasReady = this.ready;
      this.ready = false;
      this.connected = false;
      this.stopKeepAlive();
      // Drain the WHOLE queue, not just the active command: a queued entry left behind would keep
      // a live command timer that fires later and tears down a subsequently-reconnected socket.
      this.rejectAll(new NutConnectionError("Connection closed"));
      // Only the persistent runtime connection auto-reconnects on a drop; a one-shot
      // connect() (e.g. the connection test) must not.
      if (wasReady && !this.destroyed && this.persistent) {
        // A lost connection is a state (info.connection, info.reachable carry it), not a log event.
        this.log?.debug(`Connection to NUT server ${this.host}:${this.port} lost`);
        this.onDisconnectHandler?.();
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
      const msg = errText(err);
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
    // The one command allowed before the connection is ready. Every other command is refused
    // until then (sendCommand), so nothing can be queued behind STARTTLS and written in plaintext
    // the moment "OK STARTTLS" arrives — that would reach the server in place of the TLS
    // ClientHello, break the handshake and, with an ERR_SSL_* code, stop the client for good.
    await this.sendOk("STARTTLS", true); // throws NutError on FEATURE-NOT-CONFIGURED/-SUPPORTED
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
    this.stopKeepAlive();
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
    this.stopKeepAlive();
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
    this.multiLineBytes = 0;
    this.multiLineExpectedEnd = [];
  }

  /**
   * Whether the connection is usable: TCP up and, with TLS, the handshake done. A socket that is
   * connected but still negotiating STARTTLS is not usable yet — commands are refused until then.
   */
  get isConnected(): boolean {
    return this.ready;
  }

  /** Whether the connection is TLS-encrypted. */
  get isTls(): boolean {
    return this.tlsActive;
  }

  /**
   * Discover all UPS devices on the NUT server.
   *
   * The description is optional in the parser: upsd itself always quotes one (server/netlist.c —
   * the configured `desc`, or literally "Description unavailable"), but the other servers that
   * speak this protocol may send a bare `UPS <name>`, and a line the parser drops takes the whole
   * UPS with it.
   *
   * An answer to LIST UPS is also the adapter's proof that the connection works: it resets the
   * reconnect backoff (see attemptConnect).
   */
  async listUps(): Promise<UpsInfo[]> {
    const ups = await this.parseList("LIST UPS", "UPS", 2, t => ({ name: t[1], description: t[2] ?? "" }));
    this.reconnectAttempt = 0;
    return ups;
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
    return this.parseList(`LIST VAR ${ups}`, "VAR", 4, t => ({ name: t[2], value: t[3] }));
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
    return this.parseList(`LIST RW ${ups}`, "RW", 4, t => ({ name: t[2], value: t[3] }));
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
    return this.parseList(`LIST CMD ${ups}`, "CMD", 3, t => ({ name: t[2] }));
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
    return this.parseList(`LIST ENUM ${ups} ${varName}`, "ENUM", 4, t => t[3]);
  }

  /**
   * List range constraints for a variable. A variable can carry several disjoint ranges
   * (net-protocol.txt, LIST RANGE: `"90" "100"` and `"102" "105"`).
   *
   * @param ups UPS name
   * @param varName Variable name
   */
  listRange(ups: string, varName: string): Promise<NutRange[]> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(varName, "variable name");
    if (bad) {
      return Promise.reject(bad);
    }
    return this.parseList(`LIST RANGE ${ups} ${varName}`, "RANGE", 5, t => ({ min: t[3], max: t[4] }));
  }

  /**
   * Generic LIST parser. Every answer line is split into tokens the way upsd itself parses a line
   * (common/parseconf.c: whitespace separates, double quotes group, a backslash takes the next
   * character literally), so a line reads the same whether a server quotes a name or not — upsd
   * quotes only values and descriptions, the UniFi UPS firmware quotes every name
   * (`VAR "myups" "battery.charge" 100`, home-assistant/core#154469).
   *
   * @param command The LIST command to send
   * @param keyword First token of every answer line (UPS, VAR, RW, CMD, ENUM, RANGE)
   * @param minTokens Tokens a line needs to be usable (the description of UPS is optional)
   * @param map Maps the tokens of a matched line to a result item
   */
  private async parseList<T>(
    command: string,
    keyword: string,
    minTokens: number,
    map: (tokens: string[]) => T,
  ): Promise<T[]> {
    const lines = await this.sendCommand(command, true);
    const result: T[] = [];
    for (const line of lines) {
      const tokens = splitNutLine(line);
      if (tokens[0] === keyword && tokens.length >= minTokens) {
        result.push(map(tokens));
      }
    }
    return result;
  }

  /**
   * Read one variable (`GET VAR`).
   *
   * @param ups UPS name
   * @param varName Variable name
   */
  async getVar(ups: string, varName: string): Promise<string> {
    return this.getQuoted("VAR", ups, varName, "variable name");
  }

  /**
   * The server's own description of a variable (`GET DESC`, from its cmdvartab).
   *
   * @param ups UPS name
   * @param varName Variable name
   */
  async getDesc(ups: string, varName: string): Promise<string> {
    return this.getQuoted("DESC", ups, varName, "variable name");
  }

  /**
   * The server's own description of an instant command (`GET CMDDESC`, from its cmdvartab).
   *
   * @param ups UPS name
   * @param cmd Command name
   */
  async getCmdDesc(ups: string, cmd: string): Promise<string> {
    return this.getQuoted("CMDDESC", ups, cmd, "command name");
  }

  /**
   * `GET <what> <ups> <name>` → `<what> <ups> <name> "<text>"`.
   *
   * @param what VAR, DESC or CMDDESC
   * @param ups UPS name
   * @param name Variable or command name
   * @param kind What the name is, for the input error
   */
  private async getQuoted(what: string, ups: string, name: string, kind: string): Promise<string> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(name, kind);
    if (bad) {
      throw bad;
    }
    const [line] = await this.sendCommand(`GET ${what} ${ups} ${name}`, false);
    const tokens = splitNutLine(line);
    if (tokens[0] !== what || tokens.length < 4) {
      throw new NutError("UNEXPECTED-RESPONSE", `Unexpected answer to GET ${what} ${ups} ${name}: ${line}`);
    }
    return tokens[3];
  }

  /**
   * Set a writable variable.
   *
   * @param ups UPS name
   * @param varName Variable name
   * @param value New value
   * @returns the TRACKING id when tracking is on (see setTracking), otherwise undefined
   */
  async setVar(ups: string, varName: string, value: string): Promise<string | undefined> {
    const bad = tokenError(ups, "UPS name") ?? tokenError(varName, "variable name") ?? valueError(value);
    if (bad) {
      throw bad;
    }
    return this.sendOk(`SET VAR ${ups} ${varName} "${escapeNut(value)}"`);
  }

  /**
   * Execute an instant command, optionally with its parameter (`INSTCMD <ups> <cmd> [<param>]`,
   * net-protocol.txt; a delay for `load.off.delay`, a duration for `test.battery.start` on some
   * drivers). Like upscmd (clients/upscmd.c:190) the parameter goes out unquoted, so it must be one
   * clean token — upsd only takes it when exactly three arguments arrive (server/netinstcmd.c:125).
   *
   * @param ups UPS name
   * @param cmd Command name
   * @param param Optional command parameter
   * @returns the TRACKING id when tracking is on (see setTracking), otherwise undefined
   */
  async instCmd(ups: string, cmd: string, param?: string): Promise<string | undefined> {
    const bad =
      tokenError(ups, "UPS name") ??
      tokenError(cmd, "command name") ??
      (param === undefined ? null : tokenError(param, "command parameter"));
    if (bad) {
      throw bad;
    }
    return this.sendOk(param === undefined ? `INSTCMD ${ups} ${cmd}` : `INSTCMD ${ups} ${cmd} ${param}`);
  }

  /**
   * Switch TRACKING on or off for this connection (`SET TRACKING ON|OFF`). With it on, upsd answers
   * `OK TRACKING <id>` to SET VAR and INSTCMD, and `GET TRACKING <id>` tells whether the DRIVER
   * carried the request out — a plain `OK` only means upsd handed it over (server/netinstcmd.c,
   * netset.c). The setting belongs to the connection and needs USERNAME/PASSWORD first
   * (`SET` is a FLAG_USER command, server/netcmds.h:73).
   *
   * @param on Whether to enable tracking
   */
  async setTracking(on: boolean): Promise<void> {
    await this.sendOk(`SET TRACKING ${on ? "ON" : "OFF"}`);
  }

  /**
   * Execution status of a tracked SET VAR/INSTCMD: `PENDING` or `SUCCESS`; a failure arrives as an
   * `ERR` (INVALID-ARGUMENT, FAILED, or UNKNOWN — the last one also for an id upsd no longer keeps).
   *
   * @param id Tracking id from `OK TRACKING <id>`
   */
  async getTracking(id: string): Promise<string> {
    const bad = tokenError(id, "tracking id");
    if (bad) {
      throw bad;
    }
    const [line] = await this.sendCommand(`GET TRACKING ${id}`, false);
    return line.trim();
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
   * @param beforeReady Only for STARTTLS: allowed while the connection is still being set up
   * @returns the id of `OK TRACKING <id>`, otherwise undefined
   */
  private async sendOk(command: string, beforeReady = false): Promise<string | undefined> {
    const [line] = await this.sendCommand(command, false, beforeReady);
    if (!/^OK(\s|$)/.test(line)) {
      throw new NutError("UNEXPECTED-RESPONSE", `Unexpected answer to ${redactForLog(command)}: ${line}`);
    }
    const tracking = /^OK TRACKING (\S+)/.exec(line);
    return tracking ? tracking[1] : undefined;
  }

  private sendCommand(command: string, multiLine: boolean, beforeReady = false): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      // A NUT command is exactly one protocol line — guard the wire against a stray line break in
      // any argument. SET VAR values are already safe on their own: they go out quoted and
      // escapeNut turns every " into \", so the quote cannot be closed, and upsd keeps a newline
      // inside quotes literal (verified against the bundled parseconf.c `quotecollect`). Every
      // unquoted argument is already refused by tokenError/credentialError (whitespace includes
      // line breaks); this check is the last guard for any command string — a line break would
      // split it into a bogus second command line and desync the connection.
      if (/[\r\n]/.test(command)) {
        reject(new NutInputError("NUT command must not contain line breaks"));
        return;
      }
      if (!this.socket || !(beforeReady ? this.connected : this.ready)) {
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
    this.dropConnection(new NutConnectionError("Client cancelled"));
  }

  /**
   * Tear down a connection whose stream can no longer be trusted (timeout desync, oversized answer)
   * and let the persistent loop reconnect on a clean stream. Reflected synchronously so callers see
   * it at once and the async 'close' handler sees ready=false (no double-schedule).
   *
   * @param reason Rejection handed to every pending command
   */
  private dropConnection(reason: Error): void {
    this.connected = false;
    this.ready = false;
    this.stopKeepAlive();
    this.buffer = "";
    this.rejectAll(reason);
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
      this.multiLineBytes = 0;
      this.multiLineExpectedEnd = ["END", ...splitNutLine(entry.command)];
    }

    this.socket?.write(`${entry.command}\n`);
    // Every command sent restarts upsd's idle clock, so it restarts ours too.
    this.armKeepAlive();
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      // NUT uses LF; tolerate CRLF from non-conformant servers.
      this.processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      if (!this.ready && !this.connected) {
        // processLine dropped the connection (oversized answer) — the rest is from a dead stream.
        return;
      }
    }

    // The remainder is one incomplete line. Past the cap it can only be a broken (or hostile)
    // stream — treat it like a timeout desync: drop the connection so the buffer cannot grow
    // without bound; the persistent loop reconnects on a clean stream.
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
      this.log?.warn(`NUT response line exceeded ${MAX_LINE_BYTES} bytes — dropping the connection`);
      this.dropConnection(new NutConnectionError("NUT response line exceeded the size limit"));
    }
  }

  private processLine(line: string): void {
    if (!this.active) {
      this.log?.debug(`<< (no active command) ${line}`);
      return;
    }

    // `ERR <message> [<extra>...]` — <message> is always exactly one token (net-protocol.txt,
    // "Error responses"); anything after it is extra information, not part of the code. A bare
    // `ERR` carries no code at all.
    if (line === "ERR" || line.startsWith("ERR ")) {
      const rest = line.slice(3).trim();
      const space = rest.search(/\s/);
      const code = space < 0 ? rest || "UNKNOWN" : rest.slice(0, space);
      const detail = space < 0 ? undefined : rest.slice(space).trim() || undefined;
      this.clearTimer(this.active.timer);
      const entry = this.active;
      this.active = null;
      this.multiLineBuffer = [];
      this.multiLineBytes = 0;
      this.multiLineExpectedEnd = [];
      entry.reject(new NutError(code, undefined, detail));
      this.processQueue();
      return;
    }

    if (this.active.multiLine) {
      if (line.startsWith("BEGIN LIST ")) {
        return;
      }
      if (sameTokens(splitNutLine(line), this.multiLineExpectedEnd)) {
        this.clearTimer(this.active.timer);
        const entry = this.active;
        const result = [...this.multiLineBuffer];
        this.active = null;
        this.multiLineBuffer = [];
        this.multiLineBytes = 0;
        this.multiLineExpectedEnd = [];
        entry.resolve(result);
        this.processQueue();
        return;
      }
      this.multiLineBytes += Buffer.byteLength(line, "utf8") + 1;
      if (this.multiLineBytes > MAX_RESPONSE_BYTES) {
        this.log?.warn(
          `NUT answer to ${redactForLog(this.active.command)} exceeded ${MAX_RESPONSE_BYTES} bytes without END LIST — dropping the connection`,
        );
        this.dropConnection(new NutConnectionError("NUT answer exceeded the size limit"));
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
 * Split one protocol line into tokens exactly as upsd reads a line (common/parseconf.c): whitespace
 * separates tokens, double quotes group a token that may contain whitespace, and a backslash takes
 * the next character literally — in and outside quotes (`\"`, `\\`, `\#`: upsd escapes `#`, `\` and
 * `"` in every value it sends, PCONF_ESCAPE in parseconf.c:596). Quoting is thus transparent: `VAR
 * ups x "1"` and `VAR "ups" "x" 1` give the same tokens.
 *
 * @param line One protocol line
 */
export function splitNutLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      inToken = true;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      inToken = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Whether two token lists are equal.
 *
 * @param a First list
 * @param b Second list
 */
function sameTokens(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * NUT command arguments are whitespace-separated, unquoted tokens (only the SET VAR value is
 * quoted). A name carrying a space, a quote or a backslash would re-split or re-quote the line
 * on the server; `#` starts a comment there and cuts the line short (common/parseconf.c:336), and
 * `=` becomes a token of its own (:355). Variable and command names come from the object tree, and
 * a command parameter from the user — refuse anything that is not one clean token before it
 * reaches the wire.
 *
 * @param value The argument about to be placed on the command line
 * @param what What it is, for the error message
 * @returns the error to reject with, or null when the token is clean
 */
function tokenError(value: string, what: string): NutInputError | null {
  if (value.length === 0 || /[\s"\\#=]/.test(value)) {
    return new NutInputError(`Invalid NUT ${what}: ${JSON.stringify(value)}`);
  }
  return null;
}

/**
 * The quoted SET VAR value: upsd drops every byte outside 0x20–0x7F without a word
 * (common/parseconf.c:184 `addchar`, CVE-2012-2944), so `Büro` would be stored as `Bro` while the
 * adapter reported `Büro` as set. Refuse it instead.
 *
 * @param value The value about to be sent
 * @returns the error to reject with, or null when upsd stores the value as sent
 */
function valueError(value: string): NutInputError | null {
  if (/[^\x20-\x7f]/.test(value)) {
    return new NutInputError(
      `The value ${JSON.stringify(value)} contains characters the NUT server cannot store (only printable ASCII is kept)`,
    );
  }
  return null;
}

/**
 * Same wire rule as {@link tokenError}, for the two credential arguments — but the message never
 * shows the value. Username and password are `protectedNative`/`encryptedNative`; an error text
 * ends up in the log and in the admin's connection-test answer, so it says WHAT is wrong, not what
 * was entered.
 *
 * A `#` is deliberately NOT refused: upsd cuts an unquoted word at `#` (parseconf.c:236/336), but it
 * reads its own upsd.users with the same parser, and upsmon sends the password the same way
 * (clients/upsmon.c:585) — an installation with `#` in a password works today. {@link
 * credentialHashWarning} lets the caller say so once instead.
 *
 * @param value The credential about to be placed on the command line
 * @param what "username" or "password", for the message
 * @returns the error to throw with, or null when the credential can go on the wire
 */
function credentialError(value: string, what: string): NutInputError | null {
  if (value.length === 0) {
    return new NutInputError(`The NUT ${what} is empty`);
  }
  if (/\s/.test(value)) {
    return new NutInputError(
      `The NUT ${what} contains a space (or tab) — the NUT protocol cannot carry one: upsd reads the rest as a second argument and answers ERR INVALID-ARGUMENT. Choose a ${what} without whitespace in upsd.users.`,
    );
  }
  if (/["\\]/.test(value)) {
    return new NutInputError(
      `The NUT ${what} contains a quote or a backslash — the NUT protocol cannot carry those unquoted; the server would read a different value than you entered. Choose a ${what} without " and \\ in upsd.users.`,
    );
  }
  if (value.includes("=")) {
    return new NutInputError(
      `The NUT ${what} contains "=" — upsd reads it as a separate argument and answers ERR INVALID-ARGUMENT. Choose a ${what} without "=" in upsd.users.`,
    );
  }
  if (/[^\x20-\x7f]/.test(value)) {
    return new NutInputError(
      `The NUT ${what} contains characters outside printable ASCII — upsd drops them, so it would check a different ${what}. Choose a ${what} of plain ASCII characters in upsd.users.`,
    );
  }
  return null;
}

/**
 * Whether a credential contains `#`, which upsd treats as the start of a comment: everything after
 * it is ignored — on the wire and in upsd.users alike, so the login usually still works. Worth one
 * line in the log, never a refusal (see credentialError).
 *
 * @param username NUT username
 * @param password NUT password
 * @returns the warning text, or null
 */
export function credentialHashWarning(username: string, password: string): string | null {
  const which = [username.includes("#") ? "username" : "", password.includes("#") ? "password" : ""].filter(Boolean);
  if (which.length === 0) {
    return null;
  }
  return `The NUT ${which.join(" and ")} contains "#" — upsd ignores everything from "#" on, in upsd.users as on the wire, so only the part before it is checked`;
}

/**
 * Encode a SET VAR value the way upsd's own clients do (pconf_encode, common/parseconf.c:596):
 * backslash, double quote and `#` are escaped. An unescaped `#` inside quotes is a parse error on
 * the server — it answers nothing, and the command runs into its timeout.
 *
 * @param s Raw value
 */
function escapeNut(s: string): string {
  return s.replace(/[\\"#]/g, ch => `\\${ch}`);
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
