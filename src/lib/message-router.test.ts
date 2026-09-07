import { vi } from "vitest";

// message-router resolves the answers through admin/i18n now; the real adapter-core exits the
// process outside an adapter, so the translation surface is stubbed (key → key, args appended).
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join("|")}` : key)),
  },
}));

import { NutError, type NutClient } from "./nut-client";
import { dispatchMessage, type MessageRouterDeps } from "./message-router";
import type { NutClientOptions } from "./types";
import { nutClientOptionsFrom } from "./coerce";

interface SentMessage {
  from: string;
  command: string;
  response: unknown;
  callback: ioBroker.MessageCallbackInfo | undefined;
}

interface TestHarness {
  sends: SentMessage[];
  logs: { level: "debug" | "warn"; msg: string }[];
  createdClients: { host: string; port: number }[];
  createdOptions: (NutClientOptions | undefined)[];
  registered: NutClient[];
  completed: NutClient[];
  /** Protocol steps the fake test client was driven through, in order. */
  steps: string[];
  deps: MessageRouterDeps;
}

function makeHarness(
  listUpsResult?: { name: string; description: string }[],
  connectError?: Error,
  authError?: Error,
  loginError?: Error,
  isTls = false,
): TestHarness {
  const sends: SentMessage[] = [];
  const logs: { level: "debug" | "warn"; msg: string }[] = [];
  const createdClients: { host: string; port: number }[] = [];
  const createdOptions: (NutClientOptions | undefined)[] = [];
  const registered: NutClient[] = [];
  const completed: NutClient[] = [];
  const steps: string[] = [];

  const deps: MessageRouterDeps = {
    log: {
      debug: msg => logs.push({ level: "debug", msg }),
      warn: msg => logs.push({ level: "warn", msg }),
    },
    sendTo: (from, command, response, callback) => {
      sends.push({ from, command, response, callback });
    },
    createTestClient: (host, port, options) => {
      createdClients.push({ host, port });
      createdOptions.push(options);
      return {
        connect: () => {
          if (connectError) {
            return Promise.reject(connectError);
          }
          return Promise.resolve();
        },
        listUps: () => Promise.resolve(listUpsResult ?? [{ name: "ups0", description: "Eaton" }]),
        authenticate: () => {
          steps.push("authenticate");
          if (authError) {
            return Promise.reject(authError);
          }
          return Promise.resolve();
        },
        login: (ups: string) => {
          steps.push(`login:${ups}`);
          if (loginError) {
            return Promise.reject(loginError);
          }
          return Promise.resolve();
        },
        logout: () => {
          steps.push("logout");
          return Promise.resolve();
        },
        isTls,
        destroy: () => {},
      } as unknown as NutClient;
    },
    onTestClientCreated: client => registered.push(client),
    onTestClientDone: client => completed.push(client),
  };

  return { sends, logs, createdClients, createdOptions, registered, completed, steps, deps };
}

function buildMessage(overrides: Partial<ioBroker.Message>): ioBroker.Message {
  return {
    command: "checkConnection",
    from: "system.adapter.test.0",
    callback: { id: 1, message: "x", time: 0, ack: false },
    message: undefined,
    ...overrides,
  } as ioBroker.Message;
}

describe("dispatchMessage", () => {
  // -----------------------------------------------------------------------
  // Default-branch contract
  // -----------------------------------------------------------------------
  describe("default-branch contract", () => {
    it("should return { error: 'Unknown command' } for unrecognised commands", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ command: "totallyMadeUpCommand" }), h.deps);

      expect(h.sends).toHaveLength(1);
      expect(h.sends[0].command).toBe("totallyMadeUpCommand");
      expect(h.sends[0].response).toEqual({ error: "Unknown command" });
      expect(h.sends[0].callback).toBeDefined();
    });

    it("should emit a debug line for unknown commands", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ command: "weirdCmd" }), h.deps);

      const debugMsgs = h.logs.filter(l => l.level === "debug").map(l => l.msg);
      expect(debugMsgs.some(m => m.includes("unknown command 'weirdCmd'"))).toBe(true);
    });

    it("should always invoke sendTo exactly once per command", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ command: "x" }), h.deps);
      await dispatchMessage(buildMessage({ command: "y" }), h.deps);
      await dispatchMessage(buildMessage({ command: "z" }), h.deps);

      expect(h.sends).toHaveLength(3);
      for (const s of h.sends) {
        expect(s.callback).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Entry log
  // -----------------------------------------------------------------------
  describe("entry log", () => {
    it("should emit entry debug before callback early-return for broadcasts", async () => {
      const h = makeHarness();
      await dispatchMessage({ command: "broadcast", from: "x", message: {} } as ioBroker.Message, h.deps);

      expect(h.sends).toHaveLength(0);
      const debugMsgs = h.logs.filter(l => l.level === "debug").map(l => l.msg);
      expect(debugMsgs.some(m => m.includes("onMessage: command='broadcast'"))).toBe(true);
      expect(debugMsgs.some(m => m.includes("has-callback=false"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // checkConnection
  // -----------------------------------------------------------------------
  describe("checkConnection", () => {
    it("should return error for missing host", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ command: "checkConnection", message: { host: "", port: 3493 } }), h.deps);

      expect(h.sends).toHaveLength(1);
      expect(h.sends[0].response).toEqual({ error: "testHostRequired" });
      expect(h.createdClients).toHaveLength(0);
    });

    it("should connect and list UPS devices on valid config", async () => {
      const h = makeHarness([
        { name: "ups0", description: "Eaton PRO 1600" },
        { name: "ups1", description: "APC Smart" },
      ]);
      await dispatchMessage(
        buildMessage({ command: "checkConnection", message: { host: "192.168.1.100", port: 3493 } }),
        h.deps,
      );

      expect(h.createdClients).toEqual([{ host: "192.168.1.100", port: 3493 }]);
      expect(h.sends).toHaveLength(1);
      const resp = h.sends[0].response as { result: string };
      // The stub renders "<key>:<arg>|<arg>" — this asserts the catalogue text AND its values.
      expect(resp.result).toBe("testConnectedNoCreds:testPlain|2|ups0, ups1");
      expect(resp.result).toContain("ups0");
      expect(resp.result).toContain("ups1");
    });

    it("should use default port 3493 when port is not a number", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ command: "checkConnection", message: { host: "myhost" } }), h.deps);

      expect(h.createdClients).toEqual([{ host: "myhost", port: 3493 }]);
    });

    it("forwards networkInterface, commandTimeout and TLS options to the test client", async () => {
      const h = makeHarness([{ name: "ups0", description: "Eaton" }]);
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: {
            host: "192.168.1.100",
            port: 3493,
            networkInterface: "10.0.0.5",
            commandTimeout: 8,
            useTls: true,
            tlsRejectUnauthorized: true,
            tlsCaFile: "/etc/ssl/nut-ca.pem",
          },
        }),
        h.deps,
      );

      expect(h.createdOptions).toHaveLength(1);
      expect(h.createdOptions[0]).toMatchObject({
        localAddress: "10.0.0.5",
        commandTimeout: 8000, // seconds → ms
        useTls: true,
        tlsRejectUnauthorized: true,
        tlsCaFile: "/etc/ssl/nut-ca.pem",
      });
    });

    it("builds the options from the ONE shared mapping, not a look-alike copy", async () => {
      // The router used to carry its own copy of this five-field mapping. An option added to the
      // adapter's clientOptions() then silently missed the very button that claims to test that
      // connection — against design #32 ("the probe walks the same path") and #40 ("the test tells
      // the same story"). Comparing against the shared function is what keeps the two from drifting:
      // a new field appears on both sides at once, or this fails.
      const config = {
        host: "192.168.1.100",
        port: 3493,
        networkInterface: "10.0.0.5",
        commandTimeout: 8,
        useTls: true,
        tlsRejectUnauthorized: true,
        tlsCaFile: "/etc/ssl/nut-ca.pem",
      };
      const h = makeHarness([{ name: "ups0", description: "Eaton" }]);
      await dispatchMessage(buildMessage({ command: "checkConnection", message: config }), h.deps);

      expect(h.createdOptions[0]).toEqual(nutClientOptionsFrom(config));
    });

    it("omits localAddress and defaults TLS off when not configured", async () => {
      const h = makeHarness([{ name: "ups0", description: "Eaton" }]);
      await dispatchMessage(buildMessage({ command: "checkConnection", message: { host: "h", port: 3493 } }), h.deps);

      expect(h.createdOptions[0]).toMatchObject({
        localAddress: undefined,
        useTls: false,
        tlsRejectUnauthorized: false,
        tlsCaFile: "",
      });
    });

    it("should forward connection errors as failure response", async () => {
      const h = makeHarness(undefined, new Error("ECONNREFUSED"));
      await dispatchMessage(
        buildMessage({ command: "checkConnection", message: { host: "10.0.0.1", port: 3493 } }),
        h.deps,
      );

      expect(h.sends).toHaveLength(1);
      const resp = h.sends[0].response as { error: string };
      // The frame follows the system language like every other user-facing answer; only the cause
      // inside it stays as the runtime worded it.
      expect(resp.error).toContain("testFailed");
      expect(resp.error).toContain("ECONNREFUSED");
    });
  });

  // -----------------------------------------------------------------------
  // checkConnection with auth
  // -----------------------------------------------------------------------
  describe("checkConnection with auth", () => {
    it("logs in (LOGIN on the first UPS, then LOGOUT) and only then says so", async () => {
      // USERNAME/PASSWORD are only stored by upsd — LOGIN is the step that verifies them (#17).
      const h = makeHarness([
        { name: "ups0", description: "Eaton" },
        { name: "ups1", description: "APC" },
      ]);
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "secret" },
        }),
        h.deps,
      );

      expect(h.steps).toEqual(["authenticate", "login:ups0", "logout"]);
      expect(h.sends).toHaveLength(1);
      const resp = h.sends[0].response as { result: string };
      expect(resp.result).toBe("testConnectedLoggedIn:testPlain|admin|2|ups0, ups1");
    });

    it("does not claim a login when no credentials are provided", async () => {
      const h = makeHarness([{ name: "ups0", description: "Eaton" }]);
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493 },
        }),
        h.deps,
      );

      expect(h.steps).toEqual([]);
      expect(h.sends).toHaveLength(1);
      const resp = h.sends[0].response as { result: string };
      expect(resp.result).not.toContain("LoggedIn");
      expect(resp.result).toContain("testConnectedNoCreds");
    });

    it("says the credentials are unverified when the server lists no UPS to log in to", async () => {
      const h = makeHarness([]);
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "secret" },
        }),
        h.deps,
      );

      expect(h.steps).toEqual([]);
      const resp = h.sends[0].response as { result: string };
      expect(resp.result).toContain("testConnectedNoUps");
      expect(resp.result).not.toContain("LoggedIn");
    });

    it("names both causes when upsd refuses the LOGIN", async () => {
      // upsd answers ACCESS-DENIED for a wrong password AND for a user without upsmon rights.
      const h = makeHarness(
        [{ name: "ups0", description: "Eaton" }],
        undefined,
        undefined,
        new NutError("ACCESS-DENIED"),
      );
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "wrong" },
        }),
        h.deps,
      );

      // Refused credentials are not a broken connection: since design #32 the adapter keeps
      // reading and stays green, so the test says the same thing instead of crying error.
      expect(h.sends[0].response).not.toHaveProperty("error");
      const resp = h.sends[0].response as { result: string };
      expect(resp.result).toContain("testConnectedAuthRejected");
      expect(resp.result).toContain("admin");
      expect(h.steps).toEqual(["authenticate", "login:ups0"]);
    });

    it("an auth error outside the login block keeps its explaining cause text", async () => {
      // Not every ACCESS-DENIED comes from LOGIN — a server with an ACL can refuse the connection
      // or LIST UPS itself. That path runs through the general catch, and the user still needs to
      // be told WHY: upsd answers a wrong password and a missing `upsmon` line identically, so the
      // message has to name both. (This assertion used to live in the ACCESS-DENIED login test,
      // which moved to the result path in 0.14.0 — the mutation wave caught the gap.)
      const h = makeHarness([{ name: "ups0", description: "Eaton" }], new NutError("ACCESS-DENIED"));
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "pw" },
        }),
        h.deps,
      );

      const resp = h.sends[0].response as { error: string };
      expect(resp.error).toContain("testFailed");
      expect(resp.error).toContain("wrong password");
      expect(resp.error).toContain("upsd.users");
    });

    it("a NON-auth failure during login is still reported as an error", async () => {
      // The distinction has to be the error itself, not "anything that happens around LOGIN":
      // a dropped socket at that moment is a real failure and must not be dressed up as success.
      const h = makeHarness([{ name: "ups0", description: "Eaton" }], undefined, undefined, new NutError("DATA-STALE"));
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "pw" },
        }),
        h.deps,
      );

      const resp = h.sends[0].response as { error: string };
      expect(resp.error).toContain("testFailed");
      expect(resp.error).toContain("DATA-STALE");
    });

    it("reports the transport truthfully — via TLS only after a handshake", async () => {
      const tlsHarness = makeHarness([{ name: "ups0", description: "Eaton" }], undefined, undefined, undefined, true);
      await dispatchMessage(
        buildMessage({ command: "checkConnection", message: { host: "h", port: 3493 } }),
        tlsHarness.deps,
      );
      expect((tlsHarness.sends[0].response as { result: string }).result).toContain("testTls");

      const plain = makeHarness([{ name: "ups0", description: "Eaton" }]);
      await dispatchMessage(
        buildMessage({ command: "checkConnection", message: { host: "h", port: 3493 } }),
        plain.deps,
      );
      expect((plain.sends[0].response as { result: string }).result).toContain("testPlain");
    });

    it("should return failure when auth fails", async () => {
      const h = makeHarness([{ name: "ups0", description: "Eaton" }], undefined, new Error("ACCESS-DENIED"));
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "wrong" },
        }),
        h.deps,
      );

      expect(h.sends).toHaveLength(1);
      const resp = h.sends[0].response as { error: string };
      expect(resp.error).toContain("ACCESS-DENIED");
    });

    it("should still call onTestClientDone when auth fails", async () => {
      const h = makeHarness([{ name: "ups0", description: "Eaton" }], undefined, new Error("ACCESS-DENIED"));
      await dispatchMessage(
        buildMessage({
          command: "checkConnection",
          message: { host: "192.168.1.100", port: 3493, username: "admin", password: "wrong" },
        }),
        h.deps,
      );

      expect(h.registered).toHaveLength(1);
      expect(h.completed).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // obj.message coercion
  // -----------------------------------------------------------------------
  describe("obj.message coercion", () => {
    it("should treat null obj.message as missing host", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ message: null }), h.deps);

      expect(h.sends).toHaveLength(1);
      expect(h.sends[0].response).toEqual({ error: "testHostRequired" });
    });

    it("should treat string obj.message as missing host", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ message: "junk" }), h.deps);

      expect(h.sends).toHaveLength(1);
      expect((h.sends[0].response as { error?: string }).error).toBe("testHostRequired");
    });

    it("should treat array obj.message as missing host", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ message: [] }), h.deps);

      expect(h.sends).toHaveLength(1);
      expect((h.sends[0].response as { error?: string }).error).toBe("testHostRequired");
    });
  });

  // -----------------------------------------------------------------------
  // Test-client lifecycle hooks
  // -----------------------------------------------------------------------
  describe("test-client lifecycle hooks", () => {
    it("should call onTestClientCreated then onTestClientDone on success", async () => {
      const h = makeHarness([{ name: "ups0", description: "Eaton" }]);
      await dispatchMessage(buildMessage({ command: "checkConnection", message: { host: "h", port: 3493 } }), h.deps);

      expect(h.registered).toHaveLength(1);
      expect(h.completed).toHaveLength(1);
      expect(h.registered[0]).toBe(h.completed[0]);
    });

    it("should call onTestClientDone even when connect throws", async () => {
      const sends: SentMessage[] = [];
      const registered: NutClient[] = [];
      const completed: NutClient[] = [];
      const failingClient = {
        connect: () => {
          return Promise.reject(new Error("boom"));
        },
        destroy: () => {},
      } as unknown as NutClient;
      const deps: MessageRouterDeps = {
        log: { debug: () => {}, warn: () => {} },
        sendTo: (from, command, response, callback) => {
          sends.push({ from, command, response, callback });
        },
        createTestClient: () => failingClient,
        onTestClientCreated: c => registered.push(c),
        onTestClientDone: c => completed.push(c),
      };
      await dispatchMessage(buildMessage({ command: "checkConnection", message: { host: "h", port: 3493 } }), deps);

      expect(registered).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(registered[0]).toBe(completed[0]);
      expect(sends).toHaveLength(1);
      expect((sends[0].response as { error?: string }).error).toContain("boom");
    });

    it("should not register a test-client when host is missing", async () => {
      const h = makeHarness();
      await dispatchMessage(buildMessage({ command: "checkConnection", message: { host: "" } }), h.deps);

      expect(h.registered).toHaveLength(0);
      expect(h.completed).toHaveLength(0);
    });
  });
});
