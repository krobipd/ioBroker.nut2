import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import {
  coerceCommandTimeoutMs,
  coerceHost,
  coercePollIntervalSec,
  coercePort,
  errText,
  nutClientOptionsFrom,
  parseDecimal,
  parseNotifyTrigger,
} from "./lib/coerce";
import { dispatchMessage, makeTestClientFactory } from "./lib/message-router";
import {
  authFailureText,
  credentialHashWarning,
  NutClient,
  NutConnectionError,
  NutError,
  NutInputError,
  NutTimeoutError,
} from "./lib/nut-client";
import { nutVarToStateId, sanitizeUpsName, StateManager } from "./lib/state-manager";
import { detectStates, detectType } from "./lib/type-detector";
import type { AdapterConfig, NutClientOptions, NutLogger, NutRange, NutVariable, UpsInfo } from "./lib/types";

/** Upper bound for the notify warn-dedup set (external input must not grow it without limit). */
const NOTIFY_WARN_CAP = 100;

/**
 * Consecutive polls a UPS may be missing from LIST UPS before its objects are removed. A UPS that
 * vanishes for one poll (a typo in ups.conf and a reload, a driver restart) must not cost the user
 * the room, function and recording settings on every one of its datapoints — deleting an object
 * takes it out of every enum (js-controller 7.2.2 `removeIdFromAllEnums`).
 */
const MISSING_UPS_GRACE_POLLS = 3;

/** Object ids the adapter owns at the root of its namespace — never a UPS id. */
const RESERVED_ROOT_IDS = new Set(["info", "notify"]);

/** How often a tracked command's result is asked for (GET TRACKING). */
const TRACKING_POLL_MS = 500;

/** Id segment of the per-UPS state that runs a command with its parameter. */
const EXECUTE_STATE = "execute";

/** NUT codes that mean "this UPS is not delivering data right now" — a state, not a fault. */
const UPS_UNAVAILABLE_CODES = new Set(["DATA-STALE", "DRIVER-NOT-CONNECTED"]);

/**
 * NUT adapter — lifecycle, polling, command/SET-VAR dispatch.
 * Exported so the orchestration unit tests can drive its handlers directly.
 */
export class NutAdapter extends utils.Adapter {
  private client: NutClient | null = null;
  private stateManager: StateManager | null = null;
  private pollTimer: ioBroker.Timeout | undefined = undefined;
  private pollIntervalMs = 0;
  private isPolling = false;
  private pollAgainRequested = false;
  /** Unknown UPS names seen on the notify trigger — warn once each, then debug (no log spam). */
  private warnedNotifyRefs = new Set<string>();
  private lastErrorCode = "";
  private failedUps = new Set<string>();
  private discoveredUps = new Map<string, UpsInfo>();
  private authenticated = false;
  private credentialsSent = false;
  /** Credentials were reported as refused — warn once, then debug until they work again. */
  private warnedCredentialsRejected = false;
  /** Commands enabled without credentials — say it once, not on every reconnect. */
  private warnedCommandsWithoutCredentials = false;
  /** UPSes whose LIST CMD failed — warn once each, then debug (pruned with the UPS in discover). */
  private warnedCommandListFailures = new Set<string>();
  private enrichedUps = new Set<string>();
  /**
   * The variables LIST RW listed for each UPS on its last poll — what the adapter created
   * `write: true`. A write to anything else never reaches the wire (see onStateChange).
   */
  private writableVars = new Map<string, Set<string>>();
  /** SET VAR enabled without credentials — say it once, not on every reconnect. */
  private warnedSetVarWithoutCredentials = false;
  private testClients = new Set<NutClient>();
  private subscribed = false;
  private unloaded = false;
  /** The persistent client failed fatally — nothing polls any more (see onConnectFatal). */
  private pollHalted = false;
  private everConnected = false;
  /** Outcome of the last credential check, for the start line. */
  private credentialCheck: "none" | "verified" | "rejected" | "unverified" = "none";
  /** The credential check could not run (network) — said once, then debug. */
  private warnedCredentialsUnverified = false;
  /** Sending the credentials failed — said once, then debug. */
  private warnedCredentialsNotSent = false;
  /** `#` in a credential — said once per runtime. */
  private warnedCredentialHash = false;
  /** TRACKING is on for the live connection (set per connection in onConnected). */
  private trackingOn = false;
  /** UPSes whose command buttons exist for the current connection. */
  private commandsReady = new Set<string>();
  /** Polls in a row a known UPS was missing from LIST UPS (see MISSING_UPS_GRACE_POLLS). */
  private missingPolls = new Map<string, number>();
  /** The first discover of this runtime has run (removals there need no grace). */
  private discoveredOnce = false;
  /** discover() runs one at a time. */
  private discoverChain: Promise<void> = Promise.resolve();
  /** NUT names whose sanitized id collided — warned once each. */
  private warnedIdCollisions = new Set<string>();

  /** @param options Adapter options forwarded to the ioBroker base class. */
  constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: "nut2" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }

  /** The native config, typed — single cast point for all config reads. */
  private nutConfig(): AdapterConfig {
    return this.config as unknown as AdapterConfig;
  }

  // Factory seams — production builds the real collaborators; the orchestration
  // unit tests (src/main.test.ts) override these fields with fakes so onReady,
  // onConnected and poll can run without sockets or a js-controller.
  private makeClient: (...args: ConstructorParameters<typeof NutClient>) => NutClient = (...args) =>
    new NutClient(...args);
  private makeStateManager: () => StateManager = () => new StateManager(this);

  /**
   * Connection options for every client this adapter builds — the live one and the short-lived
   * verification connection. One source, so the probe really exercises the same path (source bind
   * on a multi-homed host, TLS settings, command deadline).
   */
  private clientOptions(): NutClientOptions {
    return {
      // The config-derived half comes from the one shared mapping (coerce.ts), which the admin's
      // connection test uses as well — otherwise an option added here would never reach the
      // button that claims to test this very connection.
      ...nutClientOptionsFrom(this.nutConfig()),
      // Inject the adapter-managed timers so the client's command/reconnect timeouts are
      // tracked and auto-cleared on unload (no native setTimeout leaks).
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: h => {
        if (h != null) {
          this.clearTimeout(h as ioBroker.Timeout);
        }
      },
      logger: this.nutLogger,
    };
  }

  // Single source for the {debug,warn,info} logger passed to the NUT client, the test-client
  // factory and the message router — avoids rebuilding the same wrapper at three call sites.
  private get nutLogger(): NutLogger {
    return {
      debug: (m: string) => this.log.debug(m),
      warn: (m: string) => this.log.warn(m),
      info: (m: string) => this.log.info(m),
    };
  }

  /**
   * Remove `supportedMessages` from this instance's own object — the whole key, not just its
   * `stopInstance` entry.
   *
   * Two defects hang on this one key, and the fix for the first caused the second:
   *
   * 1. `stopInstance: true` (manifest of v0.8.0 and earlier) makes the host kill the process one
   *    second after asking it to stop — `onUnload` never runs and every state written while
   *    shutting down is dead code. Dropping it from the manifest only helps a FRESH install: an
   *    upgrade merges the manifest into the existing instance object and never removes a key, so
   *    the old value survives in the database, and that is what the host reads.
   * 2. Writing `stopInstance: false` (v0.9.0–v0.12.0) fixed the shutdown but silently killed the
   *    message box, so the admin connection test did nothing at all: js-controller decides the
   *    subscription with `isMessageboxSupported()` — once `common.supportedMessages` is an
   *    OBJECT, `common.messagebox` is not even looked at, and a set of entries that are all
   *    `false` means "no messages" (`js-controller-adapter/lib/adapter/utils.js`, verified on the
   *    installed 7.2.2). The adapter then never subscribes and the message sits unread.
   *
   * Both are cured by deleting the key. `extendObject` merges and cannot remove anything, so the
   * key is overwritten with `null` — which does erase it (`node.extend` copies `null`, skips
   * `undefined`) and takes `isMessageboxSupported` back to the `common.messagebox` branch.
   *
   * Only written while the key is still there: every instance-object change restarts the
   * instance, so doing it unconditionally would be a restart loop.
   *
   * @returns true when the correction was written and the restart is coming — the caller has to
   *   stop right there. Carrying on would arm timers and write states in a process the host is
   *   already shutting down.
   */
  private async clearStopInstanceFlag(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      if (obj?.common?.supportedMessages === undefined || obj.common.supportedMessages === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (err: unknown) {
      // Objects DB unreachable — not worth failing the start over; the next start retries.
      this.log.debug(`Could not check the instance object ${id}: ${errText(err)}`);
      return false;
    }
  }

  /**
   * Nothing is being read right now — take the whole chain down together: every device marker
   * (that is what colours the device in the object tree) and the summary. `info.connection` is
   * written by each caller, because only they know whether the connection itself is the reason.
   *
   * Used by every dead end that is NOT a per-UPS failure: authentication rejected, a fatal TLS
   * problem, and a poll that failed as a whole. Leaving a UPS green next to "0 of 1 reachable"
   * is the contradiction this exists to prevent.
   */
  private async markAllUpsUnreachable(): Promise<void> {
    for (const upsId of [...this.discoveredUps.keys()]) {
      await this.setStateChangedAsync(`${upsId}.info.reachable`, { val: false, ack: true });
    }
    await this.stateManager?.writeUpsSummary(this.discoveredUps.size, 0);
  }

  private async onReady(): Promise<void> {
    try {
      // First: without this the whole shutdown path stays dead on an updated install.
      // A correction means the host is restarting us — no point setting anything up.
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      await I18n.init(join(this.adapterDir, "admin"), this);
      const config = this.nutConfig();
      this.log.debug(
        `onReady: starting (host='${config.host}', port=${JSON.stringify(config.port)}, pollInterval=${JSON.stringify(config.pollInterval)}s)`,
      );

      await this.setStateChangedAsync("info.connection", { val: false, ack: true });

      // Built before the host check so the online indicators are cleared even on a misconfigured
      // instance: nothing will poll, so a stale "reachable" would stand forever.
      this.stateManager = this.makeStateManager();
      // The manifest objects reach an EXISTING installation only through this call — js-controller
      // preserves their common.name when it re-applies them, so a renamed data point would land on
      // fresh installs only. Runs after I18n.init, because the texts come from admin/i18n.
      await this.stateManager.refreshInstanceObjects();
      await this.stateManager.markAllUnreachable();

      // The upsmon doorbell listens from the very start, independent of any successful connect:
      // with the NUT server down (or the host missing) a write must still be received, recorded
      // and confirmed — a SHUTDOWN event arriving while the connection is broken is the one that
      // matters most.
      await this.subscribeStatesAsync("notify");

      const host = coerceHost(config.host);
      if (!host) {
        this.log.error("NUT server host is required — check adapter configuration");
        return;
      }

      const port = coercePort(config.port);
      const commandTimeoutMs = coerceCommandTimeoutMs(config.commandTimeout);
      this.log.debug(`commandTimeout: raw=${JSON.stringify(config.commandTimeout)} resolved=${commandTimeoutMs}ms`);

      this.client = this.makeClient(host, port, this.clientOptions());

      // Unified retry loop lives in the client (start): it retries the initial connect,
      // reconnects on drops, and runs the idempotent post-connect setup on every (re)connect.
      this.client.setOnConnect(() => {
        void this.onConnected().catch((err: unknown) => this.log.error(`onConnected failed: ${errText(err)}`));
      });
      this.client.setOnFatal((err: unknown) => this.onConnectFatal(err));
      // A dropped connection is known the moment it drops — not at the end of the next poll
      // interval (up to 300 s later, while the NUT host may be shutting down on battery).
      this.client.setOnDisconnect(() => this.onDisconnected());
      this.client.start();
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  /**
   * Idempotent post-connect setup, run on the initial connect AND every reconnect (the client's
   * single retry loop drives both): discover UPSes, send the credentials + verify them, refresh
   * command buttons, poll, and arm the poll timer + subscription once. Rejected credentials warn
   * but never stop the polling — reading needs no login. Making "initial == reconnect" one path
   * keeps the two from drifting.
   */
  private async onConnected(): Promise<void> {
    if (this.unloaded || !this.client || !this.stateManager) {
      return;
    }
    const config = this.nutConfig();
    const host = coerceHost(config.host) ?? "";
    const port = coercePort(config.port);
    const pollSec = coercePollIntervalSec(config.pollInterval);

    try {
      this.enrichedUps.clear(); // fresh connection → re-enrich enum/range metadata
      this.commandsReady.clear(); // and re-list the commands
      this.trackingOn = false;
      await this.discover();

      await this.verifyCredentials(host, port);
      await this.enableTracking();
      await this.setupCommandButtons();
      if (config.enableSetVar && !this.credentialsSent && !this.warnedSetVarWithoutCredentials) {
        // Same reason and same once-per-runtime as the commands warning in setupCommandButtons:
        // the variables come up writable, and every write is refused with ACCESS-DENIED.
        this.warnedSetVarWithoutCredentials = true;
        this.log.warn(
          "SET VAR is enabled but no credentials are configured — the NUT server checks write rights per user, so every write will be refused",
        );
      }

      await this.poll();
      this.armPollTimer(config.pollInterval, pollSec);

      if (!this.subscribed && (config.enableCommands || config.enableSetVar)) {
        await this.subscribeStatesAsync("*");
        this.subscribed = true;
      }

      const transport = this.client?.isTls ? "TLS" : "unencrypted";
      if (this.everConnected) {
        // A reconnect is the connection coming back — a state (info.connection), not an event.
        this.log.debug(`Reconnected to NUT server ${host}:${port} (${transport}) — ${this.discoveredUps.size} UPS(es)`);
      } else {
        this.everConnected = true;
        const authStatus = {
          none: "no credentials",
          verified: `logged in as ${config.username}`,
          rejected: `credentials for ${config.username} rejected — reading only`,
          unverified: `credentials for ${config.username} not verified`,
        }[this.credentialCheck];
        this.log.info(
          `NUT adapter started — ${this.discoveredUps.size} UPS(es) on ${host}:${port}, polling every ${pollSec}s (${authStatus}, ${transport})`,
        );
      }
    } catch (err) {
      // The connection dropping in the middle of the setup is the state the retry loop already
      // handles — same bucket as a failed poll, not a red line (design #43).
      const code = this.classifyError(err);
      if (this.unloaded || code === "NETWORK" || code === "TIMEOUT") {
        this.log.debug(`Post-connect setup interrupted: ${errText(err)}`);
      } else if (code === "INVALID-INPUT") {
        this.log.warn(`Post-connect setup failed: ${errText(err)}`);
      } else {
        this.log.error(`Post-connect setup failed: ${errText(err)}`);
      }
      // Still arm the poll timer if setup failed on a live socket (e.g. a DB write during discovery
      // threw): otherwise the adapter stays connected but never polls, with no socket close to
      // trigger a reconnect.
      this.armPollTimer(config.pollInterval, pollSec);
    }
  }

  /**
   * Switch TRACKING on for the live connection, so a command or a write is only reported as done
   * once the DRIVER confirms it — upsd's plain `OK` only means it handed the request over
   * (server/netinstcmd.c, netset.c). `SET` needs USERNAME/PASSWORD first (FLAG_USER), and without
   * credentials there are no commands or writes anyway. Any refusal (a server older than 2.8,
   * TRACKING not built in) leaves the adapter at the plain `OK`.
   */
  private async enableTracking(): Promise<void> {
    if (!this.client || !this.credentialsSent) {
      return;
    }
    try {
      await this.client.setTracking(true);
      this.trackingOn = true;
    } catch (err: unknown) {
      this.log.debug(
        `TRACKING not available on this NUT server (${errText(err)}) — commands are confirmed by upsd only`,
      );
    }
  }

  /**
   * Wait for the driver's verdict on a tracked command or write (`GET TRACKING <id>`).
   *
   * @param id Tracking id from `OK TRACKING <id>`, or undefined when tracking is off
   * @returns "done" when the driver confirmed, "unconfirmed" when it did not answer in time or the
   *   id is unknown, "untracked" without an id
   * @throws {NutError} FAILED / INVALID-ARGUMENT when the driver refused
   */
  private async awaitDriver(id: string | undefined): Promise<"done" | "unconfirmed" | "untracked"> {
    if (id === undefined || !this.client) {
      return "untracked";
    }
    const deadline = Date.now() + coerceCommandTimeoutMs(this.nutConfig().commandTimeout);
    for (;;) {
      let status: string;
      try {
        status = await this.client.getTracking(id);
      } catch (err: unknown) {
        // ERR UNKNOWN is also what upsd answers for an id it no longer keeps — not a failure.
        if (err instanceof NutError && err.code === "UNKNOWN") {
          return "unconfirmed";
        }
        throw err;
      }
      if (status === "SUCCESS") {
        return "done";
      }
      if (status !== "PENDING" || Date.now() >= deadline || this.unloaded) {
        return "unconfirmed";
      }
      await new Promise<void>(resolve => {
        if (!this.setTimeout(resolve, TRACKING_POLL_MS)) {
          resolve(); // shutting down — this.setTimeout refuses; the loop ends on `unloaded`
        }
      });
    }
  }

  /**
   * The live connection dropped (reported by the client before it reconnects): nothing is read
   * any more, so the connection and every UPS go unreachable now, not after the next interval.
   */
  private onDisconnected(): void {
    if (this.unloaded) {
      return;
    }
    this.trackingOn = false;
    void this.setStateChangedAsync("info.connection", { val: false, ack: true })
      .then(() => this.markAllUpsUnreachable())
      .catch((err: unknown) => this.log.debug(`Could not record the lost connection: ${errText(err)}`));
  }

  /**
   * Send the credentials on the live connection and verify them on a SEPARATE, short-lived one.
   *
   * `USERNAME`/`PASSWORD` are only stored by upsd (`server/netuser.c`) — they prove nothing. The
   * command that really checks them is `LOGIN` (`user_checkaction`, `user.c`), and that is what
   * the verification connection sends, so a wrong password or a missing `upsmon secondary`
   * /`upsmon primary` line in `upsd.users` is reported instead of surfacing much later on the
   * first write.
   *
   * ⚠️ Why the login does NOT stay on the live connection (measured in the NUT 2.8.5 sources):
   * upsd counts every login (`ups->numlogins`, `server/netuser.c`) and only decrements it when the
   * connection closes (`declogins` in `server/upsd.c`, called from `client_disconnect` — `LOGOUT`
   * itself just ends the session). A PRIMARY `upsmon` reads that counter during a power failure
   * and waits until nothing but its own login is left before shutting the machine down, up to
   * `HOSTSYNC` seconds (`clients/upsmon.c`). A permanently logged-in monitoring client would delay
   * that shutdown on battery. The official read-only tools (`upsc`, `upscmd`, `upsrw`) never send
   * `LOGIN` for the same reason; only `upsmon` does, because there the login IS the signal.
   *
   * A rejection never stops the adapter: reading needs no login at all, so the poll keeps running
   * and only the log, the start line and the connection test say that the credentials were refused.
   *
   * @param host NUT server host (for logging)
   * @param port NUT server port (for logging)
   */
  private async verifyCredentials(host: string, port: number): Promise<void> {
    this.authenticated = false;
    this.credentialsSent = false;
    this.credentialCheck = "none";
    const config = this.nutConfig();
    if (!config.username || !config.password || !this.client) {
      return;
    }
    const hash = credentialHashWarning(config.username, config.password);
    if (hash && !this.warnedCredentialHash) {
      this.warnedCredentialHash = true;
      this.log.warn(hash);
    }

    // The live connection needs the credentials for SET VAR / INSTCMD — those are checked per
    // command by upsd, and a user with `actions`/`instcmds` but without an `upsmon` line can use
    // them even though the LOGIN below is refused.
    try {
      await this.client.authenticate(config.username, config.password);
      this.credentialsSent = true;
    } catch (err) {
      // Every reconnect runs this: a credential the protocol cannot carry would repeat the same
      // line forever. Once, then debug.
      const msg = `Could not send the credentials to NUT server ${host}:${port}: ${errText(err)}`;
      if (this.warnedCredentialsNotSent || this.isTransient(err)) {
        this.log.debug(msg);
      } else {
        this.warnedCredentialsNotSent = true;
        this.log.warn(msg);
      }
      this.credentialCheck = "unverified";
      return;
    }
    this.credentialCheck = "unverified";

    const first = this.discoveredUps.values().next().value;
    if (!first) {
      this.log.warn(
        `Credentials are configured but NUT server ${host}:${port} lists no UPS — nothing to log in to, credentials not verified`,
      );
      return;
    }

    // An unload can land while discover() above is still awaiting. Opening a fresh socket then
    // would outlive onUnload's teardown — it sweeps `testClients` before this line adds to it,
    // and the injected connect deadline never fires because `this.setTimeout` refuses during
    // shutdown, so the socket would hang until the process dies.
    if (this.unloaded) {
      return;
    }
    const probe = this.makeClient(host, port, this.clientOptions());
    this.testClients.add(probe);
    try {
      await probe.connect();
      await probe.authenticate(config.username, config.password);
      await probe.login(first.name);
      this.authenticated = true;
      this.credentialCheck = "verified";
      if (this.warnedCredentialsRejected) {
        // Recovered — say so once, at the same level the complaint went out.
        this.warnedCredentialsRejected = false;
        this.log.info(`NUT server ${host}:${port} accepted the credentials for ${config.username} again`);
      }
      this.warnedCredentialsUnverified = false;
      this.log.debug(`Credentials for ${config.username} verified on ${host}:${port} (LOGIN ${first.name})`);
    } catch (err) {
      const refused = authFailureText(err);
      if (refused === null) {
        // Not an answer about the credentials at all (the probe could not connect, timed out, or
        // the UPS vanished between discover and LOGIN) — saying "rejected" would send the user
        // after a password that is fine, and would silence the real rejection later.
        const msg = `Could not verify the credentials for ${config.username} on ${host}:${port}: ${errText(err)}`;
        if (this.warnedCredentialsUnverified || this.isTransient(err)) {
          this.log.debug(msg);
        } else {
          this.warnedCredentialsUnverified = true;
          this.log.warn(msg);
        }
        return;
      }
      this.credentialCheck = "rejected";
      // Every reconnect runs this check. Warning each time would fill the log on a flaky link
      // with a standing configuration problem; warn once, then keep it at debug until it clears.
      const message = `NUT server ${host}:${port} rejected the credentials for ${config.username}: ${refused}`;
      if (this.warnedCredentialsRejected) {
        this.log.debug(message);
      } else {
        this.warnedCredentialsRejected = true;
        this.log.warn(message);
        this.log.warn(
          "Reading UPS values continues — it needs no login. Switching a UPS or writing a variable will be refused until the credentials are corrected.",
        );
      }
    } finally {
      // Closing the probe releases the login again, so upsd's login count stays clean.
      probe.destroy();
      this.testClients.delete(probe);
    }
  }

  /**
   * Whether an error only says the server is not reachable right now (a state the retry loop
   * handles), as opposed to an answer worth a line in the log.
   *
   * @param err Caught value
   */
  private isTransient(err: unknown): boolean {
    const code = this.classifyError(err);
    return code === "NETWORK" || code === "TIMEOUT";
  }

  /**
   * Create instant-command button states for every discovered UPS. Runs whenever the credentials
   * were sent and commands are enabled — NOT only after a successful LOGIN: upsd checks a user's
   * `instcmds` right per command, and a user with command rights but without an `upsmon` line
   * cannot LOGIN yet may still switch the UPS (`docs/man/upsd.users.txt`). Each UPS is
   * best-effort; a genuinely unauthorised command is refused by the server and logged.
   */
  private async setupCommandButtons(): Promise<void> {
    if (!this.nutConfig().enableCommands || !this.client || !this.stateManager) {
      return;
    }
    if (!this.credentialsSent) {
      // Say it once instead of silently building nothing: a user who ticks "enable commands"
      // without credentials sees no buttons appear and has nowhere to look for the reason.
      // upsd checks `instcmds` per command against a named user, so commands need credentials.
      if (!this.warnedCommandsWithoutCredentials) {
        this.warnedCommandsWithoutCredentials = true;
        this.log.warn(
          "Instant commands are enabled but no credentials are configured — the NUT server checks command rights per user, so no command buttons are created",
        );
      }
      return;
    }
    for (const [upsId, ups] of [...this.discoveredUps]) {
      await this.setupCommandButtonsFor(upsId, ups);
    }
  }

  /**
   * Create the command buttons of one UPS. Also run from the poll for a UPS whose LIST CMD failed
   * earlier: after a power cut upsd is often up before the USB driver, answers
   * DRIVER-NOT-CONNECTED, and the buttons would otherwise wait for the next TCP reconnect — weeks.
   *
   * @param upsId Sanitized UPS object-ID segment
   * @param ups The UPS as listed by the server
   */
  private async setupCommandButtonsFor(upsId: string, ups: UpsInfo): Promise<void> {
    if (!this.client || !this.stateManager || this.commandsReady.has(upsId)) {
      return;
    }
    try {
      const commands = await this.client.listCmd(ups.name);
      await this.stateManager.createCommandButtons(upsId, commands);
      this.commandsReady.add(upsId);
      this.warnedCommandListFailures.delete(upsId);
      this.log.debug(`Created ${commands.length} command buttons for ${ups.name}`);
    } catch (err) {
      // The user ticked "enable commands" and gets no buttons — that has to be visible without
      // switching the log to debug, exactly like the missing-credentials case above. Once per
      // UPS per runtime; a driver that is just not there yet is a state and is retried on the
      // next successful poll of this UPS.
      const msg = `No command buttons for '${ups.name}' yet — the NUT server did not answer LIST CMD: ${errText(err)}`;
      const unavailable = err instanceof NutError && UPS_UNAVAILABLE_CODES.has(err.code);
      if (this.warnedCommandListFailures.has(upsId) || unavailable || this.isTransient(err)) {
        this.log.debug(msg);
      } else {
        this.warnedCommandListFailures.add(upsId);
        this.log.warn(msg);
      }
    }
  }

  /**
   * Arm the periodic poll timer once. Called on the normal setup path and again from the
   * post-connect error handler, so a non-connection failure on a live socket still recovers.
   *
   * @param rawInterval Raw configured poll interval, logged for diagnostics
   * @param pollSec Resolved poll interval in seconds
   */
  private armPollTimer(rawInterval: unknown, pollSec: number): void {
    if (this.unloaded || this.pollHalted || this.pollTimer !== undefined) {
      return;
    }
    this.log.debug(`pollInterval: raw=${JSON.stringify(rawInterval)} resolved=${pollSec}s`);
    this.pollIntervalMs = pollSec * 1000;
    this.scheduleNextPoll();
  }

  /**
   * Schedule the next poll one interval after the previous one FINISHES (a setTimeout chain rather
   * than a fixed setInterval), so a slow poll can never overlap the next tick. pollTimer stays
   * defined between ticks, keeping the armPollTimer idempotency guard and the error-handler
   * recovery re-entry intact; a poll running during onUnload sees unloaded and does not re-arm.
   */
  private scheduleNextPoll(): void {
    if (this.unloaded || this.pollHalted) {
      return;
    }
    this.pollTimer = this.setTimeout(() => {
      void this.poll().finally(() => this.scheduleNextPoll());
    }, this.pollIntervalMs);
  }

  /**
   * The persistent connection failed fatally (TLS misconfiguration). The client already stopped
   * retrying; stay alive + yellow so the admin connection-test button remains usable.
   *
   * @param err The fatal connect/STARTTLS error
   */
  private onConnectFatal(err: unknown): void {
    const config = this.nutConfig();
    const host = coerceHost(config.host) ?? "";
    const port = coercePort(config.port);
    this.log.error(
      `TLS connection to NUT server ${host}:${port} failed: ${errText(err)} — verify the server offers STARTTLS and check the certificate settings (Require valid certificate, CA file)`,
    );
    this.client?.destroy();
    // The client is gone for good — so is the poll. A fatal error can land on a RECONNECT (the CA
    // file was moved, the certificate expired), with the timer chain long armed: left alone it
    // re-armed itself forever against the destroyed client and wrote "will keep retrying" right
    // under the line that said nothing would (measured 2026-09-12).
    this.pollHalted = true;
    if (this.pollTimer) {
      this.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    void this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {});
    void this.markAllUpsUnreachable().catch(() => {
      /* states DB unreachable — the next start stamps them again */
    });
  }

  /**
   * Object ids for a UPS list: the sanitized NUT name, made unique. Two NUT names can collapse to
   * the same id ("u.p" and "u p" → "u_p"), and a UPS may be called like one of the adapter's own
   * root objects (`info`, `notify`) — that UPS gets a suffix (…-2, …-3), because its device object
   * would otherwise replace the instance's info channel or trigger, and its later removal would
   * delete them recursively.
   *
   * Suffixes are handed out in the order of the SORTED NUT names, not in the order the server
   * lists them: reordering ups.conf must not swap two UPSes' datapoints and recordings.
   *
   * @param upsList The UPSes to place
   * @param keep Entries that keep their current id (UPSes within the missing-grace period)
   */
  private assignUpsIds(upsList: UpsInfo[], keep: Map<string, UpsInfo> = new Map()): Map<string, UpsInfo> {
    const next = new Map<string, UpsInfo>(keep);
    const taken = (id: string): boolean => next.has(id) || RESERVED_ROOT_IDS.has(id);
    for (const ups of [...upsList].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const baseId = sanitizeUpsName(ups.name);
      let id = baseId;
      for (let n = 2; taken(id); n++) {
        id = `${baseId}-${n}`;
      }
      if (id !== baseId && !this.warnedIdCollisions.has(ups.name)) {
        this.warnedIdCollisions.add(ups.name);
        this.log.warn(
          RESERVED_ROOT_IDS.has(baseId)
            ? `UPS name '${ups.name}' is reserved for the adapter's own objects → using object ID '${id}'`
            : `UPS name '${ups.name}' collides with another after sanitization → using object ID '${id}'`,
        );
      }
      next.set(id, ups);
    }
    return next;
  }

  /**
   * Discover the UPS devices on the server and (re)build the object tree for them. Runs one at a
   * time: the poll and a reconnect can both ask for it, and two interleaved runs could each see
   * the other's half-built list and remove a UPS that is still there.
   *
   * @param prefetched LIST UPS result already fetched by the caller (the poll), otherwise fetched here
   */
  private discover(prefetched?: UpsInfo[]): Promise<void> {
    const run = this.discoverChain.then(() => this.runDiscover(prefetched));
    this.discoverChain = run.catch(() => {});
    return run;
  }

  /**
   * One discover run (see discover).
   *
   * @param prefetched LIST UPS result already fetched by the caller
   */
  private async runDiscover(prefetched?: UpsInfo[]): Promise<void> {
    if (!this.client || !this.stateManager) {
      return;
    }
    const upsList = prefetched ?? (await this.client.listUps());
    this.log.debug(`Discovered ${upsList.length} UPS(es): ${upsList.map(u => u.name).join(", ")}`);

    // A UPS missing from the list keeps its objects for MISSING_UPS_GRACE_POLLS polls — except on
    // the first discover of this runtime: a UPS that is not there when the adapter starts is gone.
    const listed = new Set(upsList.map(u => u.name));
    const keep = new Map<string, UpsInfo>();
    if (this.discoveredOnce) {
      for (const [upsId, ups] of this.discoveredUps) {
        const missing = this.missingPolls.get(upsId) ?? 0;
        if (!listed.has(ups.name) && missing > 0 && missing < MISSING_UPS_GRACE_POLLS) {
          keep.set(upsId, ups);
        }
      }
    }
    this.discoveredOnce = true;

    // Built aside and swapped in one step: the map is read by the poll and by onStateChange.
    const next = this.assignUpsIds(
      upsList.filter(u => ![...keep.values()].some(k => k.name === u.name)),
      keep,
    );
    for (const [upsId, ups] of next) {
      if (!keep.has(upsId)) {
        await this.stateManager.ensureUpsDevice(upsId, ups.description);
      }
    }
    for (const [upsId, ups] of this.discoveredUps) {
      if (!next.has(upsId)) {
        this.log.info(`UPS '${ups.name}' is no longer listed by the NUT server — removing its objects`);
      }
    }
    this.discoveredUps = next;

    const knownNames = new Set(this.discoveredUps.keys());
    await this.stateManager.pruneObjectTree(knownNames);

    // Prune the in-memory per-UPS markers alongside the object cleanup — a UPS that
    // disappears and later re-appears must start fresh (a stale failedUps entry would
    // demote its first real error to debug, a stale enrichedUps entry would skip the
    // enum/range enrichment, and a stale command-list marker would swallow the returning
    // UPS's first warning). One loop over all of them, so a marker added later cannot be
    // forgotten here.
    for (const marker of [
      this.failedUps,
      this.enrichedUps,
      this.warnedCommandListFailures,
      this.writableVars,
      this.commandsReady,
      this.missingPolls,
    ]) {
      for (const name of [...marker.keys()]) {
        if (!knownNames.has(name)) {
          marker.delete(name);
        }
      }
    }
  }

  /**
   * Bucket a caught poll error, so the log can tell "the server is away and we are retrying"
   * apart from "something unexpected broke".
   *
   * Classification is by TYPE, not by message text. The client raises its own classes for the two
   * states the poll sees most often; matching on wording instead meant that rephrasing a message
   * silently moved an error into another bucket, with the tests pinning the very string that was
   * being matched.
   *
   * @param err Caught value from the poll
   */
  private classifyError(err: unknown): string {
    if (err instanceof NutError) {
      return err.code;
    }
    // Something the adapter was asked to send cannot go on the wire — nothing reached the server.
    if (err instanceof NutInputError) {
      return err.code;
    }
    // The persistent client swallows socket failures in its own retry loop; what reaches the poll
    // is "not connected" / "connection closed" / "connect timed out". That IS the unreachable
    // server — the same bucket as ECONNREFUSED, and the reason the NETWORK branch exists.
    if (err instanceof NutConnectionError) {
      return "NETWORK";
    }
    if (err instanceof NutTimeoutError) {
      return "TIMEOUT";
    }
    if (!(err instanceof Error)) {
      return "UNKNOWN";
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENETUNREACH" ||
      code === "EHOSTUNREACH" ||
      code === "EAI_AGAIN"
    ) {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT") {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
  }

  private async poll(): Promise<void> {
    if (this.isPolling) {
      // Remember the request instead of dropping it: a notify trigger firing while a poll is
      // in flight may have arrived AFTER that poll already read ups.status — without a
      // follow-up the fresh event data would wait a full interval. Many triggers in a row
      // (upsmon fires one NOTIFYCMD per event) still collapse into ONE follow-up poll.
      this.pollAgainRequested = true;
      this.log.debug("Skipping poll — previous poll still running");
      return;
    }
    // A fatal TLS error destroyed the client for good (design #54) — a notify write must not
    // bring back "will keep retrying" under the line that said nothing would.
    if (!this.client || !this.stateManager || this.pollHalted) {
      return;
    }

    this.log.debug(`poll: starting (lastErrorCode='${this.lastErrorCode}', upsCount=${this.discoveredUps.size})`);

    this.isPolling = true;
    try {
      // LIST UPS is one cheap command per poll. A UPS added to or removed from the NUT server
      // at runtime used to wait for the next reconnect (or an adapter restart) — discovery
      // only ran once per connection.
      const upsList = await this.client.listUps();
      if (this.unloaded) {
        return;
      }
      const listed = new Set(upsList.map(u => u.name));
      const known = new Set([...this.discoveredUps.values()].map(u => u.name));
      const added = upsList.filter(u => !known.has(u.name));
      let removalDue = false;
      for (const [upsId, ups] of this.discoveredUps) {
        if (listed.has(ups.name)) {
          this.missingPolls.delete(upsId);
        } else {
          const missing = (this.missingPolls.get(upsId) ?? 0) + 1;
          this.missingPolls.set(upsId, missing);
          removalDue ||= missing >= MISSING_UPS_GRACE_POLLS;
        }
      }
      if (added.length > 0) {
        // A new UPS is an event the user caused (ups.conf) — worth a line.
        this.log.info(`New UPS on the NUT server: ${added.map(u => u.name).join(", ")}`);
      }
      if (added.length > 0 || removalDue) {
        await this.discover(upsList);
        await this.setupCommandButtons();
      }

      let reachable = 0;
      // Over a copy: discover() replaces the map, and the summary below must not count a map that
      // changed under it.
      for (const [upsId, ups] of [...this.discoveredUps]) {
        // upsId is the sanitized object-ID segment; nutName is the real NUT name for the protocol.
        const nutName = ups.name;
        if (this.missingPolls.has(upsId)) {
          // Not listed right now (grace period): nothing to read, and asking would only earn an
          // UNKNOWN-UPS — it is simply not reachable.
          await this.setStateChangedAsync(`${upsId}.info.reachable`, { val: false, ack: true });
          continue;
        }
        try {
          // Only query LIST RW when SET VAR is enabled — otherwise the variables would be marked
          // writable (write: true) in the admin object tree while a write is silently blocked, and
          // querying is pointless. With SET VAR off every variable stays read-only.
          const [variables, rwVars] = await Promise.all([
            this.client.listVar(nutName),
            this.nutConfig().enableSetVar
              ? this.client.listRw(nutName).catch((err: unknown) => {
                  this.log.debug(`LIST RW ${nutName} failed (non-critical): ${errText(err)}`);
                  return null;
                })
              : Promise.resolve<NutVariable[]>([]),
          ]);
          if (this.unloaded) {
            return;
          }

          // A LIST RW that failed says nothing about writability: keep what the last poll knew
          // instead of turning every variable read-only for the rest of the runtime.
          const rwNames = rwVars ? new Set(rwVars.map(v => v.name)) : (this.writableVars.get(upsId) ?? new Set());
          this.writableVars.set(upsId, rwNames);
          await this.stateManager.updateVariables(upsId, variables, rwNames);

          await this.stateManager.updateDeviceName(upsId, ups.description, variables);

          const statusVar = variables.find(v => v.name === "ups.status");
          if (statusVar) {
            // Pass battery.charger.status so charging/discharging fill in even on UPSes that
            // report it instead of the CHRG/DISCHRG status flags (e.g. Eaton Ellipse ECO).
            const chargerStatus = variables.find(v => v.name === "battery.charger.status")?.value;
            await this.stateManager.updateStatusFlags(upsId, statusVar.value, chargerStatus);
          }

          if (rwVars) {
            await this.enrichWritableVars(upsId, nutName, rwVars);
          }
          if (this.nutConfig().enableCommands && this.credentialsSent) {
            await this.setupCommandButtonsFor(upsId, ups);
          }
          if (this.unloaded) {
            return;
          }

          await this.setStateChangedAsync(`${upsId}.info.reachable`, { val: true, ack: true });
          reachable++;

          if (this.failedUps.has(upsId)) {
            // Coming back is a state (info.reachable), not an event.
            this.log.debug(`UPS '${nutName}' recovered`);
            this.failedUps.delete(upsId);
          }
        } catch (err) {
          // The connection itself went away: every other UPS would fail the same way, one warn
          // line each. Leave the loop and let the whole-poll path below report it once.
          if (err instanceof NutConnectionError || err instanceof NutTimeoutError || this.unloaded) {
            throw err;
          }
          try {
            await this.setStateChangedAsync(`${upsId}.info.reachable`, { val: false, ack: true });
          } catch (writeErr: unknown) {
            this.log.debug(`Could not record '${nutName}' as unreachable: ${errText(writeErr)}`);
          }

          // DATA-STALE / DRIVER-NOT-CONNECTED: the UPS is not delivering right now — a state
          // (info.reachable says it), recognised on every repetition, never a warning. Anything
          // else from the server is worth one line per UPS until it recovers.
          const unavailable = err instanceof NutError && UPS_UNAVAILABLE_CODES.has(err.code);
          const msg = unavailable
            ? `UPS '${nutName}': ${err.code === "DATA-STALE" ? "driver reports stale data" : "driver not connected"} — keeping existing states`
            : `Failed to poll UPS '${nutName}': ${errText(err)}`;
          if (unavailable || this.failedUps.has(upsId)) {
            this.log.debug(msg);
          } else {
            this.log.warn(msg);
          }
          this.failedUps.add(upsId);
        }
      }

      // Reflect the real TCP/NUT-server connection, not "the poll loop ran": per-UPS errors are
      // caught inside the loop, so an unconditional `true` here would show green even while the
      // connection is down (poll keeps firing during the reconnect backoff). Gate on the client.
      await this.setStateChangedAsync("info.connection", { val: this.client?.isConnected ?? false, ack: true });

      // One line an automation can watch instead of every device: how many UPSes there are and
      // how many answered THIS poll. A UPS that failed above is counted as not reachable.
      await this.stateManager.writeUpsSummary(this.discoveredUps.size, reachable);

      if (this.lastErrorCode) {
        this.log.debug("Connection restored");
        this.lastErrorCode = "";
      }
    } catch (err) {
      const errMsg = errText(err);
      const errorCode = this.classifyError(err);
      const isRepeat = errorCode === this.lastErrorCode;
      this.lastErrorCode = errorCode;

      if (this.unloaded) {
        // Shutting down: the client was torn down under this poll, so whatever it raised is our
        // own doing. Never let stopping the instance write a warning about itself — nor a state
        // after onUnload's final ones.
        this.log.debug(`Poll aborted by shutdown: ${errMsg}`);
        return;
      }
      if (isRepeat) {
        this.log.debug(`Poll failed (ongoing): ${errMsg}`);
      } else if (errorCode === "NETWORK" || errorCode === "TIMEOUT") {
        // An unreachable server is a state, not a log event (fleet rule 2026-09-22): the client is
        // already retrying, info.connection and every info.reachable carry it.
        const host = coerceHost(this.nutConfig().host) ?? "";
        const port = coercePort(this.nutConfig().port);
        this.log.debug(`Cannot reach NUT server ${host}:${port} (${errMsg}) — will keep retrying`);
      } else if (errorCode === "INVALID-INPUT") {
        this.log.warn(`Poll failed: ${errMsg}`);
      } else {
        this.log.error(`Poll failed: ${errMsg}`);
      }

      // The poll failed as a WHOLE (not a single UPS — those are caught inside the loop), so this
      // run learned nothing about any of them. Every device marker goes down together with the
      // summary: leaving a UPS green next to "0 of 1 reachable" is the same contradiction on one
      // screen that the summary is meant to resolve.
      //
      // Guarded like the writes in the try block: poll() is used as "never rejects" by the timer
      // chain and by the follow-up below, and these two awaits used to be the exception — with
      // the states DB gone (a stop, a controller restart) they rejected out of the catch, and
      // that became an unhandled rejection (measured 2026-09-12).
      try {
        await this.setStateChangedAsync("info.connection", { val: false, ack: true });
        await this.markAllUpsUnreachable();
      } catch (writeErr: unknown) {
        this.log.debug(`Could not record the failed poll: ${errText(writeErr)}`);
      }
    } finally {
      this.isPolling = false;
      if (this.pollAgainRequested && !this.unloaded) {
        this.pollAgainRequested = false;
        // Fire-and-forget: poll() never rejects (every await in it is caught), and the timer
        // chain stays untouched — this is just one extra run for the queued request.
        void this.poll();
      }
    }
  }

  /**
   * Enrich writable variables with ENUM (common.states) and RANGE (min/max) metadata, once per UPS
   * per connection (guarded by enrichedUps). Each query is best-effort — a driver that does not
   * support LIST ENUM/RANGE just logs at debug.
   *
   * The protocol call and the object write are guarded SEPARATELY: a driver that cannot answer is
   * a debug line and nothing changes, but a write that fails has to say so at warn — it may have
   * left the datapoint without the metadata it should carry. Both used to share one catch, which
   * blamed every failed write on the driver ("LIST ENUM … not supported").
   *
   * @param upsId Sanitized UPS object-ID segment (for state IDs)
   * @param nutName Real NUT name (for LIST ENUM/RANGE protocol calls)
   * @param rwVars Writable variables from LIST RW
   */
  private async enrichWritableVars(upsId: string, nutName: string, rwVars: NutVariable[]): Promise<void> {
    if (!this.client || !this.stateManager || this.enrichedUps.has(upsId) || rwVars.length === 0) {
      return;
    }
    // A driver that cannot answer ENUM/RANGE is final for this connection; a connection that
    // dropped or timed out in the middle is not — then this UPS is enriched again on the next poll.
    let interrupted = false;
    const noteFailure = (err: unknown): void => {
      if (err instanceof NutConnectionError || err instanceof NutTimeoutError) {
        interrupted = true;
      }
    };
    for (const rw of rwVars) {
      const stateId = nutVarToStateId(upsId, rw.name);
      // A writable yes/no var is a boolean state (detectType → boolean only via parseYesNo). Its
      // LIST ENUM yes/no must not become common.states — a string-keyed {yes,no} map is meaningless
      // on a boolean — so skip the enum round-trip entirely for booleans. RANGE stays (harmless: a
      // boolean has none). Multi-value string/number enums are unaffected.
      const isBoolean = detectType(rw.name, rw.value, true).type === "boolean";
      if (!isBoolean) {
        let enumVals: string[] | undefined;
        try {
          enumVals = await this.client.listEnum(nutName, rw.name);
        } catch (err: unknown) {
          noteFailure(err);
          this.log.debug(`LIST ENUM ${nutName} ${rw.name}: not supported (${errText(err)})`);
        }
        if (enumVals !== undefined) {
          if (enumVals.length > 0) {
            const states: Record<string, string> = {};
            for (const v of enumVals) {
              states[v] = v;
            }
            await this.applyMetadata(stateId, { states });
          } else if (!detectStates(rw.name)) {
            // The server no longer offers a value list, and the adapter's own catalog has none
            // for this variable either — so the list has to GO. A merge never removes a key, so
            // an old list would stay selectable in the admin forever. Only when the catalog is
            // silent too: its entries are the better answer for the many drivers that simply do
            // not implement LIST ENUM.
            await this.applyMetadata(stateId, { states: null });
          }
        }
      }
      let ranges: NutRange[] | undefined;
      try {
        ranges = await this.client.listRange(nutName, rw.name);
      } catch (err: unknown) {
        noteFailure(err);
        this.log.debug(`LIST RANGE ${nutName} ${rw.name}: not supported (${errText(err)})`);
      }
      if (ranges !== undefined) {
        // No range means the bounds must disappear, not stay: they came from LIST RANGE alone,
        // and a driver update that drops a range would otherwise leave js-controller warning
        // about every value outside bounds nobody reports any more. A variable can carry several
        // disjoint ranges (net-protocol.txt: "90"-"100" and "102"-"105"); the datapoint gets the
        // span over all of them — with the first range alone, 103 would be "above max".
        const patch: { min: number | null; max: number | null } = { min: null, max: null };
        const mins = ranges.map(r => parseDecimal(r.min)).filter(n => Number.isFinite(n));
        const maxs = ranges.map(r => parseDecimal(r.max)).filter(n => Number.isFinite(n));
        if (mins.length > 0) {
          patch.min = Math.min(...mins);
        }
        if (maxs.length > 0) {
          patch.max = Math.max(...maxs);
        }
        await this.applyMetadata(stateId, patch);
      }
    }
    if (!interrupted) {
      this.enrichedUps.add(upsId);
    }
  }

  /**
   * Write ENUM/RANGE metadata to a datapoint and say so if that fails — the one place in the poll
   * where a failed object write is neither a poll failure nor the driver's fault.
   *
   * @param stateId Local state id
   * @param patch Metadata to apply (see StateManager.enrichStateMetadata)
   */
  private async applyMetadata(
    stateId: string,
    patch: Parameters<StateManager["enrichStateMetadata"]>[1],
  ): Promise<void> {
    try {
      await this.stateManager?.enrichStateMetadata(stateId, patch);
    } catch (err: unknown) {
      this.log.warn(`Could not update the metadata of ${stateId}: ${errText(err)}`);
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    try {
      if (!state || state.ack) {
        return;
      }
      const config = this.nutConfig();
      const localId = id.replace(`${this.namespace}.`, "");
      this.log.debug(`onStateChange: ${localId} val=${JSON.stringify(state.val)}`);

      // The notify trigger comes BEFORE the client guard: recording an upsmon event must work
      // even while the NUT server is unreachable (the poll below then just runs into nothing).
      if (localId === "notify") {
        await this.handleNotifyTrigger(state.val);
        return;
      }

      if (!this.client || this.unloaded || this.pollHalted || !this.client.isConnected) {
        // Nothing can reach the server right now (not connected yet, reconnecting, stopped by a
        // fatal TLS error, shutting down). A write then is not an error of the write — the next
        // poll shows the real value again; a command button is reset below.
        this.log.debug(`onStateChange: ignoring ${localId} — not connected to the NUT server`);
        if (this.client && !this.unloaded && /\.commands\./.test(localId) && state.val !== false) {
          await this.setState(id, { val: false, ack: true });
        }
        return;
      }

      const parts = localId.split(".");

      // Two segments is a legitimate shape: a NUT variable without a dot has no channel and is
      // created directly under the device (`ups0.SOMEVAR`). It is only writable if the state
      // manager knows the original NUT name for it — that is the same lossless lookup the dotted
      // path uses, so it decides here too. Rejecting on segment count alone made the adapter
      // create such a variable with `write: true` and then drop every write to it.
      if (parts.length < 2 || (parts.length === 2 && !this.stateManager?.nutNameForState(localId))) {
        this.log.debug(`onStateChange: unexpected id structure '${localId}', ignoring`);
        return;
      }

      const upsId = parts[0];
      const ups = this.discoveredUps.get(upsId);
      if (!ups) {
        this.log.debug(`onStateChange: unknown UPS '${upsId}', ignoring`);
        return;
      }
      // parts[0] is the sanitized object ID; the protocol needs the real NUT name.
      const nutName = ups.name;

      // `info` (reachable, notify) and `status` (the parsed flags) are adapter-owned channels,
      // never NUT variables — a write there (a script, the REST API) must not turn into a
      // SET VAR that upsd rejects with VAR-NOT-SUPPORTED and an error line in the log.
      // Only meaningful with a channel segment: at two segments parts[1] is the variable name
      // itself, and the state manager already keeps such a name off the adapter's own channels.
      if (parts.length > 2 && (parts[1] === "info" || parts[1] === "status")) {
        this.log.debug(`onStateChange: ${localId} is adapter-owned, ignoring write`);
        return;
      }

      if (parts.length > 2 && parts[1] === "commands") {
        if (!config.enableCommands) {
          this.log.warn(`Command blocked — enableCommands is disabled: ${localId}`);
          return;
        }
        if (parts.length === 3 && parts[2] === EXECUTE_STATE) {
          await this.runExecuteState(id, upsId, nutName, state.val);
          return;
        }
        const cmdName = this.stateManager?.nutNameForState(localId) ?? parts.slice(2).join(".").replace(/-/g, ".");
        await this.runCommand(nutName, cmdName);
        await this.setState(id, { val: false, ack: true });
        return;
      }

      if (!config.enableSetVar) {
        this.log.warn(`SET VAR blocked — enableSetVar is disabled: ${localId}`);
        return;
      }
      // Boundary: a state can carry null or an object (REST API, scripts). "null" or
      // "[object Object]" is no value NUT should ever see on the wire.
      if (typeof state.val !== "boolean" && typeof state.val !== "number" && typeof state.val !== "string") {
        this.log.warn(
          `SET VAR ignored — ${localId} received ${JSON.stringify(state.val)}, not a boolean, number or string`,
        );
        return;
      }

      // The lossless name the state manager recorded when it created the state. The reconstruction
      // is only the fallback for a dotted id whose state predates that bookkeeping; a dotless id
      // never needs it (the guard above already required the lookup to succeed).
      const varName =
        this.stateManager?.nutNameForState(localId) ??
        (parts.length > 2 ? `${parts[1]}.${parts.slice(2).join(".").replace(/-/g, ".")}` : parts.slice(1).join("."));
      // What the server listed as writable on the last poll is what the adapter created
      // `write: true`. A write to any other variable (a script, the REST API) would go out as a
      // SET VAR that upsd refuses with READONLY and a red line — for a datapoint the adapter
      // itself declared read-only. Only on knowledge: a UPS the poll has not listed yet is left
      // to the server.
      const writable = this.writableVars.get(upsId);
      if (writable && !writable.has(varName)) {
        this.log.debug(`onStateChange: ${localId} is read-only (${varName} is not in LIST RW), ignoring write`);
        return;
      }
      // driver.flag.* is read-only by design (#16), whatever LIST RW says: the one writable flag
      // (allow_killpower) takes 1/0 on the wire, and the boolean path would send yes/no.
      if (varName.startsWith("driver.flag.")) {
        this.log.debug(`onStateChange: ${localId} is a driver flag — read-only, ignoring write`);
        return;
      }
      // A writable yes/no variable (ups.start.auto/.battery/.reboot, battery.protection) is stored
      // as a boolean state (detectType → boolean only via parseYesNo, so boolean ⟺ the NUT var
      // accepts yes/no). Translate it back to the token NUT expects — String(true) = "true" would
      // be rejected with INVALID-VALUE/SET-FAILED. Numbers/enum strings write verbatim.
      const value = typeof state.val === "boolean" ? (state.val ? "yes" : "no") : String(state.val);
      // A "#" cannot make the round trip: the driver reports the new value back to upsd unescaped
      // (NUT drivers/dstate.c, SETINFO — 2.8.5 and current master), and upsd's parser drops that
      // line at the "#" (common/parseconf.c) together with the tracking answer behind it. upsd and
      // every NUT client would keep showing the old value. Measured on upsd 2.8.5 (2026-09-25).
      if (value.includes("#")) {
        this.log.warn(
          `Not writing ${varName} on ${nutName}: the value contains "#", which the NUT driver cannot report back to the NUT server — the server would keep showing the old value`,
        );
        await this.restoreFromServer(id, nutName, varName);
        return;
      }
      this.log.debug(`SET VAR ${nutName} ${varName} "${value}"`);
      try {
        const tracking = await this.client.setVar(nutName, varName, value);
        const verdict = await this.awaitDriver(tracking);
        // Confirm with the value in the datapoint's own type — a script writing "230" as a string
        // to a number datapoint would otherwise be acknowledged as a string (js-controller logs
        // that on every write).
        const parsed = detectType(varName, value, true).parsedValue;
        await this.setState(id, { val: parsed ?? state.val, ack: true });
        this.log.info(
          verdict === "unconfirmed"
            ? `Variable sent: ${varName} = "${value}" on ${nutName} — the driver has not confirmed it (yet)`
            : `Variable set: ${varName} = "${value}" on ${nutName}`,
        );
      } catch (err) {
        this.log.error(`SET VAR failed: ${varName} on ${nutName} — ${errText(err)}`);
        await this.restoreFromServer(id, nutName, varName);
      }
    } catch (err: unknown) {
      this.log.error(`onStateChange failed: ${errText(err)}`);
    }
  }

  /**
   * Run one instant command and report what the driver made of it.
   *
   * @param nutName Real NUT name of the UPS
   * @param cmdName Command name
   * @param param Optional command parameter (commands.execute)
   */
  private async runCommand(nutName: string, cmdName: string, param?: string): Promise<void> {
    if (!this.client) {
      return;
    }
    const label = param === undefined ? cmdName : `${cmdName} ${param}`;
    this.log.debug(`INSTCMD ${nutName} ${label}`);
    try {
      const tracking =
        param === undefined
          ? await this.client.instCmd(nutName, cmdName)
          : await this.client.instCmd(nutName, cmdName, param);
      const verdict = await this.awaitDriver(tracking);
      this.log.info(
        verdict === "unconfirmed"
          ? `Command sent: ${label} on ${nutName} — the driver has not confirmed it (yet)`
          : `Command executed: ${label} on ${nutName}`,
      );
    } catch (err) {
      this.log.error(`Command failed: ${label} on ${nutName} — ${errText(err)}`);
    }
  }

  /**
   * `<ups>.commands.execute`: a command with its optional parameter, written the way upscmd takes
   * it (`load.off.delay 120`). Only commands the UPS lists are sent; the state is acknowledged with
   * what was actually sent, or emptied when nothing was.
   *
   * @param id Full state id
   * @param upsId Sanitized UPS id
   * @param nutName Real NUT name of the UPS
   * @param raw The written value
   */
  private async runExecuteState(id: string, upsId: string, nutName: string, raw: ioBroker.StateValue): Promise<void> {
    const text = typeof raw === "string" ? raw.trim() : "";
    const [cmdName, param, ...rest] = text.split(/\s+/);
    const known = this.stateManager?.commandsOf(upsId);
    if (!cmdName || rest.length > 0 || (known && !known.has(cmdName))) {
      this.log.warn(
        `commands.execute on ${nutName}: ${JSON.stringify(text)} is not "<command> [<parameter>]" with a command the UPS offers`,
      );
      await this.setState(id, { val: "", ack: true });
      return;
    }
    await this.runCommand(nutName, cmdName, param);
    await this.setState(id, { val: text, ack: true });
  }

  /**
   * After a refused SET VAR, show the value the server really holds instead of leaving the
   * unconfirmed write standing until the next poll.
   *
   * @param id Full state id
   * @param nutName Real NUT name of the UPS
   * @param varName NUT variable name
   */
  private async restoreFromServer(id: string, nutName: string, varName: string): Promise<void> {
    try {
      const current = await this.client?.getVar(nutName, varName);
      if (current !== undefined) {
        const parsed = detectType(varName, current, true).parsedValue;
        await this.setState(id, { val: parsed, ack: true });
      }
    } catch (err: unknown) {
      this.log.debug(`GET VAR ${nutName} ${varName} after the failed write: ${errText(err)}`);
    }
  }

  /**
   * A write to the `notify` trigger state — the doorbell upsmon (or a hand on the admin) rings
   * instead of waiting for the next scheduled poll. Value format: `$NOTIFYTYPE $UPSNAME` as
   * upsmon delivers them via NOTIFYCMD; both parts are optional (an empty write is a plain
   * manual refresh).
   *
   * Order is deliberate: record the event and confirm the trigger FIRST, poll second. On a
   * SHUTDOWN event the NUT host may die mid-poll — the event itself must already be safe.
   *
   * @param rawVal Raw state value as written (REST API, script, admin — any shape can arrive)
   */
  private async handleNotifyTrigger(rawVal: ioBroker.StateValue): Promise<void> {
    if (this.unloaded) {
      return;
    }
    const { type, upsRef, text } = parseNotifyTrigger(rawVal);

    let matchedId: string | undefined;
    if (upsRef) {
      // First by the real NUT name (survives sanitization AND `…-2` collision suffixes),
      // then by the sanitized object ID — covers both spellings a user may configure.
      for (const [upsId, ups] of [...this.discoveredUps]) {
        if (ups.name === upsRef) {
          matchedId = upsId;
          break;
        }
      }
      if (!matchedId && this.discoveredUps.has(sanitizeUpsName(upsRef))) {
        matchedId = sanitizeUpsName(upsRef);
      }
      if (!matchedId) {
        const msg = `notify: unknown UPS ${JSON.stringify(upsRef)} — refreshing all UPSes, event recorded on the trigger state only`;
        if (this.warnedNotifyRefs.has(upsRef)) {
          this.log.debug(msg);
        } else {
          // The dedup set is fed by an external write — cap it so a flood of distinct unknown
          // names cannot grow it without bound. At the cap we drop the dedup memory and start
          // over: the worst case is one more warn per name, never unbounded memory.
          if (this.warnedNotifyRefs.size >= NOTIFY_WARN_CAP) {
            this.warnedNotifyRefs.clear();
          }
          this.warnedNotifyRefs.add(upsRef);
          this.log.warn(msg);
        }
      }
    }

    if (type) {
      this.log.info(`upsmon event ${JSON.stringify(type)}${matchedId ? ` for UPS '${matchedId}'` : ""} — refreshing`);
      if (matchedId) {
        await this.setState(`${matchedId}.info.notify`, { val: type, ack: true });
      }
    } else {
      this.log.debug("notify: manual refresh triggered");
    }

    // Confirm the trigger (ack echo) before the poll for the same reason the event went first.
    // The normalised text goes back, not the raw write: the state is a string, and whatever a
    // script pushed (an object, an overlong blob) must not be stored as such.
    await this.setState("notify", { val: text, ack: true });
    await this.poll();
  }

  /**
   * The adapter's own timers for the connection-test client (N14): they die with the instance.
   * The client clears handles it never armed (a queued command has no timer yet) — the adapter's
   * clearTimeout is only called with a real one.
   */
  private testClientTimers(): { setTimer: (cb: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void } {
    return {
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: h => {
        if (h != null) {
          this.clearTimeout(h as ioBroker.Timeout);
        }
      },
    };
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      await dispatchMessage(obj, {
        log: this.nutLogger,
        sendTo: this.sendTo.bind(this),
        createTestClient: makeTestClientFactory(NutClient, this.nutLogger, this.testClientTimers()),
        onTestClientCreated: client => {
          this.testClients.add(client);
        },
        onTestClientDone: client => {
          this.testClients.delete(client);
        },
      });
    } catch (err: unknown) {
      this.log.error(`onMessage failed: ${errText(err)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      this.unloaded = true;
      if (this.pollTimer) {
        this.clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
      // The client owns its reconnect timer (managed via this.setTimeout) — shutdown() clears it.
      // Always the graceful path: it half-closes so the pending write flushes, and the LOGOUT it
      // sends is answered with "OK Goodbye" whether or not this connection ever logged in
      // (server/netuser.c). Tying it to the login state was left over from the days when the
      // live connection carried the LOGIN — it never does any more (see verifyCredentials).
      this.client?.shutdown();
      for (const tc of this.testClients) {
        tc.destroy();
      }
      this.testClients.clear();

      // A stopped adapter reads nothing, so it must not keep claiming a UPS is reachable — that
      // state backs the device object's online indicator (statusStates.onlineId), and
      // info.connection alone would leave every device green. The summary goes down with them;
      // info.upsTotal stays, how many UPSes exist did not change.
      //
      // The callback goes LAST, after the writes: reporting "done" straight away loses them —
      // the host tears the process down as soon as it is told. No own timeout guard either:
      // `this.setTimeout` refuses during shutdown and a bare `setTimeout` is a checker finding;
      // the host's own deadline is the only one needed.
      const writes: Promise<unknown>[] = [this.setState("info.connection", { val: false, ack: true })];
      for (const upsId of this.discoveredUps.keys()) {
        writes.push(this.setState(`${upsId}.info.reachable`, { val: false, ack: true }));
      }
      writes.push(this.setState("info.upsReachable", { val: 0, ack: true }));
      writes.push(this.setState("info.allUpsReachable", { val: false, ack: true }));
      void Promise.all(writes)
        .catch((err: unknown) => {
          // States DB already going down — nothing left to report to.
          this.log.debug(`onUnload: final states rejected: ${errText(err)}`);
        })
        .finally(callback);
      return;
    } catch (err) {
      this.log.debug(`onUnload error (ignored): ${errText(err)}`);
    }
    callback();
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new NutAdapter(options);
} else {
  (() => new NutAdapter())();
}
