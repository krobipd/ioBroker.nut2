/**
 * Orchestration tests for main.ts — onReady wiring, the idempotent onConnected
 * setup (auth-failure → yellow, command buttons, timer arming), the poll matrix
 * (per-UPS error dedup, DATA-STALE, one-shot enrichment, connection gating),
 * classifyError, onStateChange command/SET-VAR gates and onUnload.
 *
 * Fleet harness pattern: `@iobroker/adapter-core` is mocked with a stub Adapter
 * class; the NutClient and StateManager are injected as fakes through the
 * factory seams (makeClient/makeStateManager) — their real implementations are
 * covered by their own suites against real sockets / the preserve-aware mock.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => {
  class StubAdapter {
    namespace = "nut2.0";
    adapterDir = "/stub-adapter-dir";
    config: Record<string, unknown> = {};
    states = new Map<string, { val: unknown; ack: boolean }>();
    logs: { level: string; msg: string }[] = [];
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    subscriptions: string[] = [];
    intervals: { cb: () => void; ms: number }[] = [];
    timeouts: { cb: () => void; ms: number; cleared: boolean }[] = [];

    log = {
      debug: (m: string): void => void this.logs.push({ level: "debug", msg: m }),
      info: (m: string): void => void this.logs.push({ level: "info", msg: m }),
      warn: (m: string): void => void this.logs.push({ level: "warn", msg: m }),
      error: (m: string): void => void this.logs.push({ level: "error", msg: m }),
    };

    constructor(_options?: unknown) {}

    on(event: string, cb: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, cb);
      return this;
    }

    private fullId(id: string): string {
      return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }

    /** When set, every state write rejects the way js-controller does once its DB is gone. */
    statesDbClosed = false;

    setState(id: string, state: { val: unknown; ack?: boolean }): Promise<void> {
      if (this.statesDbClosed) {
        return Promise.reject(new Error("Connection is closed."));
      }
      this.states.set(this.fullId(id), { val: state.val, ack: state.ack ?? false });
      return Promise.resolve();
    }

    setStateChangedAsync(id: string, state: { val: unknown; ack?: boolean }): Promise<void> {
      if (this.statesDbClosed) {
        return Promise.reject(new Error("Connection is closed."));
      }
      this.states.set(this.fullId(id), { val: state.val, ack: state.ack ?? false });
      return Promise.resolve();
    }

    subscribeStatesAsync(pattern: string): Promise<void> {
      this.subscriptions.push(pattern);
      return Promise.resolve();
    }

    setInterval(cb: () => void, ms: number): object {
      this.intervals.push({ cb, ms });
      return { __interval: this.intervals.length - 1 };
    }

    clearInterval(_handle: unknown): void {}

    setTimeout(cb: () => void, ms: number): object {
      const entry = { cb, ms, cleared: false };
      this.timeouts.push(entry);
      return entry;
    }

    clearTimeout(handle: unknown): void {
      const entry = this.timeouts.find(t => t === handle);
      if (entry) {
        entry.cleared = true;
      }
    }

    getForeignObjectAsync = vi.fn((_id: string): Promise<unknown> => Promise.resolve(null));
    extendForeignObjectAsync = vi.fn(async (_id: string, _obj: unknown): Promise<void> => {});

    sentTo: { from: string; command: string; response: unknown }[] = [];

    sendTo(from: string, command: string, response: unknown, _cb?: unknown): void {
      this.sentTo.push({ from, command, response });
    }
  }

  return {
    Adapter: StubAdapter,
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: vi.fn((key: string) => ({ en: key })),
      translate: vi.fn((key: string) => key),
    },
  };
});

import { NutAdapter } from "./main";
import { NutConnectionError, NutError, NutTimeoutError } from "./lib/nut-client";
import type { NutClient } from "./lib/nut-client";
import type { StateManager } from "./lib/state-manager";
import type { NutVariable, UpsInfo } from "./lib/types";

/** Stub surface added by the adapter-core mock (see vi.mock factory above). */
interface StubSurface {
  config: Record<string, unknown>;
  states: Map<string, { val: unknown; ack: boolean }>;
  logs: { level: string; msg: string }[];
  subscriptions: string[];
  intervals: { cb: () => void; ms: number }[];
  timeouts: { cb: () => void; ms: number; cleared: boolean }[];
  getForeignObjectAsync: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  sentTo: { from: string; command: string; response: unknown }[];
  statesDbClosed: boolean;
}

interface FakeClient {
  start: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  isTls: boolean;
  listUps: ReturnType<typeof vi.fn>;
  listVar: ReturnType<typeof vi.fn>;
  listRw: ReturnType<typeof vi.fn>;
  listCmd: ReturnType<typeof vi.fn>;
  listEnum: ReturnType<typeof vi.fn>;
  listRange: ReturnType<typeof vi.fn>;
  instCmd: ReturnType<typeof vi.fn>;
  setVar: ReturnType<typeof vi.fn>;
  setOnConnect: ReturnType<typeof vi.fn>;
  setOnFatal: ReturnType<typeof vi.fn>;
  isConnected: boolean;
  /** Captured by setOnConnect — drive it to simulate the client's (re)connect. */
  onConnect: (() => void) | null;
  onFatal: ((err: unknown) => void) | null;
}

function makeFakeClient(upsList: UpsInfo[] = [{ name: "ups0", description: "Main UPS" }]): FakeClient {
  const fake: FakeClient = {
    start: vi.fn(),
    connect: vi.fn(async () => {}),
    destroy: vi.fn(),
    shutdown: vi.fn(),
    authenticate: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    isTls: false,
    listUps: vi.fn(() => Promise.resolve(upsList)),
    listVar: vi.fn((): Promise<NutVariable[]> =>
      Promise.resolve([
        { name: "battery.charge", value: "100" },
        { name: "ups.status", value: "OL" },
      ]),
    ),
    listRw: vi.fn((): Promise<NutVariable[]> => Promise.resolve([])),
    listCmd: vi.fn(() => Promise.resolve([{ name: "beeper.enable" }])),
    listEnum: vi.fn(() => Promise.resolve([])),
    listRange: vi.fn(() => Promise.resolve([])),
    instCmd: vi.fn(async () => {}),
    setVar: vi.fn(async () => {}),
    setOnConnect: vi.fn((cb: () => void) => {
      fake.onConnect = cb;
    }),
    setOnFatal: vi.fn((cb: (err: unknown) => void) => {
      fake.onFatal = cb;
    }),
    isConnected: true,
    onConnect: null,
    onFatal: null,
  };
  return fake;
}

interface FakeStateManager {
  ensureUpsDevice: ReturnType<typeof vi.fn>;
  updateVariables: ReturnType<typeof vi.fn>;
  updateDeviceName: ReturnType<typeof vi.fn>;
  updateStatusFlags: ReturnType<typeof vi.fn>;
  createCommandButtons: ReturnType<typeof vi.fn>;
  pruneObjectTree: ReturnType<typeof vi.fn>;
  enrichStateMetadata: ReturnType<typeof vi.fn>;
  nutNameForState: ReturnType<typeof vi.fn>;
  markAllUnreachable: ReturnType<typeof vi.fn>;
  refreshInstanceObjects: ReturnType<typeof vi.fn>;
  writeUpsSummary: ReturnType<typeof vi.fn>;
}

function makeFakeStateManager(): FakeStateManager {
  return {
    ensureUpsDevice: vi.fn(async () => {}),
    updateVariables: vi.fn(async () => {}),
    updateDeviceName: vi.fn(async () => {}),
    updateStatusFlags: vi.fn(async () => {}),
    createCommandButtons: vi.fn(async () => {}),
    pruneObjectTree: vi.fn(async () => {}),
    enrichStateMetadata: vi.fn(async () => {}),
    nutNameForState: vi.fn(() => undefined),
    markAllUnreachable: vi.fn(async () => {}),
    refreshInstanceObjects: vi.fn(async () => {}),
    writeUpsSummary: vi.fn(async () => {}),
  };
}

/** Typed access to the private members the orchestration tests drive. */
interface Internal {
  onReady: () => Promise<void>;
  onConnected: () => Promise<void>;
  onStateChange: (id: string, state: { val: unknown; ack: boolean } | null | undefined) => Promise<void>;
  onUnload: (callback: () => void) => void;
  onMessage: (obj: ioBroker.Message) => Promise<void>;
  poll: () => Promise<void>;
  discover: () => Promise<void>;
  classifyError: (err: unknown) => string;
  unloaded: boolean;
  makeClient: (...args: unknown[]) => NutClient;
  makeStateManager: () => StateManager;
  client: FakeClient | null;
  stateManager: FakeStateManager | null;
  failedUps: Set<string>;
  enrichedUps: Set<string>;
  discoveredUps: Map<string, UpsInfo>;
  authenticated: boolean;
  warnedNotifyRefs: Set<string>;
  testClients: Set<{ destroy: () => void }>;
  pollTimer: unknown;
  lastErrorCode: string;
  scheduleNextPoll: () => void;
}

const BASE_CONFIG = {
  host: "10.0.0.3",
  port: 3493,
  networkInterface: "",
  pollInterval: 15,
  username: "",
  password: "",
  useTls: false,
  tlsRejectUnauthorized: false,
  tlsCaFile: "",
  commandTimeout: 5,
  enableCommands: false,
  enableSetVar: false,
};

interface Setup {
  adapter: NutAdapter;
  internal: Internal;
  stub: StubSurface;
  client: FakeClient;
  /** The short-lived connection that verifies the credentials (second client the adapter builds). */
  probe: FakeClient;
  /** Constructor arguments of every client the adapter built, in order. */
  clientArgs: unknown[][];
  sm: FakeStateManager;
}

function setup(config: Partial<typeof BASE_CONFIG> = {}, upsList?: UpsInfo[]): Setup {
  const adapter = new NutAdapter();
  const stub = adapter as unknown as StubSurface;
  const internal = adapter as unknown as Internal;
  stub.config = { ...BASE_CONFIG, ...config };
  const client = makeFakeClient(upsList);
  const probe = makeFakeClient(upsList);
  const clientArgs: unknown[][] = [];
  const sm = makeFakeStateManager();
  // The adapter builds TWO clients: the live one, and a short-lived connection that verifies the
  // credentials with LOGIN and is closed again (upsd counts logins — see verifyCredentials).
  let built = 0;
  internal.makeClient = (...args: unknown[]) => {
    clientArgs.push(args);
    return (built++ === 0 ? client : probe) as unknown as NutClient;
  };
  internal.makeStateManager = () => sm as unknown as StateManager;
  return { adapter, internal, stub, client, probe, clientArgs, sm };
}

/**
 * onReady + simulate the client's connect callback (the unified loop firing).
 *
 * @param config Instance settings that replace the base config
 * @param upsList UPS list the fake client reports, defaults to one UPS
 */
async function setupConnected(config: Partial<typeof BASE_CONFIG> = {}, upsList?: UpsInfo[]): Promise<Setup> {
  const s = setup(config, upsList);
  await s.internal.onReady();
  expect(s.client.start).toHaveBeenCalledTimes(1);
  await s.internal.onConnected();
  return s;
}

/**
 * Let the (fake) server list these variables as writable and poll once, so the adapter knows them
 * the way it does in production before any write can arrive — a write to a variable LIST RW never
 * listed is refused without touching the wire.
 *
 * @param s the connected setup
 * @param names NUT variable names the server reports as RW
 */
async function withWritable(s: Setup, ...names: string[]): Promise<void> {
  s.client.listRw.mockResolvedValue(names.map(name => ({ name, value: "" })));
  await s.internal.poll();
  s.client.setVar.mockClear();
}

function logsOf(stub: StubSurface, level: string): string[] {
  return stub.logs.filter(l => l.level === level).map(l => l.msg);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onReady", () => {
  it("wires the client (onConnect/onFatal) and starts the retry loop", async () => {
    const { internal, client } = setup();
    await internal.onReady();
    expect(client.setOnConnect).toHaveBeenCalledTimes(1);
    expect(client.setOnFatal).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("clears the online indicators before the first connect (a hard kill leaves them stale)", async () => {
    const { internal, sm } = setup();
    await internal.onReady();
    expect(sm.markAllUnreachable).toHaveBeenCalledTimes(1);
  });

  it("clears the online indicators even when no host is configured", async () => {
    const { internal, sm } = setup({ host: "" });
    await internal.onReady();
    expect(sm.markAllUnreachable).toHaveBeenCalledTimes(1);
  });

  it("re-applies the manifest objects on every start, even without a host", async () => {
    // js-controller re-applies instanceObjects with preserve on common.name, so a renamed one
    // would reach fresh installs only. And it has to happen before the host check: a
    // misconfigured instance still deserves current texts.
    const { internal, sm } = setup({ host: "" });
    await internal.onReady();
    expect(sm.refreshInstanceObjects).toHaveBeenCalledTimes(1);
  });

  it("errors out without a host and never builds a client", async () => {
    const { internal, stub, client } = setup({ host: "   " });
    await internal.onReady();
    expect(logsOf(stub, "error").some(m => m.includes("host is required"))).toBe(true);
    expect(client.start).not.toHaveBeenCalled();
  });

  it("sets info.connection=false at startup", async () => {
    const { internal, stub } = setup();
    await internal.onReady();
    expect(stub.states.get("nut2.0.info.connection")).toEqual({ val: false, ack: true });
  });

  it("catches unexpected errors (onReady failed log, no throw)", async () => {
    const { internal, stub } = setup();
    internal.makeClient = () => {
      throw new Error("boom in factory");
    };
    await internal.onReady();
    expect(logsOf(stub, "error").some(m => m.includes("onReady failed: boom in factory"))).toBe(true);
  });
});

describe("onConnected — idempotent post-connect setup", () => {
  it("still arms the poll timer if post-connect setup fails on a live socket", async () => {
    const s = setup();
    await s.internal.onReady();
    s.sm.ensureUpsDevice.mockRejectedValue(new Error("DB write failed during discovery"));
    await s.internal.onConnected();
    expect(s.internal.pollTimer).toBeDefined();
    expect(logsOf(s.stub, "error").some(m => m.includes("Post-connect setup failed"))).toBe(true);
  });

  it("happy path: discovers, polls, arms the timer once and logs the started line", async () => {
    const { stub, client, sm } = await setupConnected();

    expect(client.listUps).toHaveBeenCalled();
    expect(sm.ensureUpsDevice).toHaveBeenCalledWith("ups0", "Main UPS");
    expect(sm.updateVariables).toHaveBeenCalled();
    expect(stub.intervals).toHaveLength(0);
    expect(stub.timeouts).toHaveLength(1);
    expect(stub.timeouts[0].ms).toBe(15000);
    expect(logsOf(stub, "info").some(m => m.includes("NUT adapter started — 1 UPS(es) on 10.0.0.3:3493"))).toBe(true);
    expect(stub.states.get("nut2.0.info.connection")).toEqual({ val: true, ack: true });
  });

  it("chains the next poll from the previous poll's completion (setTimeout, not setInterval)", async () => {
    const s = await setupConnected();
    expect(s.stub.intervals).toHaveLength(0);
    expect(s.stub.timeouts).toHaveLength(1);
    // Firing the timer runs a poll; only after it finishes is the next timer scheduled.
    s.stub.timeouts[0].cb();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.stub.timeouts.length).toBeGreaterThanOrEqual(2);
    expect(s.stub.timeouts[s.stub.timeouts.length - 1].ms).toBe(15000);
  });

  it("does not arm a second poll timer on reconnect (idempotent re-entry)", async () => {
    const { internal, stub } = await setupConnected();
    await internal.onConnected();
    expect(stub.timeouts).toHaveLength(1);
    expect(logsOf(stub, "info").some(m => m.includes("Reconnected to NUT server"))).toBe(true);
  });

  it("verifies ONCE per connection — one LOGIN on the first UPS covers the whole server", async () => {
    // upsd stores USERNAME/PASSWORD without checking; LOGIN is where it verifies them, and one
    // LOGIN answers for every UPS of that server. It happens on the throwaway connection, which
    // is closed right after — a lasting login would sit in upsd's shutdown counter.
    const { client, probe, stub, internal } = await setupConnected({ username: "admin", password: "secret" }, [
      { name: "ups0", description: "Main" },
      { name: "ups1", description: "Backup" },
    ]);
    expect(client.authenticate).toHaveBeenCalledWith("admin", "secret");
    expect(probe.login).toHaveBeenCalledTimes(1);
    expect(probe.login).toHaveBeenCalledWith("ups0");
    expect(probe.destroy).toHaveBeenCalledTimes(1);
    expect(internal.authenticated).toBe(true);
    const started = logsOf(stub, "info").find(m => m.includes("NUT adapter started"));
    expect(started).toContain("logged in as admin");
    expect(started).toContain("unencrypted");
  });

  it("reports the transport in the start line — TLS when the client upgraded", async () => {
    const s = setup({ useTls: true });
    s.client.isTls = true;
    await s.internal.onReady();
    await s.internal.onConnected();
    const started = logsOf(s.stub, "info").find(m => m.includes("NUT adapter started"));
    expect(started).toContain("TLS");
    expect(started).toContain("no credentials");
  });

  it("with credentials but no UPS to log in to: warns, does not claim a login, keeps running", async () => {
    const s = await setupConnected({ username: "admin", password: "secret" }, []);
    expect(s.client.login).not.toHaveBeenCalled();
    expect(s.internal.authenticated).toBe(false);
    expect(logsOf(s.stub, "warn").some(m => m.includes("nothing to log in to"))).toBe(true);
    expect(s.client.destroy).not.toHaveBeenCalled();
  });

  it("refused credentials → warning names both causes, but reading goes on", async () => {
    const s = setup({ username: "admin", password: "wrong" });
    s.probe.login.mockRejectedValue(new NutError("ACCESS-DENIED"));
    await s.internal.onReady();
    await s.internal.onConnected();

    const warn = logsOf(s.stub, "warn").find(m => m.includes("rejected the credentials"));
    expect(warn).toContain("wrong password");
    expect(warn).toContain("upsd.users");
    expect(logsOf(s.stub, "warn").some(m => m.includes("Reading UPS values continues"))).toBe(true);
    // Reading needs no login — the live connection stays up, the poll timer is armed and values land.
    expect(s.client.destroy).not.toHaveBeenCalled();
    expect(s.stub.timeouts.length).toBeGreaterThan(0);
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: true, ack: true });
    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(1, 1);
    // The instance stays GREEN: the connection to the NUT server is up and values are flowing.
    // An orange instance next to live data would tell the user two contradicting things.
    expect(s.stub.states.get("nut2.0.info.connection")).toEqual({ val: true, ack: true });
    // The credentials still went to the live connection: per-command rights work without LOGIN.
    expect(s.client.authenticate).toHaveBeenCalledWith("admin", "wrong");
    // And the verification connection is closed again, so upsd's login count stays clean.
    expect(s.probe.destroy).toHaveBeenCalledTimes(1);
  });

  it("warns once about refused credentials, then keeps it at debug until they work again", async () => {
    // Every reconnect re-checks. Warning each time would fill the log on a flaky link with a
    // standing configuration problem.
    const s = setup({ username: "u", password: "p" });
    s.probe.login.mockRejectedValue(new NutError("ACCESS-DENIED"));
    await s.internal.onReady();
    await s.internal.onConnected();
    await s.internal.onConnected();

    expect(logsOf(s.stub, "warn").filter(m => m.includes("rejected the credentials"))).toHaveLength(1);
    expect(logsOf(s.stub, "debug").some(m => m.includes("rejected the credentials"))).toBe(true);

    // Corrected — the recovery is worth one line, at the level the complaint went out.
    s.probe.login.mockResolvedValue(undefined);
    await s.internal.onConnected();
    expect(logsOf(s.stub, "info").some(m => m.includes("accepted the credentials"))).toBe(true);
  });

  it("verifies the credentials on a SEPARATE connection and closes it — never on the live one", async () => {
    // upsd only releases a login when the connection closes, and a primary upsmon waits for the
    // login count to drop before shutting down on battery. A monitoring client must not sit in it.
    const s = setup({ username: "u", password: "p" });
    await s.internal.onReady();
    await s.internal.onConnected();

    expect(s.probe.connect).toHaveBeenCalledTimes(1);
    expect(s.probe.login).toHaveBeenCalledWith("ups0");
    expect(s.probe.destroy).toHaveBeenCalledTimes(1);
    expect(s.client.login).not.toHaveBeenCalled();
    expect(s.client.authenticate).toHaveBeenCalledWith("u", "p");
  });

  it("the verification connection uses the SAME options as the live one", async () => {
    // Otherwise the probe takes a different route than production — a different source address on
    // a multi-homed host, or plaintext where the live connection is encrypted — and its verdict
    // would say nothing about the connection that actually carries the data.
    const s = setup({
      username: "u",
      password: "p",
      networkInterface: "10.0.0.9",
      useTls: true,
      tlsRejectUnauthorized: true,
      tlsCaFile: "/etc/nut/ca.pem",
      commandTimeout: 9,
    });
    await s.internal.onReady();
    await s.internal.onConnected();

    expect(s.clientArgs).toHaveLength(2);
    const [live, probeOpts] = s.clientArgs.map(args => args[2] as Record<string, unknown>);
    for (const key of ["localAddress", "commandTimeout", "useTls", "tlsRejectUnauthorized", "tlsCaFile"]) {
      expect(probeOpts[key]).toEqual(live[key]);
    }
    expect(probeOpts.localAddress).toBe("10.0.0.9");
    expect(probeOpts.commandTimeout).toBe(9000);
    expect(probeOpts.useTls).toBe(true);
  });

  it("an unload during discovery stops the verification connection from opening", async () => {
    // onUnload sweeps testClients before verifyCredentials would add the probe, and the injected
    // connect deadline refuses to arm during shutdown — the socket would hang until process exit.
    const s = setup({ username: "u", password: "p" });
    await s.internal.onReady();
    s.sm.ensureUpsDevice.mockImplementation(() => {
      s.internal.unloaded = true;
      return Promise.resolve();
    });

    await s.internal.onConnected();

    expect(s.probe.connect).not.toHaveBeenCalled();
  });

  it("no credentials configured → no verification connection at all", async () => {
    const s = setup();
    await s.internal.onReady();
    await s.internal.onConnected();

    expect(s.probe.connect).not.toHaveBeenCalled();
    expect(s.client.authenticate).not.toHaveBeenCalled();
  });

  it("creates command buttons when the credentials were SENT and enableCommands", async () => {
    const withCmd = await setupConnected({ username: "u", password: "p", enableCommands: true });
    expect(withCmd.sm.createCommandButtons).toHaveBeenCalledWith("ups0", [{ name: "beeper.enable" }]);

    const noCreds = await setupConnected({ enableCommands: true });
    expect(noCreds.sm.createCommandButtons).not.toHaveBeenCalled();
  });

  it("keeps the command buttons when LOGIN was refused — instcmds is a separate right", async () => {
    // upsd checks `instcmds` per command; a user with command rights but no `upsmon` line in
    // upsd.users cannot LOGIN and would lose every button if the buttons hung on the login.
    const s = setup({ username: "u", password: "p", enableCommands: true });
    s.probe.login.mockRejectedValue(new NutError("ACCESS-DENIED"));
    await s.internal.onReady();
    await s.internal.onConnected();

    expect(s.sm.createCommandButtons).toHaveBeenCalledWith("ups0", [{ name: "beeper.enable" }]);
  });

  it("a failing LIST CMD warns once per UPS — no buttons appear and the user must be able to see why", async () => {
    const s = setup({ username: "u", password: "p", enableCommands: true });
    s.client.listCmd.mockRejectedValue(new Error("no commands"));
    await s.internal.onReady();
    await s.internal.onConnected();
    // Not debug: the user enabled commands and gets nothing — exactly like the neighbouring
    // "commands enabled without credentials" case, which has always warned.
    expect(logsOf(s.stub, "warn").filter(m => m.includes("No command buttons for 'ups0'"))).toHaveLength(1);
    expect(logsOf(s.stub, "error")).toEqual([]);

    // …and only once: a driver that never supports LIST CMD must not repeat it on every reconnect.
    await s.internal.onConnected();
    expect(logsOf(s.stub, "warn").filter(m => m.includes("No command buttons for 'ups0'"))).toHaveLength(1);
    expect(logsOf(s.stub, "debug").some(m => m.includes("No command buttons for 'ups0'"))).toBe(true);
  });

  it("subscribes the wildcard exactly once and only when commands or SET VAR are enabled", async () => {
    // The notify trigger subscription from onReady is always there; the wildcard only for writes.
    const off = await setupConnected();
    expect(off.stub.subscriptions).toEqual(["notify"]);

    const on = await setupConnected({ enableSetVar: true });
    await on.internal.onConnected();
    expect(on.stub.subscriptions).toEqual(["notify", "*"]);
  });

  it("post-connect failure is caught and logged", async () => {
    const s = setup();
    s.client.listUps.mockRejectedValue(new Error("LIST UPS exploded"));
    await s.internal.onReady();
    await s.internal.onConnected();
    expect(logsOf(s.stub, "error").some(m => m.includes("Post-connect setup failed"))).toBe(true);
  });
});

describe("onConnectFatal", () => {
  it("logs the TLS guidance, destroys the client and goes yellow", async () => {
    const { internal, stub, client } = setup({ useTls: true });
    await internal.onReady();
    client.onFatal!(new NutError("FEATURE-NOT-CONFIGURED"));
    expect(logsOf(stub, "error").some(m => m.includes("TLS connection to NUT server 10.0.0.3:3493 failed"))).toBe(true);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("discover", () => {
  it("registers all UPSes and runs both cleanups with the known-name set", async () => {
    const s = await setupConnected({}, [
      { name: "ups0", description: "Main" },
      { name: "ups1", description: "Backup" },
    ]);
    expect([...s.internal.discoveredUps.keys()]).toEqual(["ups0", "ups1"]);
    // ONE pass over the object tree for both cleanups — it used to be two, each with its own
    // full read of the adapter namespace, on every (re)connect and every UPS-list change.
    expect(s.sm.pruneObjectTree).toHaveBeenCalledTimes(1);
    expect(s.sm.pruneObjectTree).toHaveBeenCalledWith(new Set(["ups0", "ups1"]));
  });

  it("prunes stale failedUps/enrichedUps markers when a UPS disappears (v0.4.2)", async () => {
    const s = await setupConnected();
    // Markers for a UPS that the next discover no longer returns.
    s.internal.failedUps.add("ghost");
    s.internal.enrichedUps.add("ghost");
    s.internal.failedUps.add("ups0");

    await s.internal.discover();

    expect(s.internal.failedUps.has("ghost")).toBe(false);
    expect(s.internal.enrichedUps.has("ghost")).toBe(false);
    // Markers of still-present UPSes survive.
    expect(s.internal.failedUps.has("ups0")).toBe(true);
  });
});

describe("UPS name sanitization", () => {
  it("sanitizes forbidden UPS names into object IDs but uses the real name for the NUT protocol", async () => {
    const s = await setupConnected({ enableCommands: true, enableSetVar: true, username: "u", password: "p" }, [
      { name: "my ups!", description: "Weird UPS" },
    ]);
    // Object tree + cleanup work on the sanitized ID; discoveredUps is keyed on it.
    expect([...s.internal.discoveredUps.keys()]).toEqual(["my_ups_"]);
    expect(s.sm.ensureUpsDevice).toHaveBeenCalledWith("my_ups_", "Weird UPS");
    expect(s.sm.pruneObjectTree).toHaveBeenCalledWith(new Set(["my_ups_"]));
    // NUT protocol calls (poll) use the real, unsanitized name.
    expect(s.client.listVar).toHaveBeenCalledWith("my ups!");
    // Command buttons: LIST CMD uses the real name, buttons are created under the sanitized ID.
    expect(s.client.listCmd).toHaveBeenCalledWith("my ups!");
    expect(s.sm.createCommandButtons).toHaveBeenCalledWith("my_ups_", [{ name: "beeper.enable" }]);
    // A command targeting the sanitized object ID must reach NUT with the real name.
    await s.internal.onStateChange("nut2.0.my_ups_.commands.beeper-enable", { val: true, ack: false });
    expect(s.client.instCmd).toHaveBeenCalledWith("my ups!", "beeper.enable");
  });

  it("disambiguates two UPS names that collapse to the same object ID and warns", async () => {
    const s = await setupConnected({}, [
      { name: "u.p", description: "A" },
      { name: "u p", description: "B" },
    ]);
    expect([...s.internal.discoveredUps.keys()]).toEqual(["u_p", "u_p-2"]);
    expect(logsOf(s.stub, "warn").some(m => m.includes("collides"))).toBe(true);
  });
});

describe("an absent NUT server reads as absent, not as a fault", () => {
  it("warns instead of erroring when the client reports the connection is down", async () => {
    // What the persistent client really hands the poll while it is reconnecting. This used to
    // classify as UNKNOWN and write `error: Poll failed: Connection closed` into the ioBroker log
    // on every NUT-server restart — right next to the warn line that already said the same thing.
    // The NETWORK branch, written for exactly this, was unreachable on the real path.
    const s = await setupConnected();
    s.client.listUps.mockRejectedValue(new NutConnectionError("Connection closed"));
    s.stub.logs.length = 0;

    await s.internal.poll();

    expect(logsOf(s.stub, "error")).toEqual([]);
    const warns = logsOf(s.stub, "warn").filter(m => m.includes("Cannot reach NUT server"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("Connection closed");
    expect(s.internal.lastErrorCode).toBe("NETWORK");

    // Repeats stay at debug — one line per outage, not one per poll.
    await s.internal.poll();
    expect(logsOf(s.stub, "warn").filter(m => m.includes("Cannot reach NUT server"))).toHaveLength(1);
  });

  it("treats a command timeout the same way — the server is not answering, that is not our fault", async () => {
    const s = await setupConnected();
    s.client.listUps.mockRejectedValue(new NutTimeoutError("LIST UPS"));
    s.stub.logs.length = 0;
    await s.internal.poll();
    expect(logsOf(s.stub, "error")).toEqual([]);
    expect(logsOf(s.stub, "warn").some(m => m.includes("Cannot reach NUT server"))).toBe(true);
  });

  it("still calls a genuinely unexpected failure an error", async () => {
    const s = await setupConnected();
    s.client.listUps.mockRejectedValue(new Error("something nobody predicted"));
    s.stub.logs.length = 0;
    await s.internal.poll();
    expect(logsOf(s.stub, "error").some(m => m.includes("Poll failed"))).toBe(true);
  });

  it("says nothing at all while shutting down", async () => {
    // onUnload tears the client down under a poll that may still be in flight; whatever it then
    // raises is our own doing. Stopping an instance must never warn about itself.
    const s = await setupConnected();
    s.client.listUps.mockRejectedValue(new NutConnectionError("Client cancelled"));
    s.internal.unloaded = true;
    s.stub.logs.length = 0;

    await s.internal.poll();

    expect(logsOf(s.stub, "error")).toEqual([]);
    expect(logsOf(s.stub, "warn")).toEqual([]);
    expect(logsOf(s.stub, "debug").some(m => m.includes("Poll aborted by shutdown"))).toBe(true);
  });
});

describe("classifyError", () => {
  it("maps NutError to its code, network codes to NETWORK, timeouts to TIMEOUT", () => {
    const { internal } = setup();
    expect(internal.classifyError(new NutError("DATA-STALE"))).toBe("DATA-STALE");
    expect(internal.classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("NETWORK");
    expect(internal.classifyError(Object.assign(new Error("x"), { code: "EHOSTUNREACH" }))).toBe("NETWORK");
    expect(internal.classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("TIMEOUT");
    // By TYPE, not by wording: the message is free to change without moving the error into
    // another bucket, and a test can no longer pin the very string being matched.
    expect(internal.classifyError(new NutTimeoutError("LIST UPS"))).toBe("TIMEOUT");
    // What the persistent client actually hands the poll when the server is away. This used to
    // land in UNKNOWN and paint the log red on every NUT-server restart.
    expect(internal.classifyError(new NutConnectionError("Not connected"))).toBe("NETWORK");
    expect(internal.classifyError(new NutConnectionError("Connection closed"))).toBe("NETWORK");
    expect(internal.classifyError(Object.assign(new Error("x"), { code: "EWEIRD" }))).toBe("EWEIRD");
    expect(internal.classifyError(new Error("plain"))).toBe("UNKNOWN");
    // A message that merely READS like a timeout no longer counts as one.
    expect(internal.classifyError(new Error("NUT command timed out: LIST UPS"))).toBe("UNKNOWN");
    expect(internal.classifyError("not an error")).toBe("UNKNOWN");
  });
});

describe("poll", () => {
  it("applies a valid RANGE bound but ignores a non-decimal one (strict parse, not parseFloat)", async () => {
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.client.listEnum.mockResolvedValue([]);
    s.client.listRange.mockResolvedValue([{ min: "50abc", max: "600" }]);
    s.internal.enrichedUps.clear();
    s.sm.enrichStateMetadata.mockClear();
    await s.internal.poll();
    // `min` is explicitly null: the server offered no usable lower bound, and a merge can never
    // remove a key later — a stale bound would otherwise outlive the driver that reported it.
    expect(s.sm.enrichStateMetadata).toHaveBeenCalledWith(expect.any(String), { min: null, max: 600 });
  });

  it("clears a value list the server no longer offers — but only when the catalog is silent too", async () => {
    // A merge can never remove a key, so a list nobody reports any more would stay selectable in
    // the admin forever. The adapter's own catalog is the better answer for the many drivers that
    // simply do not implement LIST ENUM, so it wins where it has an entry.
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRange.mockResolvedValue([]);
    s.client.listEnum.mockResolvedValue([]);

    // ups.delay.shutdown has no catalog entry → the empty answer must clear the list.
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.internal.enrichedUps.clear();
    s.sm.enrichStateMetadata.mockClear();
    await s.internal.poll();
    expect(s.sm.enrichStateMetadata).toHaveBeenCalledWith(expect.any(String), { states: null });

    // ups.beeper.status HAS one (enabled/disabled/muted) → keep it, do not wipe it.
    s.client.listRw.mockResolvedValue([{ name: "ups.beeper.status", value: "enabled" }]);
    s.internal.enrichedUps.clear();
    s.sm.enrichStateMetadata.mockClear();
    await s.internal.poll();
    expect(s.sm.enrichStateMetadata).not.toHaveBeenCalledWith(expect.any(String), { states: null });
  });

  it("clears stale bounds when the server stops reporting a RANGE", async () => {
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.client.listEnum.mockResolvedValue([]);
    s.client.listRange.mockResolvedValue([]);
    s.internal.enrichedUps.clear();
    s.sm.enrichStateMetadata.mockClear();
    await s.internal.poll();
    expect(s.sm.enrichStateMetadata).toHaveBeenCalledWith(expect.any(String), { min: null, max: null });
  });

  it("does not query LIST RW or mark variables writable while SET VAR is disabled", async () => {
    const s = await setupConnected({ enableSetVar: false });
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.client.listRw.mockClear();
    s.sm.updateVariables.mockClear();
    await s.internal.poll();
    expect(s.client.listRw).not.toHaveBeenCalled();
    const lastCall = s.sm.updateVariables.mock.calls.at(-1);
    expect(lastCall?.[2]).toEqual(new Set());
  });

  it("updates variables, device name, status flags and reachable per UPS", async () => {
    const s = await setupConnected();
    s.sm.updateVariables.mockClear();
    await s.internal.poll();

    expect(s.sm.updateVariables).toHaveBeenCalledWith(
      "ups0",
      expect.arrayContaining([expect.objectContaining({ name: "ups.status" })]),
      new Set(),
    );
    expect(s.sm.updateStatusFlags).toHaveBeenCalledWith("ups0", "OL", undefined);
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: true, ack: true });
    expect(s.stub.states.get("nut2.0.info.connection")).toEqual({ val: true, ack: true });
  });

  it("passes battery.charger.status through to the status flags", async () => {
    const s = await setupConnected();
    s.client.listVar.mockResolvedValue([
      { name: "ups.status", value: "OL" },
      { name: "battery.charger.status", value: "charging" },
    ]);
    await s.internal.poll();
    expect(s.sm.updateStatusFlags).toHaveBeenCalledWith("ups0", "OL", "charging");
  });

  it("skips when the previous poll is still running (in-flight guard)", async () => {
    const s = await setupConnected();
    let release: () => void = () => {};
    s.client.listVar.mockImplementation(
      () => new Promise(resolve => (release = () => resolve([{ name: "ups.status", value: "OL" }]))),
    );
    const p1 = s.internal.poll();
    const p2 = s.internal.poll();
    // The poll checks LIST UPS before LIST VAR — release only once it really is inside LIST VAR.
    await vi.waitFor(() => expect(s.client.listVar).toHaveBeenCalled());
    release();
    await Promise.all([p1, p2]);
    expect(logsOf(s.stub, "debug").some(m => m.includes("previous poll still running"))).toBe(true);
  });

  it("LIST RW failure is non-critical — poll continues with no writable vars", async () => {
    const s = await setupConnected({ enableSetVar: true, username: "nut", password: "secret" });
    s.client.listRw.mockRejectedValue(new Error("RW unsupported"));
    s.sm.updateVariables.mockClear();
    await s.internal.poll();
    expect(s.sm.updateVariables).toHaveBeenCalledWith("ups0", expect.anything(), new Set());
    expect(logsOf(s.stub, "warn")).toEqual([]);
  });

  it("per-UPS failure: reachable=false, warn once, debug on repeat, recovery info", async () => {
    const s = await setupConnected();
    s.client.listVar.mockRejectedValue(new Error("UPS gone"));

    await s.internal.poll();
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: false, ack: true });
    expect(logsOf(s.stub, "warn").filter(m => m.includes("Failed to poll UPS 'ups0'"))).toHaveLength(1);

    await s.internal.poll();
    // Repeat goes to debug — still exactly ONE warn.
    expect(logsOf(s.stub, "warn").filter(m => m.includes("Failed to poll UPS 'ups0'"))).toHaveLength(1);

    s.client.listVar.mockResolvedValue([{ name: "ups.status", value: "OL" }]);
    await s.internal.poll();
    expect(logsOf(s.stub, "info").some(m => m.includes("UPS 'ups0' recovered"))).toBe(true);
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: true, ack: true });
  });

  it("DATA-STALE gets its own friendly warning (states kept)", async () => {
    const s = await setupConnected();
    s.client.listVar.mockRejectedValue(new NutError("DATA-STALE"));
    await s.internal.poll();
    expect(logsOf(s.stub, "warn").some(m => m.includes("driver reports stale data"))).toBe(true);
  });

  it("enriches enum/range metadata exactly once per connection", async () => {
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.client.listEnum.mockResolvedValue(["20", "30"]);
    s.client.listRange.mockResolvedValue([{ min: "10", max: "300" }]);
    s.internal.enrichedUps.clear();
    s.sm.enrichStateMetadata.mockClear();

    await s.internal.poll();
    const callsAfterFirst = s.sm.enrichStateMetadata.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(s.sm.enrichStateMetadata).toHaveBeenCalledWith("ups0.ups.delay-shutdown", {
      states: { 20: "20", 30: "30" },
    });
    expect(s.sm.enrichStateMetadata).toHaveBeenCalledWith("ups0.ups.delay-shutdown", { min: 10, max: 300 });

    await s.internal.poll();
    expect(s.sm.enrichStateMetadata.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not put yes/no enum states on a boolean writable var (they are booleans, not enums)", async () => {
    // A writable yes/no var (ups.start.auto) is a boolean state; its LIST ENUM yes/no must not be
    // pushed as common.states — a string-keyed {yes,no} map is meaningless on a boolean.
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRw.mockResolvedValue([{ name: "ups.start.auto", value: "yes" }]);
    s.client.listEnum.mockResolvedValue(["yes", "no"]);
    s.client.listRange.mockResolvedValue([]);
    s.internal.enrichedUps.clear();
    s.sm.enrichStateMetadata.mockClear();

    await s.internal.poll();
    expect(s.sm.enrichStateMetadata).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ states: expect.anything() }),
    );
  });

  it("gates info.connection on the client connection, not on the loop having run", async () => {
    const s = await setupConnected();
    s.client.isConnected = false; // server dropped; per-UPS errors are swallowed in the loop
    s.client.listVar.mockRejectedValue(new Error("conn lost"));
    await s.internal.poll();
    expect(s.stub.states.get("nut2.0.info.connection")).toEqual({ val: false, ack: true });
  });

  it("whole-poll failure: classify, warn once for NETWORK, restore info on recovery", async () => {
    const s = await setupConnected();
    // Force a failure OUTSIDE the per-UPS loop: setStateChangedAsync for info.connection throws…
    // simpler: make discoveredUps iteration throw via a poisoned client on the outer await.
    s.internal.discoveredUps.clear();
    const poison = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const stubAdapter = s.adapter as unknown as {
      setStateChangedAsync: (id: string, state: { val: unknown; ack?: boolean }) => Promise<void>;
    };
    const original = stubAdapter.setStateChangedAsync.bind(stubAdapter);
    let shouldThrow = true;
    stubAdapter.setStateChangedAsync = async (id, state) => {
      // Poison only the SUCCESS-path write (val=true) — the catch handler's
      // val=false write must go through, like a broker that fails the call
      // because the underlying connection is gone.
      if (shouldThrow && id.includes("info.connection") && state.val === true) {
        throw poison;
      }
      return original(id, state);
    };

    await s.internal.poll();
    expect(logsOf(s.stub, "warn").some(m => m.includes("Cannot reach NUT server"))).toBe(true);
    expect(s.internal.lastErrorCode).toBe("NETWORK");

    await s.internal.poll();
    // Repeat of the same class → debug, no second warn.
    expect(logsOf(s.stub, "warn").filter(m => m.includes("Cannot reach NUT server"))).toHaveLength(1);

    shouldThrow = false;
    await s.internal.poll();
    expect(logsOf(s.stub, "info").some(m => m === "Connection restored")).toBe(true);
    expect(s.internal.lastErrorCode).toBe("");
  });
});

describe("UPS list changes on the NUT server at runtime", () => {
  it("an unchanged list runs no discovery and creates nothing again", async () => {
    const s = await setupConnected();
    s.sm.ensureUpsDevice.mockClear();
    s.sm.pruneObjectTree.mockClear();
    await s.internal.poll();
    await s.internal.poll();
    expect(s.sm.ensureUpsDevice).not.toHaveBeenCalled();
    expect(s.sm.pruneObjectTree).not.toHaveBeenCalled();
    expect(logsOf(s.stub, "info").some(m => m.includes("UPS list on the NUT server changed"))).toBe(false);
  });

  it("a UPS added on the server appears on the next poll, with its command buttons", async () => {
    const s = await setupConnected({ enableCommands: true, username: "u", password: "p" });
    s.sm.createCommandButtons.mockClear();
    s.client.listUps.mockResolvedValue([
      { name: "ups0", description: "Main UPS" },
      { name: "ups1", description: "New UPS" },
    ]);
    await s.internal.poll();
    expect([...s.internal.discoveredUps.keys()]).toEqual(["ups0", "ups1"]);
    expect(s.sm.ensureUpsDevice).toHaveBeenCalledWith("ups1", "New UPS");
    expect(s.sm.createCommandButtons).toHaveBeenCalledWith("ups1", expect.anything());
    expect(s.stub.states.get("nut2.0.ups1.info.reachable")).toEqual({ val: true, ack: true });
    expect(logsOf(s.stub, "info").some(m => m.includes("UPS list on the NUT server changed: ups0, ups1"))).toBe(true);
  });

  it("a UPS removed on the server is cleaned up on the next poll", async () => {
    const s = await setupConnected({}, [
      { name: "ups0", description: "Main UPS" },
      { name: "ups1", description: "Second UPS" },
    ]);
    s.client.listUps.mockResolvedValue([{ name: "ups0", description: "Main UPS" }]);
    await s.internal.poll();
    expect([...s.internal.discoveredUps.keys()]).toEqual(["ups0"]);
    expect(s.sm.pruneObjectTree).toHaveBeenLastCalledWith(new Set(["ups0"]));
    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(1, 1);
  });

  it("a LIST UPS failure fails the poll as a whole (no half-updated tree)", async () => {
    const s = await setupConnected();
    s.client.listUps.mockRejectedValue(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    await s.internal.poll();
    expect(s.client.listVar).toHaveBeenCalledTimes(1); // only the initial poll in setupConnected
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: false, ack: true });
  });
});

describe("onStateChange — command and SET VAR gates", () => {
  it("ignores acked/null states and unknown UPS ids", async () => {
    const s = await setupConnected({ enableCommands: true, enableSetVar: true });
    await s.internal.onStateChange("nut2.0.ups0.commands.beeper-enable", { val: true, ack: true });
    await s.internal.onStateChange("nut2.0.ups0.commands.beeper-enable", null);
    await s.internal.onStateChange("nut2.0.ghost.commands.beeper-enable", { val: true, ack: false });
    expect(s.client.instCmd).not.toHaveBeenCalled();
    // A state of a UPS that is gone (renamed, unplugged, removed from the NUT
    // server) is a normal event — it must stay a debug line. An error entry
    // sends whoever reads the log hunting a fault that does not exist.
    expect(logsOf(s.stub, "error")).toEqual([]);
    expect(logsOf(s.stub, "debug").some(m => m.includes("unknown UPS"))).toBe(true);
  });

  it("executes a command (dashes→dots), resets the button and logs", async () => {
    const s = await setupConnected({ enableCommands: true });
    await s.internal.onStateChange("nut2.0.ups0.commands.test-battery-start", { val: true, ack: false });
    expect(s.client.instCmd).toHaveBeenCalledWith("ups0", "test.battery.start");
    expect(s.stub.states.get("nut2.0.ups0.commands.test-battery-start")).toEqual({ val: false, ack: true });
    expect(logsOf(s.stub, "info").some(m => m.includes("Command executed: test.battery.start"))).toBe(true);
  });

  it("blocks commands when enableCommands is off", async () => {
    const s = await setupConnected({ enableCommands: false });
    await s.internal.onStateChange("nut2.0.ups0.commands.load-off", { val: true, ack: false });
    expect(s.client.instCmd).not.toHaveBeenCalled();
    expect(logsOf(s.stub, "warn").some(m => m.includes("Command blocked"))).toBe(true);
  });

  it("a failing command logs an error and STILL resets the button", async () => {
    const s = await setupConnected({ enableCommands: true });
    s.client.instCmd.mockRejectedValue(new NutError("INSTCMD-FAILED"));
    await s.internal.onStateChange("nut2.0.ups0.commands.load-off", { val: true, ack: false });
    expect(logsOf(s.stub, "error").some(m => m.includes("Command failed: load.off"))).toBe(true);
    expect(s.stub.states.get("nut2.0.ups0.commands.load-off")).toEqual({ val: false, ack: true });
  });

  it("SET VAR: reconstructs the variable name (dashes→dots) and acks on success", async () => {
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "ups.delay.shutdown");
    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: 30, ack: false });
    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "ups.delay.shutdown", "30");
    expect(s.stub.states.get("nut2.0.ups0.ups.delay-shutdown")).toEqual({ val: 30, ack: true });
  });

  it("SET VAR: uses the stored NUT name so a literal dash survives (three-phase)", async () => {
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "input.L1-L2.voltage");
    s.sm.nutNameForState.mockReturnValue("input.L1-L2.voltage");
    await s.internal.onStateChange("nut2.0.ups0.input.L1-L2-voltage", { val: 247, ack: false });
    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "input.L1-L2.voltage", "247");
  });

  it("SET VAR: writes a yes/no boolean back as 'yes'/'no', not 'true'/'false'", async () => {
    // ups.start.auto/.battery/.reboot are RW yes/no variables on many drivers (mge-hid, delta,
    // eaton, voltronic) → detectType makes them boolean switches. Writing must translate the
    // boolean to the yes/no token NUT expects; String(true) = "true" would be rejected.
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "ups.start.auto");
    s.sm.nutNameForState.mockReturnValue("ups.start.auto");

    await s.internal.onStateChange("nut2.0.ups0.ups.start-auto", { val: false, ack: false });
    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "ups.start.auto", "no");

    s.client.setVar.mockClear();
    await s.internal.onStateChange("nut2.0.ups0.ups.start-auto", { val: true, ack: false });
    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "ups.start.auto", "yes");
  });

  it("INSTCMD: uses the stored NUT name rather than reversing the id", async () => {
    const s = await setupConnected({ enableCommands: true });
    s.sm.nutNameForState.mockReturnValue("beeper.disable");
    await s.internal.onStateChange("nut2.0.ups0.commands.beeper-mute", { val: true, ack: false });
    expect(s.client.instCmd).toHaveBeenCalledWith("ups0", "beeper.disable");
  });

  it("blocks SET VAR when enableSetVar is off", async () => {
    const s = await setupConnected({ enableSetVar: false });
    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: 30, ack: false });
    expect(s.client.setVar).not.toHaveBeenCalled();
    expect(logsOf(s.stub, "warn").some(m => m.includes("SET VAR blocked"))).toBe(true);
  });

  it("a failing SET VAR logs an error and does NOT ack", async () => {
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "ups.delay.shutdown");
    s.client.setVar.mockRejectedValue(new NutError("SET-FAILED"));
    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: 30, ack: false });
    expect(logsOf(s.stub, "error").some(m => m.includes("SET VAR failed"))).toBe(true);
    expect(s.stub.states.has("nut2.0.ups0.ups.delay-shutdown")).toBe(false);
  });

  it("ignores writes to the adapter-owned info/status channels instead of trying SET VAR", async () => {
    const s = await setupConnected({ enableSetVar: true, enableCommands: true });
    await s.internal.onStateChange("nut2.0.ups0.info.notify", { val: "ONBATT", ack: false });
    await s.internal.onStateChange("nut2.0.ups0.info.reachable", { val: true, ack: false });
    await s.internal.onStateChange("nut2.0.ups0.status.online", { val: false, ack: false });
    expect(s.client.setVar).not.toHaveBeenCalled();
    expect(s.client.instCmd).not.toHaveBeenCalled();
    expect(logsOf(s.stub, "error")).toEqual([]);
    expect(logsOf(s.stub, "debug").filter(m => m.includes("adapter-owned"))).toHaveLength(3);
  });

  it("SET VAR: a null or object value never reaches the wire (warn, no write, no ack)", async () => {
    const s = await setupConnected({ enableSetVar: true });
    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: null, ack: false });
    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: { a: 1 }, ack: false });
    expect(s.client.setVar).not.toHaveBeenCalled();
    expect(s.stub.states.get("nut2.0.ups0.ups.delay-shutdown")).toBeUndefined();
    const warns = logsOf(s.stub, "warn").filter(m => m.includes("SET VAR ignored"));
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("null");
  });

  it("ignores writes with an unexpected id structure", async () => {
    const s = await setupConnected({ enableSetVar: true });
    // A single segment is never a data point of this adapter.
    await s.internal.onStateChange("nut2.0.shallow", { val: 1, ack: false });
    // Two segments only count when the state manager knows the NUT name behind them — a hand-made
    // object under the namespace has none, and must not turn into a SET VAR with a bogus name.
    s.sm.nutNameForState.mockReturnValue(undefined);
    await s.internal.onStateChange("nut2.0.ups0.HANDMADE", { val: 1, ack: false });
    expect(s.client.setVar).not.toHaveBeenCalled();
  });

  it("writes a DOTLESS NUT variable — created writable, so it has to be writable", async () => {
    // The two halves used to disagree: updateVariables creates a dotless variable directly under
    // the device (`ups0.SOMEVAR`, two segments) with write: true, while onStateChange rejected
    // everything below three segments. The user saw a writable data point that swallowed every
    // write with nothing but a debug line. The lossless reverse lookup already had the answer.
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "SOMEVAR");
    s.sm.nutNameForState.mockReturnValue("SOMEVAR");
    await s.internal.onStateChange("nut2.0.ups0.SOMEVAR", { val: 42, ack: false });
    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "SOMEVAR", "42");
  });

  it("does not mistake a dotless variable for an adapter-owned channel", async () => {
    // At two segments parts[1] IS the variable name — testing it against "info"/"status"/
    // "commands" there would reject a legitimate variable (and the state manager already keeps
    // such a name out of the tree in the first place).
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "infotext");
    s.sm.nutNameForState.mockReturnValue("infotext");
    await s.internal.onStateChange("nut2.0.ups0.infotext", { val: "x", ack: false });
    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "infotext", "x");
  });
});

describe("notify trigger — the upsmon doorbell", () => {
  it("subscribes the trigger in onReady, even on a misconfigured instance", async () => {
    // The doorbell must exist before (and independent of) any successful connect —
    // with the NUT server down, a write still has to be received and recorded.
    const { internal, stub } = setup({ host: "" });
    await internal.onReady();
    expect(stub.subscriptions).toContain("notify");
  });

  it("records the event on the matched UPS, acks the trigger and polls", async () => {
    const s = await setupConnected();
    s.client.listVar.mockClear();

    await s.internal.onStateChange("nut2.0.notify", { val: "ONBATT ups0", ack: false });

    expect(s.stub.states.get("nut2.0.ups0.info.notify")).toEqual({ val: "ONBATT", ack: true });
    expect(s.stub.states.get("nut2.0.notify")).toEqual({ val: "ONBATT ups0", ack: true });
    expect(s.client.listVar).toHaveBeenCalled();
    expect(logsOf(s.stub, "info").some(m => m.includes("upsmon event 'ONBATT'"))).toBe(true);
  });

  it("matches the real NUT name (with @host) even when the object ID is sanitized", async () => {
    const s = await setupConnected({}, [{ name: "my ups!", description: "Weird UPS" }]);

    await s.internal.onStateChange("nut2.0.notify", { val: "LOWBATT my ups!@nas.local", ack: false });

    expect(s.stub.states.get("nut2.0.my_ups_.info.notify")).toEqual({ val: "LOWBATT", ack: true });
  });

  it("matches the sanitized object ID as well", async () => {
    const s = await setupConnected({}, [{ name: "my ups!", description: "Weird UPS" }]);

    await s.internal.onStateChange("nut2.0.notify", { val: "LOWBATT my_ups_", ack: false });

    expect(s.stub.states.get("nut2.0.my_ups_.info.notify")).toEqual({ val: "LOWBATT", ack: true });
  });

  it("unknown UPS reference: polls everything, warns once, acks — no device write", async () => {
    const s = await setupConnected();
    s.client.listVar.mockClear();

    await s.internal.onStateChange("nut2.0.notify", { val: "ONBATT ghost", ack: false });
    await s.internal.onStateChange("nut2.0.notify", { val: "ONLINE ghost", ack: false });

    expect(s.client.listVar).toHaveBeenCalled();
    expect(s.stub.states.has("nut2.0.ghost.info.notify")).toBe(false);
    expect(s.stub.states.get("nut2.0.notify")).toEqual({ val: "ONLINE ghost", ack: true });
    // Warn once per unknown name — the repeat goes to debug.
    expect(logsOf(s.stub, "warn").filter(m => m.includes("unknown UPS 'ghost'"))).toHaveLength(1);
  });

  it("an empty write is a bare manual refresh: poll yes, event no, info-noise no", async () => {
    const s = await setupConnected();
    s.client.listVar.mockClear();
    const infoBefore = logsOf(s.stub, "info").length;

    await s.internal.onStateChange("nut2.0.notify", { val: "", ack: false });

    expect(s.client.listVar).toHaveBeenCalled();
    expect(s.stub.states.get("nut2.0.notify")).toEqual({ val: "", ack: true });
    expect(s.stub.states.has("nut2.0.ups0.info.notify")).toBe(false);
    expect(logsOf(s.stub, "info").length).toBe(infoBefore);
  });

  it("acks the trigger with the normalised text, not the raw write", async () => {
    const s = await setupConnected();
    await s.internal.onStateChange("nut2.0.notify", { val: "  ONBATT   ups0@nas  ", ack: false });
    expect(s.stub.states.get("nut2.0.notify")).toEqual({ val: "ONBATT   ups0@nas", ack: true });
    // An object pushed through the REST API is no trigger value — the echo is an empty string,
    // never "[object Object]" and never the object itself in a string state.
    await s.internal.onStateChange("nut2.0.notify", { val: { evil: 1 }, ack: false });
    expect(s.stub.states.get("nut2.0.notify")).toEqual({ val: "", ack: true });
    const blob = "Y".repeat(600);
    await s.internal.onStateChange("nut2.0.notify", { val: blob, ack: false });
    expect((s.stub.states.get("nut2.0.notify")!.val as string).length).toBe(200);
  });

  it("ignores its own ack echo", async () => {
    const s = await setupConnected();
    s.client.listVar.mockClear();

    await s.internal.onStateChange("nut2.0.notify", { val: "ONBATT", ack: true });

    expect(s.client.listVar).not.toHaveBeenCalled();
  });

  it("an event during a running poll queues exactly one follow-up poll", async () => {
    const s = await setupConnected();
    const resolvers: Array<(vars: NutVariable[]) => void> = [];
    s.client.listVar.mockImplementation(() => new Promise<NutVariable[]>(res => resolvers.push(res)));
    s.client.listVar.mockClear();

    const running = s.internal.poll();
    await vi.waitFor(() => expect(s.client.listVar).toHaveBeenCalledTimes(1));
    // The poll is now stuck inside LIST VAR; the doorbell rings twice meanwhile.
    const n1 = s.internal.onStateChange("nut2.0.notify", { val: "ONBATT ups0", ack: false });
    const n2 = s.internal.onStateChange("nut2.0.notify", { val: "LOWBATT ups0", ack: false });
    expect(s.client.listVar).toHaveBeenCalledTimes(1);

    resolvers[0]([{ name: "ups.status", value: "OB" }]);
    await running;
    await Promise.all([n1, n2]);
    // Exactly ONE follow-up poll for both rings together.
    await vi.waitFor(() => expect(s.client.listVar).toHaveBeenCalledTimes(2));
    resolvers[1]([{ name: "ups.status", value: "OB LB" }]);
    // Both events were still recorded individually.
    expect(s.stub.states.get("nut2.0.ups0.info.notify")).toEqual({ val: "LOWBATT", ack: true });
  });

  it("a follow-up queued during a poll is dropped when the adapter unloads before that poll ends", async () => {
    const s = await setupConnected();
    const resolvers: Array<(vars: NutVariable[]) => void> = [];
    s.client.listVar.mockImplementation(() => new Promise<NutVariable[]>(res => resolvers.push(res)));
    s.client.listVar.mockClear();
    s.client.listUps.mockClear();

    const running = s.internal.poll();
    await vi.waitFor(() => expect(s.client.listVar).toHaveBeenCalledTimes(1));
    const ring = s.internal.onStateChange("nut2.0.notify", { val: "SHUTDOWN ups0", ack: false });
    await ring; // queued as a follow-up — the poll is still inside LIST VAR
    // The host stops the instance while that poll is still running.
    const callback = vi.fn();
    s.internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    const listUpsCalls = s.client.listUps.mock.calls.length;

    resolvers[0]([{ name: "ups.status", value: "OB" }]);
    await running;
    await new Promise(r => setImmediate(r));
    // No second poll after the shutdown: it would run against the torn-down client and write
    // states after the host was already told "done".
    expect(s.client.listUps).toHaveBeenCalledTimes(listUpsCalls);
    expect(s.client.listVar).toHaveBeenCalledTimes(1);
  });

  it("without a client (server never reached) the event is still recorded and acked", async () => {
    const { internal, stub } = setup({ host: "" });
    await internal.onReady();
    const errorsFromSetup = logsOf(stub, "error").length; // the legitimate "host is required"

    await internal.onStateChange("nut2.0.notify", { val: "SHUTDOWN", ack: false });

    expect(stub.states.get("nut2.0.notify")).toEqual({ val: "SHUTDOWN", ack: true });
    expect(logsOf(stub, "error").length).toBe(errorsFromSetup);
  });

  it("records the event and acks BEFORE polling, so a dying NUT host cannot swallow it", async () => {
    const s = await setupConnected();
    s.client.listVar.mockRejectedValue(new Error("host is going down"));

    await s.internal.onStateChange("nut2.0.notify", { val: "SHUTDOWN ups0", ack: false });

    expect(s.stub.states.get("nut2.0.ups0.info.notify")).toEqual({ val: "SHUTDOWN", ack: true });
    expect(s.stub.states.get("nut2.0.notify")).toEqual({ val: "SHUTDOWN ups0", ack: true });
  });

  it("the unknown-name warn-dedup set stays bounded under a flood of distinct names", async () => {
    // The set is fed by an external write (upsmon / anyone with write access). Without a cap it
    // would grow one entry per distinct unknown UPS name for the whole adapter lifetime.
    const s = await setupConnected();
    for (let i = 0; i < 300; i++) {
      await s.internal.onStateChange("nut2.0.notify", { val: `ONBATT ghost-${i}`, ack: false });
    }
    expect(s.internal.warnedNotifyRefs.size).toBeLessThanOrEqual(100);
  });
});

describe("onUnload", () => {
  it("clears the timer, shuts down gracefully when authenticated, destroys test clients", async () => {
    const s = await setupConnected({ username: "u", password: "p" });
    const testClient = { destroy: vi.fn() };
    s.internal.testClients.add(testClient);
    const callback = vi.fn();

    s.internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(s.client.shutdown).toHaveBeenCalledTimes(1); // graceful LOGOUT path
    expect(s.client.destroy).not.toHaveBeenCalled();
    expect(testClient.destroy).toHaveBeenCalledTimes(1);
    expect(s.internal.testClients.size).toBe(0);
    expect(s.stub.states.get("nut2.0.info.connection")).toEqual({ val: false, ack: true });
  });

  it("marks every discovered UPS unreachable so a stopped adapter stops showing it online", async () => {
    const s = await setupConnected();
    s.stub.states.set("nut2.0.ups0.info.reachable", { val: true, ack: true });

    s.internal.onUnload(vi.fn());

    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: false, ack: true });
  });

  it("says goodbye gracefully even without credentials", async () => {
    // The live connection never carries a LOGIN any more, so the teardown must not depend on one:
    // upsd answers LOGOUT with "OK Goodbye" either way, and the half-close flushes the last write.
    const s = await setupConnected();
    const callback = vi.fn();
    s.internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(s.client.shutdown).toHaveBeenCalledTimes(1);
    expect(s.client.destroy).not.toHaveBeenCalled();
  });

  it("calls the callback even when teardown throws", async () => {
    const s = await setupConnected();
    s.client.shutdown.mockImplementation(() => {
      throw new Error("teardown exploded");
    });
    const callback = vi.fn();
    s.internal.onUnload(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("UPS summary through the whole life cycle", () => {
  it("reports how many UPSes answered after a poll", async () => {
    const s = await setupConnected({}, [
      { name: "ups0", description: "One" },
      { name: "ups1", description: "Two" },
    ]);
    s.sm.writeUpsSummary.mockClear();

    await s.internal.poll();

    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(2, 2);
  });

  it("counts a UPS that stopped answering as not reachable", async () => {
    const s = await setupConnected({}, [
      { name: "ups0", description: "One" },
      { name: "ups1", description: "Two" },
    ]);
    s.client.listVar.mockImplementation((ups: string) => {
      if (ups === "ups1") {
        return Promise.reject(new Error("no answer"));
      }
      return Promise.resolve([{ name: "ups.status", value: "OL" }]);
    });
    s.sm.writeUpsSummary.mockClear();

    await s.internal.poll();

    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(2, 1);
  });

  it("drops the summary to zero when the whole poll fails", async () => {
    const s = await setupConnected();
    s.client.listVar.mockRejectedValue(new Error("server gone"));
    s.client.isConnected = false;
    s.sm.writeUpsSummary.mockClear();

    await s.internal.poll();

    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(1, 0);
  });

  it("takes the summary down when the adapter stops", async () => {
    const s = await setupConnected();
    const callback = vi.fn();

    s.internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(s.stub.states.get("nut2.0.info.upsReachable")).toEqual({ val: 0, ack: true });
    expect(s.stub.states.get("nut2.0.info.allUpsReachable")).toEqual({ val: false, ack: true });
    // How many UPSes exist did not change just because the adapter is off.
    expect(s.stub.states.has("nut2.0.info.upsTotal")).toBe(false);
  });
});

describe("shutdown contract", () => {
  it("the manifest must not declare stopInstance, or none of this runs at all", () => {
    // With the entry the host kills the process one second after asking it to stop —
    // onUnload never runs and every state written while shutting down is dead code.
    // A property of the MANIFEST, so only a test can defend it.
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "io-package.json"), "utf8")) as {
      common: { supportedMessages?: Record<string, unknown> };
    };
    expect(manifest.common.supportedMessages?.stopInstance).toBeUndefined();
    // Not even an empty object: any `supportedMessages` object makes js-controller ignore
    // `common.messagebox`, and the admin connection test stops being delivered.
    expect(manifest.common.supportedMessages).toBeUndefined();
  });

  it("tells the controller we are done only AFTER the last state was written", async () => {
    const s = await setupConnected();
    const order: string[] = [];
    // Resolves on a LATER turn of the event loop, like a real database round trip — an
    // immediately-resolving stub would record the write synchronously and the test would
    // pass even with the callback fired first.
    (s.stub as unknown as { setState: (id: string, v: unknown) => Promise<void> }).setState = (id: string) =>
      new Promise<void>(resolve =>
        setTimeout(() => {
          order.push(`write:${id}`);
          resolve();
        }, 0),
      );
    const callback = vi.fn(() => order.push("callback"));

    s.internal.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(order[order.length - 1]).toBe("callback");
    expect(order).toContain("write:info.connection");
    expect(order).toContain("write:ups0.info.reachable");
  });

  it("erases a leftover stopInstance flag and stops the start there", async () => {
    const s = setup();
    s.stub.getForeignObjectAsync.mockResolvedValue({
      common: { supportedMessages: { stopInstance: true } },
    });

    await s.internal.onReady();

    // The whole key goes, written as null: a merge cannot remove anything, and leaving
    // `supportedMessages` behind as an object switches the message box off (see below).
    expect(s.stub.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.nut2.0", {
      common: { supportedMessages: null },
    });
    // Carrying on would arm timers in a process the host is already shutting down.
    expect(s.client.start).not.toHaveBeenCalled();
    expect(s.sm.markAllUnreachable).not.toHaveBeenCalled();
  });

  it("erases a supportedMessages object whose entries are all off — it kills the message box", async () => {
    // Measured on the live server (js-controller 7.2.2): once `supportedMessages` is an object,
    // `isMessageboxSupported()` ignores `common.messagebox` and reads "all entries false" as
    // "no messages" — the adapter never subscribes and the admin connection test does nothing.
    // v0.9.0-v0.12.0 wrote exactly that object themselves.
    const s = setup();
    s.stub.getForeignObjectAsync.mockResolvedValue({
      common: { supportedMessages: { stopInstance: false } },
    });

    await s.internal.onReady();

    expect(s.stub.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.nut2.0", {
      common: { supportedMessages: null },
    });
    expect(s.client.start).not.toHaveBeenCalled();
  });

  it("starts normally once the key is gone", async () => {
    const s = setup();
    s.stub.getForeignObjectAsync.mockResolvedValue({ common: { messagebox: true } });

    await s.internal.onReady();

    expect(s.stub.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(s.client.start).toHaveBeenCalledTimes(1);
  });

  it("starts normally when the correction already ran (key present but null)", async () => {
    // The erased key stays in the object as null — that must not trigger a restart loop.
    const s = setup();
    s.stub.getForeignObjectAsync.mockResolvedValue({
      common: { messagebox: true, supportedMessages: null },
    });

    await s.internal.onReady();

    expect(s.stub.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(s.client.start).toHaveBeenCalledTimes(1);
  });
});

describe("device markers follow a wholesale poll failure", () => {
  it("marks every UPS unreachable when the poll fails as a whole", async () => {
    const s = await setupConnected();
    // A failure OUTSIDE the per-UPS loop (the states DB, not one device).
    s.stub.states.clear();
    const original = s.internal.stateManager!;
    (original as unknown as { updateVariables: unknown }).updateVariables = vi.fn(async () => {});
    s.client.listVar.mockResolvedValue([{ name: "ups.status", value: "OL" }]);
    s.sm.writeUpsSummary.mockRejectedValueOnce(new Error("states db gone"));

    await s.internal.poll();

    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: false, ack: true });
    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(1, 0);
  });
});

describe("the whole chain agrees in every state", () => {
  it("keeps the UPSes readable when the credentials are refused on a reconnect", async () => {
    // Refused credentials are not a dead end: reading needs no login, so the chain must NOT go
    // to "0 of 1 reachable" — that would claim the UPS is gone when only the login was rejected.
    const s = await setupConnected({ username: "u", password: "p" });
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: true, ack: true });
    s.sm.writeUpsSummary.mockClear();
    s.client.authenticate.mockRejectedValue(new Error("ACCESS-DENIED"));

    await s.internal.onConnected();

    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: true, ack: true });
    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(1, 1);
    expect(logsOf(s.stub, "warn").some(m => m.includes("Could not send the credentials"))).toBe(true);
  });

  it("marks the UPSes unreachable when the encrypted connection fails fatally", async () => {
    const s = await setupConnected();
    s.sm.writeUpsSummary.mockClear();

    s.client.onFatal!(new Error("FEATURE-NOT-CONFIGURED"));
    await vi.waitFor(() => expect(s.sm.writeUpsSummary).toHaveBeenCalled());

    expect(s.stub.states.get("nut2.0.info.connection")).toEqual({ val: false, ack: true });
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: false, ack: true });
    expect(s.sm.writeUpsSummary).toHaveBeenLastCalledWith(1, 0);
  });
});

describe("onMessage", () => {
  const message = (msg: unknown): ioBroker.Message =>
    ({
      command: "checkConnection",
      from: "system.adapter.admin.0",
      callback: { id: 1, message: "x", time: 0, ack: false },
      message: msg,
    }) as ioBroker.Message;

  // This handler had NO coverage at all, and it is exactly the path that was dead from v0.9.0
  // to v0.12.0 without a single test noticing (issue #17 / v0.12.1). The router itself is well
  // tested — what was never exercised is the wiring around it.
  it("routes a message to the dispatcher and answers through sendTo", async () => {
    const s = setup();
    await s.internal.onMessage(message({ host: "" }));

    expect(s.stub.sentTo).toHaveLength(1);
    expect(s.stub.sentTo[0].command).toBe("checkConnection");
    expect(s.stub.sentTo[0].from).toBe("system.adapter.admin.0");
    expect(s.stub.sentTo[0].response).toHaveProperty("error");
  });

  it("answers an unknown command instead of leaving the caller hanging", async () => {
    const s = setup();
    await s.internal.onMessage({ ...message(undefined), command: "nonsense" });

    expect(s.stub.sentTo[0].response).toEqual({ error: "Unknown command" });
  });

  it("registers the throwaway test client AND removes it again", async () => {
    // A client left in the set would be destroyed a second time on unload — and worse, a leak
    // that nothing ever notices, because the set is only read while shutting down.
    const s = setup();
    await s.internal.onMessage(message({ host: "127.0.0.1", port: 1, commandTimeout: 1 }));

    expect(s.stub.sentTo).toHaveLength(1);
    expect(s.internal.testClients.size).toBe(0);
  });

  it("catches a failure inside the dispatcher instead of crashing the adapter", async () => {
    const s = setup();
    // An unhandled rejection in an event handler crash-loops the instance; the top-level catch
    // is the only thing between a broken answer and that loop.
    (s.stub as unknown as { sendTo: () => void }).sendTo = () => {
      throw new Error("states DB gone");
    };

    await s.internal.onMessage(message({ host: "" }));

    expect(logsOf(s.stub, "error").some(m => m.includes("onMessage failed"))).toBe(true);
  });
});

describe("edges that had no test", () => {
  it("says why no command buttons appear when commands are on but credentials are missing", async () => {
    // Silence here is the trap: the user ticks the box, nothing shows up, and there is nowhere
    // to look. upsd checks command rights per named user, so credentials are not optional.
    const s = await setupConnected({ enableCommands: true });

    expect(s.sm.createCommandButtons).not.toHaveBeenCalled();
    const warns = logsOf(s.stub, "warn").filter(m => m.includes("no credentials are configured"));
    expect(warns).toHaveLength(1);

    // Every reconnect runs the same path — it must not turn into a log flood.
    await s.internal.onConnected();
    expect(logsOf(s.stub, "warn").filter(m => m.includes("no credentials are configured"))).toHaveLength(1);
  });

  it("ignores a write while no client exists instead of throwing", async () => {
    const s = await setupConnected({ enableCommands: true, username: "u", password: "p" });
    s.internal.client = null;

    await s.internal.onStateChange("nut2.0.ups0.commands.beeper-enable", { val: true, ack: false });

    expect(logsOf(s.stub, "debug").some(m => m.includes("no client connection"))).toBe(true);
  });

  it("catches a failure inside onStateChange — an unhandled rejection crash-loops the instance", async () => {
    const s = await setupConnected({ enableCommands: true, username: "u", password: "p" });
    s.sm.nutNameForState.mockImplementation(() => {
      throw new Error("cache exploded");
    });

    await s.internal.onStateChange("nut2.0.ups0.commands.beeper-enable", { val: true, ack: false });

    expect(logsOf(s.stub, "error").some(m => m.includes("onStateChange failed"))).toBe(true);
  });

  it("survives a driver that supports neither LIST ENUM nor LIST RANGE", async () => {
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.client.listEnum.mockRejectedValue(new NutError("VAR-NOT-SUPPORTED"));
    s.client.listRange.mockRejectedValue(new NutError("VAR-NOT-SUPPORTED"));
    s.internal.enrichedUps.clear();

    await s.internal.poll();

    // Best-effort: not a warning, not an abort — the poll itself has to finish.
    const debug = logsOf(s.stub, "debug");
    expect(debug.some(m => m.includes("LIST ENUM") && m.includes("not supported"))).toBe(true);
    expect(debug.some(m => m.includes("LIST RANGE") && m.includes("not supported"))).toBe(true);
    expect(s.stub.states.get("nut2.0.ups0.info.reachable")).toEqual({ val: true, ack: true });
  });

  it("keeps disambiguating past the second collision", async () => {
    // Three different NUT names that all sanitize to the same object ID.
    const s = setup({}, [
      { name: "u p", description: "A" },
      { name: "u.p", description: "B" },
      { name: "u,p", description: "C" },
    ]);
    await s.internal.onReady();
    await s.internal.onConnected();

    expect([...s.internal.discoveredUps.keys()]).toEqual(["u_p", "u_p-2", "u_p-3"]);
    expect(logsOf(s.stub, "warn").filter(m => m.includes("collides")).length).toBe(2);
  });

  it("does not poll on a notify trigger that arrives during shutdown", async () => {
    const s = await setupConnected();
    s.internal.onUnload(() => {});
    s.client.listUps.mockClear();

    await s.internal.onStateChange("nut2.0.notify", { val: "ONBATT ups0", ack: false });

    expect(s.client.listUps).not.toHaveBeenCalled();
  });

  it("logs instead of throwing when the final writes are rejected on shutdown", async () => {
    const s = await setupConnected();
    (s.stub as unknown as { setState: () => Promise<void> }).setState = () =>
      Promise.reject(new Error("states DB closed"));

    const done = new Promise<void>(resolve => s.internal.onUnload(resolve));
    await done;

    expect(logsOf(s.stub, "debug").some(m => m.includes("final states rejected"))).toBe(true);
  });
});

describe("what the adapter hands to its collaborators", () => {
  it("injects MANAGED timers into the client — a native one would outlive onUnload", async () => {
    const s = setup();
    await s.internal.onReady();

    const opts = s.clientArgs[0][2] as {
      setTimer: (cb: () => void, ms: number) => unknown;
      clearTimer: (h: unknown) => void;
      logger: { debug: (m: string) => void; warn: (m: string) => void; info: (m: string) => void };
    };

    const handle = opts.setTimer(() => {}, 1234);
    expect(s.stub.timeouts.some(t => t.ms === 1234)).toBe(true);

    opts.clearTimer(handle);
    expect(s.stub.timeouts.find(t => t.ms === 1234)!.cleared).toBe(true);
    // A null handle must not reach clearTimeout — the client passes one after a settled connect.
    expect(() => opts.clearTimer(null)).not.toThrow();

    opts.logger.debug("d");
    opts.logger.warn("w");
    opts.logger.info("i");
    expect(logsOf(s.stub, "debug")).toContain("d");
    expect(logsOf(s.stub, "warn")).toContain("w");
    expect(logsOf(s.stub, "info")).toContain("i");
  });

  it("starts anyway when the instance object cannot be read", async () => {
    // The objects DB being briefly unavailable must not stop the adapter from coming up; the
    // next start checks again.
    const s = setup();
    s.stub.getForeignObjectAsync.mockRejectedValue(new Error("objects DB down"));

    await s.internal.onReady();

    expect(logsOf(s.stub, "debug").some(m => m.includes("Could not check the instance object"))).toBe(true);
    expect(s.client.start).toHaveBeenCalledTimes(1);
  });

  it("logs a failing post-connect setup instead of losing the rejection", async () => {
    const s = setup();
    await s.internal.onReady();
    s.client.listUps.mockRejectedValue(new Error("boom"));

    // This is the callback the client itself invokes after every (re)connect.
    s.client.onConnect!();
    await vi.waitFor(() =>
      expect(logsOf(s.stub, "error").some(m => m.includes("Post-connect setup failed"))).toBe(true),
    );

    // And the poll timer is armed anyway: the socket is alive, so nothing else would ever
    // restart the polling.
    expect(s.internal.pollTimer).toBeDefined();
  });
});

describe("audit 2026-09-12 — the poll keeps its contract", () => {
  it("poll() resolves even when the states DB rejects every write while it is failing", async () => {
    // Measured: the catch block itself awaited two state writes without a guard. With the DB gone
    // (a stop, a controller restart) the poll REJECTED out of its own catch — and both callers
    // (`void this.poll()` in the timer chain and in the follow-up) let that become an unhandled
    // rejection, which js-controller answers with red lines and, outside a stop, a restart.
    const s = await setupConnected();
    s.client.listUps.mockRejectedValue(new NutConnectionError("Not connected"));
    s.stub.statesDbClosed = true;

    await expect(s.internal.poll()).resolves.toBeUndefined();
    expect(logsOf(s.stub, "error"), "a closed DB is not an error of this adapter").toEqual([]);
  });

  it("a fatal TLS error on a reconnect stops the poll chain — no 'will keep retrying' for a client that is gone", async () => {
    // Measured: after onFatal the client was destroyed for good, but the armed timer kept
    // re-arming itself forever and the first poll wrote "will keep retrying" right under the
    // error line that said the opposite.
    const s = await setupConnected({ useTls: true, tlsRejectUnauthorized: true, tlsCaFile: "/etc/ca.pem" });
    const armed = s.stub.timeouts.find(t => !t.cleared);
    expect(armed, "precondition: the poll timer is armed after the first connect").toBeDefined();

    s.client.onFatal!(new NutError("TLS-CA-UNREADABLE", "TLS CA file /etc/ca.pem cannot be read"));

    expect(armed!.cleared, "the poll timer was not cleared").toBe(true);
    expect(s.internal.pollTimer).toBeUndefined();
    // Nothing re-arms it either — not the timer chain, not a poll that was still in flight.
    const before = s.stub.timeouts.length;
    s.internal.scheduleNextPoll();
    expect(s.stub.timeouts.length).toBe(before);
    expect(logsOf(s.stub, "warn").some(m => m.includes("will keep retrying"))).toBe(false);
  });

  it("a failing object write during the enrichment is reported as such — not as an unsupported LIST command", async () => {
    // Measured: both enrichStateMetadata calls sat inside the try whose catch says
    // "LIST ENUM/RANGE … not supported" on debug. A datapoint the write could not update was
    // blamed on the driver, invisibly.
    const s = await setupConnected({ enableSetVar: true });
    s.client.listRw.mockResolvedValue([{ name: "ups.delay.shutdown", value: "20" }]);
    s.client.listEnum.mockResolvedValue(["10", "20", "30"]);
    s.client.listRange.mockResolvedValue([{ min: "0", max: "600" }]);
    s.sm.enrichStateMetadata.mockRejectedValue(new Error("Connection is closed."));
    s.internal.enrichedUps.clear();

    await s.internal.poll();

    const warns = logsOf(s.stub, "warn");
    expect(warns.some(m => m.includes("ups0.ups.delay-shutdown") && m.includes("Connection is closed."))).toBe(true);
    expect(logsOf(s.stub, "debug").some(m => m.includes("not supported"))).toBe(false);
  });
});

describe("audit 2026-09-12 — writes that never belonged on the wire", () => {
  it("a write to a datapoint the server listed as read-only ends on debug, not as a SET VAR", async () => {
    // `enableSetVar` is on, but LIST RW did not list battery.charge — the adapter created it
    // read-only. A script writing to it produced a SET VAR that upsd refused, and a red line.
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "ups.delay.shutdown");

    await s.internal.onStateChange("nut2.0.ups0.battery.charge", { val: 50, ack: false });

    expect(s.client.setVar).not.toHaveBeenCalled();
    expect(logsOf(s.stub, "error")).toEqual([]);
    expect(logsOf(s.stub, "debug").some(m => m.includes("battery.charge") && m.includes("read-only"))).toBe(true);
  });

  it("a write to a datapoint the server listed as writable still goes out", async () => {
    const s = await setupConnected({ enableSetVar: true });
    await withWritable(s, "ups.delay.shutdown");

    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: 30, ack: false });

    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "ups.delay.shutdown", "30");
  });

  it("before the first poll answered, a write is not refused on a guess", async () => {
    // The gate only fires on KNOWLEDGE — a UPS the poll has not listed yet is left to the server.
    const s = setup({ enableSetVar: true });
    await s.internal.onReady();
    await s.internal.discover();

    await s.internal.onStateChange("nut2.0.ups0.ups.delay-shutdown", { val: 30, ack: false });

    expect(s.client.setVar).toHaveBeenCalledWith("ups0", "ups.delay.shutdown", "30");
  });

  it("says once why every SET VAR will fail when it is enabled without credentials", async () => {
    // The commands switch has had this warning since 0.14.0; the SET VAR switch did not —
    // the variables came up writable and every write died with ACCESS-DENIED, unexplained.
    const s = await setupConnected({ enableSetVar: true, username: "", password: "" });
    const warned = (): number =>
      logsOf(s.stub, "warn").filter(m => m.includes("SET VAR") && m.includes("no credentials")).length;
    expect(warned()).toBe(1);

    await s.internal.onConnected();
    expect(warned(), "once per runtime, not once per reconnect").toBe(1);
  });

  it("stays silent about credentials when SET VAR is off", async () => {
    const s = await setupConnected({ enableSetVar: false, username: "", password: "" });
    expect(logsOf(s.stub, "warn").some(m => m.includes("SET VAR") && m.includes("no credentials"))).toBe(false);
  });
});
