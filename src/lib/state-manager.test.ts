import { vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    translate: vi.fn((key: string) => key),
  },
}));

import { StateManager, nutVarToStateId, nutVarToReadableName, sanitizeUpsName } from "./state-manager";

/**
 * Narrow a lookup that must have succeeded, so the test reads the object without optional chaining.
 *
 * @param value the looked-up value
 * @param message what was expected
 */
function assert<T>(value: T | undefined, message: string): asserts value is T {
  expect(value, message).toBeDefined();
}

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

interface MockObj {
  type: string;
  common: Record<string, unknown>;
  native: Record<string, unknown>;
}

interface MockState {
  val: unknown;
  ack: boolean;
}

/**
 * The merge js-controller performs on extendObject (`node.extend(true, …)`): plain objects key by
 * key, arrays element by element, `undefined` skipped, `null` overwriting. The tests must see the
 * same semantics as production — a shallow merge would hide exactly the shrink problem.
 *
 * @param target the existing value (mutated)
 * @param source the new value
 * @returns the merged target
 */
function deepExtend(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const base =
        target[key] !== null && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
      target[key] = deepExtend({ ...base }, value as Record<string, any>);
      continue;
    }
    if (Array.isArray(value)) {
      const base = Array.isArray(target[key]) ? [...target[key]] : [];
      value.forEach((v, i) => (base[i] = v));
      target[key] = base;
      continue;
    }
    target[key] = value;
  }
  return target;
}

function createMockAdapter(): {
  adapter: any;
  objects: Map<string, MockObj>;
  states: Map<string, MockState>;
  deletedIds: string[];
  logs: string[];
} {
  const objects = new Map<string, MockObj>();
  const states = new Map<string, MockState>();
  const deletedIds: string[] = [];
  const logs: string[] = [];

  const adapter = {
    namespace: "nut2.0",
    log: {
      info: (msg: string) => logs.push(`INFO: ${msg}`),
      debug: (msg: string) => logs.push(`DEBUG: ${msg}`),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      error: (msg: string) => logs.push(`ERROR: ${msg}`),
    },
    setObjectNotExistsAsync: (id: string, obj: MockObj) => {
      if (!objects.has(id)) {
        objects.set(id, obj);
      }
      return Promise.resolve();
    },
    getObjectAsync: (id: string) => Promise.resolve(objects.get(id) ?? null),
    getStateAsync: (id: string) => Promise.resolve(states.get(id) ?? null),
    // The REPLACING write, as js-controller does it: the stored object becomes exactly what is
    // handed in. That is what makes removing a `common` attribute possible at all — extendObject
    // merges and would keep the key (with the value null, which the object checker rejects).
    setObject: (id: string, obj: MockObj) => {
      objects.set(id, JSON.parse(JSON.stringify(obj)) as MockObj);
      return Promise.resolve();
    },
    // Mirrors the REAL js-controller merge (7.2.2 → node.extend(true, old, new)): objects are
    // merged KEY BY KEY (a shorter new value list therefore leaves the dropped entries behind),
    // `undefined` is skipped and `null` overwrites. A shallow mock would replace common.states
    // wholesale and thus prove the opposite of what production does. `preserve` mirrors
    // removePreservedProperties (7.0.7): an attribute the OLD object has wins, the new value is
    // dropped — the earlier unconditional merge hid that the mfr+model name fallback never
    // applied in production (v0.2.5-v0.4.1).
    extendObject: (id: string, obj: MockObj, options?: { preserve?: { common?: string[] } }) => {
      const existing = objects.get(id);
      if (!existing) {
        objects.set(id, obj);
        return Promise.resolve();
      }
      const newCommon = { ...obj.common };
      for (const prop of options?.preserve?.common ?? []) {
        if (existing.common?.[prop] !== undefined && newCommon[prop] !== undefined) {
          delete newCommon[prop];
        }
      }
      existing.common = deepExtend(existing.common ?? {}, newCommon);
      if (obj.native !== undefined) {
        existing.native = deepExtend(existing.native ?? {}, obj.native);
      }
      return Promise.resolve();
    },
    setState: (id: string, state: MockState) => {
      states.set(id, state);
      return Promise.resolve();
    },
    setStateChangedAsync: (id: string, state: MockState) => {
      states.set(id, state);
      return Promise.resolve();
    },
    getAdapterObjectsAsync: () => {
      const result: Record<string, MockObj> = {};
      for (const [id, obj] of objects) {
        result[`nut2.0.${id}`] = obj;
      }
      return Promise.resolve(result);
    },
    delObjectAsync: (id: string, _opts?: { recursive?: boolean }) => {
      deletedIds.push(id);
      for (const key of objects.keys()) {
        if (key === id || key.startsWith(`${id}.`)) {
          objects.delete(key);
        }
      }
      // js-controller takes the VALUE of a leaf with the object. A mock that keeps it would hide
      // exactly the loss that removeCommonFields has to compensate.
      for (const key of [...states.keys()]) {
        if (key === id || key.startsWith(`${id}.`)) {
          states.delete(key);
        }
      }
      return Promise.resolve();
    },
  };

  return { adapter, objects, states, deletedIds, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * The English text of a name that is written as a translation object (every name the adapter
 * writes is one — including texts the NUT server supplied, see design #31).
 *
 * @param obj The object whose common.name is read
 */
function nameEn(obj: { common: { name?: unknown } } | undefined): string | undefined {
  const name = obj?.common.name;
  return typeof name === "object" && name !== null ? (name as Record<string, string>).en : (name as string);
}

describe("StateManager", () => {
  // -----------------------------------------------------------------------
  // Device creation
  // -----------------------------------------------------------------------
  describe("ensureUpsDevice", () => {
    it("should create device object", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");

      expect(objects.has("ups0")).toBe(true);
      expect(objects.get("ups0")?.type).toBe("device");
    });

    it("should create info channel and info.reachable but not info.name or info.description", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");

      expect(objects.has("ups0.info")).toBe(true);
      expect(objects.get("ups0.info")?.type).toBe("channel");
      expect(objects.has("ups0.info.reachable")).toBe(true);
      expect(objects.get("ups0.info.reachable")?.common.role).toBe("indicator.reachable");
      expect(objects.has("ups0.info.name")).toBe(false);
      expect(objects.has("ups0.info.description")).toBe(false);
    });

    it("should set statusStates.onlineId on device object", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");

      const common = objects.get("ups0")?.common as any;
      expect(common?.statusStates?.onlineId).toBe("nut2.0.ups0.info.reachable");
    });

    it("writes the adapter's name on re-discover — a rename in the object tree does not survive", async () => {
      // The adapter owns name and description like type and role (krobi 2026-09-02); a user's
      // place is 0_userdata. What the user DOES own — the recording — is untouched by a merge.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");
      const device = objects.get("ups0")!;
      device.common.name = "Renamed by hand";
      device.common.custom = { "influxdb.0": { enabled: true } };

      await sm.ensureUpsDevice("ups0", "Updated UPS");

      expect(nameEn(objects.get("ups0"))).toBe("Updated UPS");
      expect(objects.get("ups0")?.common.custom).toEqual({ "influxdb.0": { enabled: true } });
    });

    it("writes the server's own text as a translation object, never a bare string", async () => {
      // Core-team line (#15): common.name is a translation object for every object type. The
      // text the NUT server supplies has nothing to translate, so it goes under every language.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Rack UPS");

      const name = objects.get("ups0")?.common.name as Record<string, string>;
      expect(typeof name).toBe("object");
      expect(Object.keys(name)).toHaveLength(11);
      expect(name.en).toBe("Rack UPS");
      expect(name.de).toBe("Rack UPS");
    });

    it("should create multiple devices", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");
      await sm.ensureUpsDevice("ups1", "Backup UPS");

      expect(objects.has("ups0")).toBe(true);
      expect(objects.has("ups1")).toBe(true);
    });

    it("creates the per-UPS last-event state under the adapter-owned info channel", async () => {
      // Under info, not directly under the device: a NUT server is free to expose a
      // variable of any name, and a dotless var lands directly under the device —
      // the info channel is the only namespace NUT can never write into.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");

      const notify = objects.get("ups0.info.notify");
      expect(notify?.type).toBe("state");
      expect(notify?.common.role).toBe("text");
      expect(notify?.common.type).toBe("string");
      expect(notify?.common.write).toBe(false);
      expect(notify?.common.read).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Device name fallback
  // -----------------------------------------------------------------------
  describe("updateDeviceName", () => {
    it("should not update name when description is usable", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "My Custom UPS");
      await sm.updateDeviceName("ups0", "My Custom UPS", [
        { name: "device.mfr", value: "EATON" },
        { name: "device.model", value: "Ellipse PRO 1600" },
      ]);

      expect(nameEn(objects.get("ups0"))).toBe("My Custom UPS");
    });

    it("should update name from mfr+model when description is unavailable", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      await sm.updateDeviceName("ups0", "Description unavailable", [
        { name: "device.mfr", value: "EATON" },
        { name: "device.model", value: "Ellipse PRO 1600 " },
      ]);

      expect(nameEn(objects.get("ups0"))).toBe("EATON Ellipse PRO 1600");
    });

    it("should trim trailing spaces from model", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      await sm.updateDeviceName("ups0", "Description unavailable", [
        { name: "device.mfr", value: "EATON" },
        { name: "device.model", value: "  PRO 1600  " },
      ]);

      expect(nameEn(objects.get("ups0"))).toBe("EATON PRO 1600");
    });

    it("should use only model when mfr is missing", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      await sm.updateDeviceName("ups0", "Description unavailable", [{ name: "device.model", value: "Smart-UPS 1500" }]);

      expect(nameEn(objects.get("ups0"))).toBe("Smart-UPS 1500");
    });

    it("should update name when description is empty", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "");
      await sm.updateDeviceName("ups0", "", [
        { name: "device.mfr", value: "APC" },
        { name: "device.model", value: "Back-UPS 600" },
      ]);

      expect(nameEn(objects.get("ups0"))).toBe("APC Back-UPS 600");
    });

    it("should not update if neither mfr nor model available", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      await sm.updateDeviceName("ups0", "Description unavailable", [{ name: "battery.charge", value: "100" }]);

      // Without mfr/model there is nothing better than the UPS name — and the server's
      // placeholder text must never end up as the device label.
      expect(nameEn(objects.get("ups0"))).toBe("ups0");
    });

    it("overwrites a hand-written device name — the adapter owns it", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      // Renamed in the object tree meanwhile; the adapter's derived name wins on the next sync.
      objects.get("ups0")!.common.name = "Keller-USV";

      await sm.updateDeviceName("ups0", "Description unavailable", [
        { name: "device.mfr", value: "EATON" },
        { name: "device.model", value: "PRO 1600" },
      ]);

      expect(nameEn(objects.get("ups0"))).toBe("EATON PRO 1600");
    });

    it("runs the broker round-trip only once per runtime, not on every poll (v0.4.2)", async () => {
      const { adapter } = createMockAdapter();
      let getCalls = 0;
      const origGet = adapter.getObjectAsync;
      adapter.getObjectAsync = (...args: any[]) => {
        getCalls++;
        return Promise.resolve(origGet(...args));
      };
      let extendCalls = 0;
      const origExtend = adapter.extendObject;
      adapter.extendObject = (...args: any[]) => {
        extendCalls++;
        return Promise.resolve(origExtend(...args));
      };
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      const baselineExtend = extendCalls;
      // Only the name fallback is under test — the device setup reads the two renamed
      // predecessors once per runtime to carry their recording over.
      getCalls = 0;
      const vars = [
        { name: "device.mfr", value: "EATON" },
        { name: "device.model", value: "PRO 1600" },
      ];
      await sm.updateDeviceName("ups0", "Description unavailable", vars);
      await sm.updateDeviceName("ups0", "Description unavailable", vars);
      await sm.updateDeviceName("ups0", "Description unavailable", vars);

      // The derived name is remembered, so a steady poll reads and writes nothing at all.
      expect(getCalls).toBe(0);
      expect(extendCalls).toBe(baselineExtend + 1);
    });

    it("self-corrects the name when mfr/model change after first discovery (#5)", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.ensureUpsDevice("ups0", "Description unavailable");

      // first discovery: a transient/placeholder mfr+model arrives
      await sm.updateDeviceName("ups0", "Description unavailable", [
        { name: "device.mfr", value: "Dummy Manufacturer" },
        { name: "device.model", value: "Dummy UPS" },
      ]);
      expect(nameEn(objects.get("ups0"))).toBe("Dummy Manufacturer Dummy UPS");

      // later poll: the real values arrive → name self-corrects (no freeze)
      await sm.updateDeviceName("ups0", "Description unavailable", [
        { name: "device.mfr", value: "Eaton" },
        { name: "device.model", value: "5PX 1500" },
      ]);
      expect(nameEn(objects.get("ups0"))).toBe("Eaton 5PX 1500");
    });
  });

  // -----------------------------------------------------------------------
  // Channel creation
  // -----------------------------------------------------------------------
  describe("user-facing texts follow the system language", () => {
    it("names the severity levels from the translation catalogue, not in fixed English", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL");

      // The stub resolves a key to itself — so a catalogue key here proves the text is looked up
      // instead of being hard-coded English.
      expect(objects.get("ups0.status.severity")?.common.states).toEqual({
        0: "sev0",
        1: "sev1",
        2: "sev2",
        3: "sev3",
        4: "sev4",
      });
    });

    it("writes the readable status line through the catalogue too", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL CHRG");

      expect(states.get("ups0.status.display")?.val).toBe("flagOnline, flagCharging");
    });

    it("keeps a status token the adapter does not know as it came from the server", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL VENDORTOKEN");

      expect(states.get("ups0.status.display")?.val).toBe("flagOnline, VENDORTOKEN");
    });
  });

  describe("descriptions", () => {
    it("explains a datapoint whose name leaves a user guessing", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "battery.charge.low", value: "15" }], new Set());

      const desc = objects.get("ups0.battery.charge-low")?.common.desc;
      expect(typeof desc).toBe("object");
      expect(desc).toHaveProperty("en");
      expect(desc).toHaveProperty("de");
    });

    it("leaves the description empty where the name already says everything", async () => {
      // An invented sentence is worse than none — the fleet rule keeps desc empty there.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "device.serial", value: "G364T29133" }], new Set());

      expect(objects.get("ups0.device.serial")?.common.desc).toBeUndefined();
    });

    it("reuses the base explanation for a three-phase variant", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "input.L1.voltage", value: "230" }], new Set());

      expect(objects.get("ups0.input.L1-voltage")?.common.desc).toBeDefined();
    });

    it("explains every status flag and every channel", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL");

      expect(objects.get("ups0.status")?.common.desc).toBeDefined();
      expect(objects.get("ups0.status.online")?.common.desc).toBeDefined();
      expect(objects.get("ups0.status.severity")?.common.desc).toBeDefined();
    });

    it("explains a command button", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.createCommandButtons("ups0", [{ name: "beeper.mute" }, { name: "vendor.private" }]);

      expect(objects.get("ups0.commands.beeper-mute")?.common.desc).toBeDefined();
      // A driver-private command the catalog does not know gets none — nothing to explain.
      expect(objects.get("ups0.commands.vendor-private")?.common.desc).toBeUndefined();
    });
  });

  describe("ensureChannel", () => {
    it("corrects the name of a channel an older version already created", async () => {
      // Channels used to be written with "create if missing", so a name from an older version
      // was never touched again — the adapter owns the name (design #31), which only holds if
      // the write reaches EXISTING trees as well.
      const { adapter, objects } = createMockAdapter();
      objects.set("ups0.battery", { type: "channel", common: { name: "battery" }, native: {} });
      const sm = new StateManager(adapter);

      await sm.ensureChannel("ups0", "battery");

      // The bare string from the old version is gone; the catalogue name (a translation object)
      // took its place.
      const name = objects.get("ups0.battery")?.common.name;
      expect(typeof name).toBe("object");
      expect(nameEn(objects.get("ups0.battery"))).not.toBe("battery");
    });

    it("should create channel with i18n name", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureChannel("ups0", "battery");

      expect(objects.has("ups0.battery")).toBe(true);
      expect(objects.get("ups0.battery")?.type).toBe("channel");
      const name = objects.get("ups0.battery")?.common.name;
      expect(typeof name).toBe("object");
      expect(name).toHaveProperty("en");
      expect(name).toHaveProperty("de");
    });

    it("wraps an unknown channel name as a translation object, never a bare string", async () => {
      // The server's own word is the only text there is, but common.name must be a translation
      // object for every object type (core-team line, #15) — so the same text goes under every
      // language key instead of leaving the object browser with an untranslated name.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureChannel("ups0", "custom");

      const name = objects.get("ups0.custom")?.common.name as Record<string, string>;
      expect(typeof name).toBe("object");
      expect(name.en).toBe("custom");
      expect(name.de).toBe("custom");
      expect(Object.keys(name)).toHaveLength(11);
    });

    it("should create all standard NUT channels", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      const channels = ["battery", "device", "driver", "input", "output", "ups", "outlet", "ambient"];
      for (const ch of channels) {
        await sm.ensureChannel("ups0", ch);
      }

      expect(objects.size).toBe(channels.length);
    });
  });

  // -----------------------------------------------------------------------
  // Variable updates
  // -----------------------------------------------------------------------
  describe("updateVariables", () => {
    it("should create states for variables with dots→dashes", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [
          { name: "battery.charge", value: "100" },
          { name: "ups.status", value: "OL" },
        ],
        new Set(),
      );

      expect(objects.has("ups0.battery.charge")).toBe(true);
      expect(states.get("ups0.battery.charge")?.val).toBe(100);
      expect(states.get("ups0.ups.status")?.val).toBe("OL");
    });

    it("discards garbage in a numeric field and warns exactly once", async () => {
      const { adapter, states, logs } = createMockAdapter();
      const sm = new StateManager(adapter);

      // battery.charge carries a unit → it is expected numeric. Storing
      // "Infinity" would flip the datapoint's type and every consumer reading
      // it (charts, scripts) gets a value it cannot use.
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "Infinity" }], new Set());
      expect(states.has("ups0.battery.charge")).toBe(false);
      const warns = (): string[] => logs.filter(l => l.startsWith("WARN:") && l.includes("Discarding non-numeric"));
      expect(warns()).toHaveLength(1);

      // Second poll with the same garbage: dropped again, but no second warn —
      // a UPS that reports junk every 15 s must not flood the log.
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "12abc" }], new Set());
      expect(states.has("ups0.battery.charge")).toBe(false);
      expect(warns()).toHaveLength(1);

      // A good value afterwards still lands.
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "77" }], new Set());
      expect(states.get("ups0.battery.charge")?.val).toBe(77);
    });

    it("should create channels automatically", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "100" }], new Set());

      expect(objects.has("ups0.battery")).toBe(true);
    });

    it("should set write:true for writable variables", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "ups.delay.shutdown", value: "20" }], new Set(["ups.delay.shutdown"]));

      const common = objects.get("ups0.ups.delay-shutdown")?.common;
      expect(common?.write).toBe(true);
    });

    it("should detect correct types", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [
          { name: "battery.charge", value: "100" },
          { name: "device.mfr", value: "EATON" },
          { name: "input.voltage", value: "221.0" },
        ],
        new Set(),
      );

      expect(states.get("ups0.battery.charge")?.val).toBe(100);
      expect(states.get("ups0.device.mfr")?.val).toBe("EATON");
      expect(states.get("ups0.input.voltage")?.val).toBe(221.0);
    });

    it("should process shallow variables before deep ones", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [
          { name: "battery.charge.low", value: "15" },
          { name: "battery.charge", value: "100" },
        ],
        new Set(),
      );

      const keys = [...objects.keys()];
      const chargeIdx = keys.indexOf("ups0.battery.charge");
      const chargeLowIdx = keys.indexOf("ups0.battery.charge-low");
      expect(chargeIdx).toBeLessThan(chargeLowIdx);
    });

    it("should use readable names for state objects", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "battery.charge.low", value: "15" }], new Set());

      const common = objects.get("ups0.battery.charge-low")?.common;
      expect(common?.name).toHaveProperty("en");
      expect(common?.name).toHaveProperty("de");
    });
  });

  // -----------------------------------------------------------------------
  // Role migration on update — a changed role must reach existing objects
  // -----------------------------------------------------------------------
  describe("role migration on update", () => {
    it("should overwrite an existing state's generic role on the next poll (value → value.frequency)", async () => {
      const { adapter, objects } = createMockAdapter();
      // Seed the object as an older adapter version created it: generic value role.
      objects.set("ups0.input.frequency", {
        type: "state",
        common: { type: "number", role: "value", name: "Frequency", unit: "Hz", read: true, write: false },
        native: {},
      });
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "input.frequency", value: "50.0" }], new Set());

      expect(objects.get("ups0.input.frequency")?.common.role).toBe("value.frequency");
    });
  });

  // -----------------------------------------------------------------------
  // Status flags
  // -----------------------------------------------------------------------
  describe("updateStatusFlags", () => {
    it("should create status channel and states", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL");

      expect(objects.has("ups0.status")).toBe(true);
      expect(states.get("ups0.status.raw")?.val).toBe("OL");
      expect(states.get("ups0.status.severity")?.val).toBe(0);
      expect(states.get("ups0.status.online")?.val).toBe(true);
      expect(states.get("ups0.status.onBattery")?.val).toBe(false);
    });

    it("should update all flags on OL CHRG", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL CHRG");

      expect(states.get("ups0.status.online")?.val).toBe(true);
      expect(states.get("ups0.status.charging")?.val).toBe(true);
      expect(states.get("ups0.status.onBattery")?.val).toBe(false);
    });

    it("should set severity 3 for OB LB", async () => {
      const { adapter, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OB LB");

      expect(states.get("ups0.status.severity")?.val).toBe(3);
    });

    it("should assign role value.severity to the severity state", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL");

      expect(objects.get("ups0.status.severity")?.common.role).toBe("value.severity");
    });

    it("should create boolean states for all known flags", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateStatusFlags("ups0", "OL");

      for (const key of ["online", "onBattery", "lowBattery", "charging", "forcedShutdown"]) {
        expect(objects.has(`ups0.status.${key}`)).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Command buttons
  // -----------------------------------------------------------------------
  describe("nutNameForState", () => {
    it("stores the original NUT name so a dash-context var id reverses losslessly", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.updateVariables(
        "ups0",
        [{ name: "input.L1-L2.voltage", value: "398.3" }],
        new Set(["input.L1-L2.voltage"]),
      );
      expect(sm.nutNameForState("ups0.input.L1-L2-voltage")).toBe("input.L1-L2.voltage");
      expect(sm.nutNameForState("ups0.does.not-exist")).toBeUndefined();
    });
  });

  describe("three-phase / multi-sensor name translation (DP-7)", () => {
    it("collapses a single-phase L-context var to the translated base name, marker in front", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.updateVariables("ups0", [{ name: "input.L1.voltage", value: "230" }], new Set());
      expect(objects.get("ups0.input.L1-voltage")?.common.name).toEqual({
        en: "L1 input.voltage",
        de: "L1 input.voltage_de",
      });
    });

    it("collapses a line-to-line phase pair to the translated base name, marker in front", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.updateVariables("ups0", [{ name: "input.L1-L2.voltage", value: "398" }], new Set());
      expect(objects.get("ups0.input.L1-L2-voltage")?.common.name).toEqual({
        en: "L1-L2 input.voltage",
        de: "L1-L2 input.voltage_de",
      });
    });

    it("gives every phase of the same reading its OWN name", async () => {
      // The translation is worth nothing if it costs the reader the one segment that says which
      // phase is meant: before the marker, all three phases were called "Input voltage".
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.updateVariables(
        "ups0",
        [
          { name: "input.L1.voltage", value: "230" },
          { name: "input.L2.voltage", value: "231" },
          { name: "input.L3.voltage", value: "229" },
        ],
        new Set(),
      );
      const names = ["L1", "L2", "L3"].map(
        phase => (objects.get(`ups0.input.${phase}-voltage`)?.common.name as Record<string, string>).en,
      );
      expect(new Set(names).size).toBe(3);
      expect(names).toEqual(["L1 input.voltage", "L2 input.voltage", "L3 input.voltage"]);
    });

    it("keeps BOTH markers of a two-variant name", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.updateVariables("ups0", [{ name: "ambient.1.contacts.2.status", value: "open" }], new Set());
      expect((objects.get("ups0.ambient.1-contacts-2-status")?.common.name as Record<string, string>).en).toBe(
        "1 2 ambient.contacts.status",
      );
    });

    it("leaves the base variable itself without a marker", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.updateVariables("ups0", [{ name: "input.voltage", value: "230" }], new Set());
      expect(objects.get("ups0.input.voltage")?.common.name).toEqual({
        en: "input.voltage",
        de: "input.voltage_de",
      });
    });
  });

  describe("clearing shrinkable fields", () => {
    /**
     * Count the clearing round trips on one id. The clearing is `delObject` → `setObjectNotExists`
     * (the checker forbids `setObject`), so the delete is what marks it.
     *
     * @param adapter mock adapter
     * @param adapter.delObjectAsync the delete the clearing goes through
     * @param id state id to watch
     */
    function countClears(adapter: { delObjectAsync: unknown }, id: string): () => number {
      let clears = 0;
      const real = adapter.delObjectAsync as (...a: unknown[]) => Promise<void>;
      adapter.delObjectAsync = (...args: unknown[]) => {
        if (args[0] === id) {
          clears++;
        }
        return real(...args);
      };
      return () => clears;
    }

    it("writes NOTHING when there is no value list and no bounds to take away", async () => {
      // Mutation R3: without the early return, every object gets torn down and rebuilt on first
      // contact in a runtime — 566 round trips that change not a single byte, and every one of
      // them drops the datapoint for an instant.
      const { adapter, objects } = createMockAdapter();
      await new StateManager(adapter).updateVariables("ups0", [{ name: "device.mfr", value: "Eaton" }], new Set());
      const id = "ups0.device.mfr";
      expect(objects.get(id)?.common.states).toBeUndefined();

      const clears = countClears(adapter, id);
      // A SECOND manager = first contact with an EXISTING object, which is when the clearing runs.
      await new StateManager(adapter).updateVariables("ups0", [{ name: "device.mfr", value: "Eaton" }], new Set());
      expect(clears(), "the object was torn down although nothing had to be removed").toBe(0);
    });

    it("DOES clear when a value list has to go", async () => {
      const { adapter, objects } = createMockAdapter();
      const id = "ups0.ups.beeper-status";
      await new StateManager(adapter).updateVariables(
        "ups0",
        [{ name: "ups.beeper.status", value: "enabled" }],
        new Set(["ups.beeper.status"]),
      );
      expect(objects.get(id)?.common.states, "precondition: the datapoint carries a value list").toBeDefined();

      const clears = countClears(adapter, id);
      await new StateManager(adapter).updateVariables(
        "ups0",
        [{ name: "ups.beeper.status", value: "enabled" }],
        new Set(["ups.beeper.status"]),
      );
      expect(clears(), "the shrinkable list was not cleared before the fresh write").toBeGreaterThan(0);
    });

    it("keeps the datapoint's VALUE across the clearing", async () => {
      // `delObject` on a leaf takes the value with it. Without the capture-and-restore the reading
      // would be blank until the next poll — and the mock deletes it exactly like js-controller,
      // so this test really measures the compensation instead of a mock that never lost anything.
      const { adapter, states } = createMockAdapter();
      const id = "ups0.ups.beeper-status";
      const vars = [{ name: "ups.beeper.status", value: "enabled" }];
      const rw = new Set(["ups.beeper.status"]);
      await new StateManager(adapter).updateVariables("ups0", vars, rw);
      expect(states.get(id)?.val, "precondition: the datapoint carries a value").toBe("enabled");

      await new StateManager(adapter).updateVariables("ups0", vars, rw);
      expect(states.get(id)?.val, "the value was lost when the object was rebuilt").toBe("enabled");
      expect(states.get(id)?.ack, "the restored value must be acknowledged, not a command").toBe(true);
    });

    it("keeps the user's recording across the clearing", async () => {
      const { adapter, objects } = createMockAdapter();
      const id = "ups0.ups.beeper-status";
      const vars = [{ name: "ups.beeper.status", value: "enabled" }];
      const rw = new Set(["ups.beeper.status"]);
      await new StateManager(adapter).updateVariables("ups0", vars, rw);
      const obj = objects.get(id);
      assert(obj, "datapoint exists");
      obj.common.custom = { "history.0": { enabled: true } };

      await new StateManager(adapter).updateVariables("ups0", vars, rw);
      expect(objects.get(id)?.common.custom, "the recording belongs to the user and must survive").toEqual({
        "history.0": { enabled: true },
      });
    });
  });

  describe("createCommandButtons", () => {
    it("resolves a per-outlet command through its base command, marker in front", async () => {
      // `outlet.n.load.off` is ONE documented command with an outlet number in the middle. Before
      // the collapse it was an unknown command: raw label in all eleven languages, no explanation.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.createCommandButtons("ups0", [{ name: "outlet.1.load.off" }, { name: "outlet.2.load.off" }]);
      const first = objects.get("ups0.commands.outlet-1-load-off");
      expect((first?.common.name as Record<string, string>).en).toBe("1 cmdOutletLoadOff");
      expect(first?.common.desc).toBeDefined();
      expect((objects.get("ups0.commands.outlet-2-load-off")?.common.name as Record<string, string>).en).toBe(
        "2 cmdOutletLoadOff",
      );
    });

    it("leaves a driver-private command with its raw label and no explanation", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      await sm.createCommandButtons("ups0", [{ name: "driver.private.thing" }]);
      const obj = objects.get("ups0.commands.driver-private-thing");
      expect((obj?.common.name as Record<string, string>).en).toBe("Driver private thing");
      expect(obj?.common.desc).toBeUndefined();
    });

    it("should create button states with dots→dashes and readable names", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.createCommandButtons("ups0", [{ name: "beeper.enable" }, { name: "load.off" }]);

      expect(objects.has("ups0.commands")).toBe(true);
      expect(objects.has("ups0.commands.beeper-enable")).toBe(true);
      expect(objects.has("ups0.commands.load-off")).toBe(true);

      const common = objects.get("ups0.commands.beeper-enable")?.common;
      expect(common?.role).toBe("button");
      expect(common?.write).toBe(true);
      expect(common?.read).toBe(false);
      expect(common?.name).toHaveProperty("en");
      expect(common?.name).toHaveProperty("de");
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  describe("refreshInstanceObjects", () => {
    it("re-applies all six manifest objects with name and description", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.refreshInstanceObjects();

      // Asserted on the SET of ids, not on a count: a manifest object added later must be
      // added here too, and this is the assertion that says so.
      for (const id of [
        "info",
        "info.connection",
        "info.upsTotal",
        "info.upsReachable",
        "info.allUpsReachable",
        "notify",
      ]) {
        const common = objects.get(id)?.common as any;
        expect(common?.name, id).toBeDefined();
        expect(common?.desc, id).toBeDefined();
      }
    });

    it("overwrites a name an older version left behind", async () => {
      // The whole point: js-controller preserves common.name when it re-applies the manifest,
      // so without this call a renamed data point keeps its old label forever.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      objects.set("info.upsTotal", {
        type: "state",
        common: { name: { en: "Ancient label" }, type: "number", role: "value" },
        native: {},
      });

      await sm.refreshInstanceObjects();

      expect((objects.get("info.upsTotal")?.common.name as any).en).not.toBe("Ancient label");
      expect((objects.get("info.upsTotal")?.common as any).type).toBe("number");
    });
  });

  describe("pruneObjectTree — devices of UPSes the server no longer lists", () => {
    it("should remove devices not in current set", async () => {
      const { adapter, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main");
      await sm.ensureUpsDevice("ups1", "Backup");

      await sm.pruneObjectTree(new Set(["ups0"]));

      expect(deletedIds).toContain("ups1");
      expect(deletedIds).not.toContain("ups0");
    });

    it("should not delete anything if all UPS are current", async () => {
      const { adapter, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main");
      deletedIds.length = 0;

      await sm.pruneObjectTree(new Set(["ups0"]));

      expect(deletedIds).toHaveLength(0);
    });

    it("should clear createdIds cache for removed devices", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main");
      await sm.pruneObjectTree(new Set());

      // After cleanup, re-creating should work (not cached)
      objects.clear();
      await sm.ensureUpsDevice("ups0", "Re-created");
      expect(objects.has("ups0")).toBe(true);
    });

    it("should log removal", async () => {
      const { adapter, logs } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main");
      await sm.pruneObjectTree(new Set());

      expect(logs.some(l => l.includes("Removing stale UPS device: ups0"))).toBe(true);
    });

    it("a UPS that comes back gets its manufacturer+model name again", async () => {
      // Since design #25 a UPS can vanish and return within one runtime — the poll re-reads
      // LIST UPS. The derived-name memory has to go with the deleted device, or updateDeviceName
      // believes it already wrote that name and the returning device keeps the bare UPS id.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      const vars = [
        { name: "device.mfr", value: "Eaton" },
        { name: "device.model", value: "Ellipse PRO 1600" },
      ];

      await sm.ensureUpsDevice("ups0", "Description unavailable");
      await sm.updateDeviceName("ups0", "Description unavailable", vars);
      expect((objects.get("ups0")?.common.name as any).en).toBe("Eaton Ellipse PRO 1600");

      // Gone from the NUT server …
      await sm.pruneObjectTree(new Set());
      objects.clear();

      // … and back on the next poll.
      await sm.ensureUpsDevice("ups0", "Description unavailable");
      expect((objects.get("ups0")?.common.name as any).en).toBe("ups0");
      await sm.updateDeviceName("ups0", "Description unavailable", vars);
      expect((objects.get("ups0")?.common.name as any).en).toBe("Eaton Ellipse PRO 1600");
    });

    it("drops the NUT-name map and a held recording of the removed UPS", async () => {
      // Both maps are keyed by state id, so a stale entry survives the device it belonged to:
      // the name map would answer for an id that no longer exists, and a held recording would be
      // handed to a fresh state of a UPS that has nothing to do with it.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main");
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "80" }], new Set());
      expect(sm.nutNameForState("ups0.battery.charge")).toBe("battery.charge");

      // A recording waiting for a successor that never gets created.
      objects.set("ups0.info.online", {
        type: "state",
        common: { name: "old", custom: { "history.0": { enabled: true } } },
        native: {},
      });
      await sm.pruneObjectTree(new Set());

      expect(sm.nutNameForState("ups0.battery.charge")).toBeUndefined();
    });

    it("a returning UPS may report its first garbage value again", async () => {
      const { adapter, logs } = createMockAdapter();
      const sm = new StateManager(adapter);
      const warns = (): string[] => logs.filter(l => l.startsWith("WARN:") && l.includes("Discarding non-numeric"));

      await sm.ensureUpsDevice("ups0", "Main");
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "Infinity" }], new Set());
      expect(warns()).toHaveLength(1);

      await sm.pruneObjectTree(new Set());
      await sm.ensureUpsDevice("ups0", "Main");
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "Infinity" }], new Set());
      expect(warns()).toHaveLength(2);
    });

    it("the garbage warning is deduplicated per UPS, not fleet-wide", async () => {
      // The message names the UPS, so a second UPS reporting the same junk has to be able to
      // say so once as well — a name-only key silenced it.
      const { adapter, logs } = createMockAdapter();
      const sm = new StateManager(adapter);
      const warns = (): string[] => logs.filter(l => l.startsWith("WARN:") && l.includes("Discarding non-numeric"));

      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "Infinity" }], new Set());
      await sm.updateVariables("ups1", [{ name: "battery.charge", value: "Infinity" }], new Set());

      expect(warns()).toHaveLength(2);
      expect(warns()[0]).toContain("ups0");
      expect(warns()[1]).toContain("ups1");
    });
  });

  // -----------------------------------------------------------------------
  // createdIds cache
  // -----------------------------------------------------------------------
  describe("createdIds cache", () => {
    it("should not call setObjectNotExistsAsync twice for same id", async () => {
      let callCount = 0;
      const { adapter } = createMockAdapter();
      const originalSetObj = adapter.setObjectNotExistsAsync;
      adapter.setObjectNotExistsAsync = (...args: any[]) => {
        callCount++;
        return Promise.resolve(originalSetObj(...args));
      };

      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "100" }], new Set());

      const firstCount = callCount;

      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "95" }], new Set());

      // Second call should skip object creation (cached)
      expect(callCount).toBe(firstCount);
    });
  });

  // -----------------------------------------------------------------------
  // Dot-path edge cases
  // -----------------------------------------------------------------------
  describe("dot-path handling", () => {
    it("should handle battery.charge and battery.charge.low with dash conversion", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [
          { name: "battery.charge", value: "100" },
          { name: "battery.charge.low", value: "15" },
        ],
        new Set(),
      );

      expect(objects.has("ups0.battery.charge")).toBe(true);
      expect(objects.has("ups0.battery.charge-low")).toBe(true);
      expect(states.get("ups0.battery.charge")?.val).toBe(100);
      expect(states.get("ups0.battery.charge-low")?.val).toBe(15);
    });

    it("should handle driver.version variants with dash conversion", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [
          { name: "driver.version", value: "2.8.0" },
          { name: "driver.version.data", value: "MGE HID 1.46" },
          { name: "driver.version.internal", value: "0.47" },
        ],
        new Set(),
      );

      expect(objects.has("ups0.driver.version")).toBe(true);
      expect(objects.has("ups0.driver.version-data")).toBe(true);
      expect(objects.has("ups0.driver.version-internal")).toBe(true);
      expect(states.get("ups0.driver.version")?.val).toBe("2.8.0");
    });

    it("should handle outlet paths with dash conversion", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [
          { name: "outlet.desc", value: "Main Outlet" },
          { name: "outlet.1.desc", value: "PowerShare 1" },
          { name: "outlet.1.status", value: "on" },
          { name: "outlet.2.desc", value: "PowerShare 2" },
        ],
        new Set(),
      );

      expect(objects.has("ups0.outlet.desc")).toBe(true);
      expect(objects.has("ups0.outlet.1-desc")).toBe(true);
      expect(objects.has("ups0.outlet.1-status")).toBe(true);
      expect(objects.has("ups0.outlet.2-desc")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Full Eaton PRO 1600 scenario
  // -----------------------------------------------------------------------
  describe("Eaton PRO 1600 scenario", () => {
    it("processes the complete LIST VAR set of one sample device (Eaton PRO 1600, 54 variables)", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      // ONE real sample device — NOT the universe of NUT variables. This Eaton happens to
      // expose these 54; the adapter is dynamic and creates states for whatever a driver
      // reports. Variables this device does NOT have (three-phase, ambient/EMP sensors,
      // outlet groups, other vendors' vars) are covered by the next test. Captured live from
      // a real Eaton PRO 1600: battery 4, device 4, driver 10, input 5,
      // outlet 11, output 4, ups 16 = 54.
      const vars = [
        // battery (4)
        { name: "battery.charge", value: "100" },
        { name: "battery.charge.low", value: "15" },
        { name: "battery.runtime", value: "2050" },
        { name: "battery.type", value: "PbAc" },
        // device (4)
        { name: "device.mfr", value: "EATON" },
        { name: "device.model", value: "Ellipse PRO 1600 " },
        { name: "device.serial", value: "G364T29133" },
        { name: "device.type", value: "ups" },
        // driver (10)
        { name: "driver.flag.ignorelb", value: "enabled" },
        { name: "driver.name", value: "usbhid-ups" },
        { name: "driver.parameter.pollfreq", value: "30" },
        { name: "driver.parameter.pollinterval", value: "2" },
        { name: "driver.parameter.port", value: "auto" },
        { name: "driver.parameter.synchronous", value: "auto" },
        { name: "driver.version", value: "2.8.0" },
        { name: "driver.version.data", value: "MGE HID 1.46" },
        { name: "driver.version.internal", value: "0.47" },
        { name: "driver.version.usb", value: "libusb-1.0.26 (API: 0x1000109)" },
        // input (5)
        { name: "input.frequency", value: "50.0" },
        { name: "input.transfer.high", value: "285" },
        { name: "input.transfer.low", value: "165" },
        { name: "input.voltage", value: "221.0" },
        { name: "input.voltage.extended", value: "no" },
        // outlet (11)
        { name: "outlet.desc", value: "Main Outlet" },
        { name: "outlet.id", value: "1" },
        { name: "outlet.switchable", value: "no" },
        { name: "outlet.1.desc", value: "PowerShare Outlet 1" },
        { name: "outlet.1.id", value: "2" },
        { name: "outlet.1.status", value: "on" },
        { name: "outlet.1.switchable", value: "no" },
        { name: "outlet.2.desc", value: "PowerShare Outlet 2" },
        { name: "outlet.2.id", value: "3" },
        { name: "outlet.2.status", value: "on" },
        { name: "outlet.2.switchable", value: "no" },
        // output (4)
        { name: "output.frequency", value: "50.0" },
        { name: "output.frequency.nominal", value: "50" },
        { name: "output.voltage", value: "223.0" },
        { name: "output.voltage.nominal", value: "230" },
        // ups (16)
        { name: "ups.beeper.status", value: "enabled" },
        { name: "ups.delay.shutdown", value: "20" },
        { name: "ups.delay.start", value: "30" },
        { name: "ups.firmware", value: "01.18.0022" },
        { name: "ups.load", value: "15" },
        { name: "ups.mfr", value: "EATON" },
        { name: "ups.model", value: "Ellipse PRO 1600 " },
        { name: "ups.power", value: "159" },
        { name: "ups.power.nominal", value: "1600" },
        { name: "ups.productid", value: "ffff" },
        { name: "ups.realpower", value: "147" },
        { name: "ups.serial", value: "G364T29133" },
        { name: "ups.status", value: "OL" },
        { name: "ups.timer.shutdown", value: "-1" },
        { name: "ups.timer.start", value: "-1" },
        { name: "ups.vendorid", value: "0463" },
      ];
      expect(vars).toHaveLength(54);

      // The 9 writable variables (LIST RW ups0).
      const rw = new Set([
        "input.transfer.high",
        "input.transfer.low",
        "input.voltage.extended",
        "outlet.1.desc",
        "outlet.2.desc",
        "outlet.desc",
        "output.voltage.nominal",
        "ups.delay.shutdown",
        "ups.delay.start",
      ]);
      await sm.updateVariables("ups0", vars, rw);

      // A state object exists for every one of the 54 variables (distinct ids).
      expect([...objects.values()].filter(o => o.type === "state")).toHaveLength(54);

      // Numbers (dots→dashes after the channel), incl. negative + nominal
      expect(states.get("ups0.battery.charge")?.val).toBe(100);
      expect(states.get("ups0.battery.runtime")?.val).toBe(2050);
      expect(states.get("ups0.battery.charge-low")?.val).toBe(15);
      expect(states.get("ups0.input.voltage")?.val).toBe(221.0);
      expect(states.get("ups0.ups.realpower")?.val).toBe(147);
      // -1 means "no countdown running" — the datapoint is empty, not minus one second.
      expect(states.get("ups0.ups.timer-shutdown")?.val).toBeNull();
      expect(states.get("ups0.output.frequency-nominal")?.val).toBe(50);

      // Strings — trailing space, leading zeros, hex-looking id, known-string suffix/prefix
      expect(states.get("ups0.battery.type")?.val).toBe("PbAc");
      expect(states.get("ups0.device.model")?.val).toBe("Ellipse PRO 1600"); // padding trimmed
      expect(states.get("ups0.ups.status")?.val).toBe("OL");
      expect(states.get("ups0.ups.vendorid")?.val).toBe("0463");
      expect(states.get("ups0.ups.productid")?.val).toBe("ffff");
      expect(states.get("ups0.outlet.1-status")?.val).toBe("on");

      // Booleans — yes/no fields become real boolean states, not text.
      expect(states.get("ups0.input.voltage-extended")?.val).toBe(false);

      // Writable variable carries write:true
      expect(objects.get("ups0.ups.delay-shutdown")?.common.write).toBe(true);

      // All seven NUT channels created
      for (const ch of ["battery", "device", "driver", "input", "outlet", "output", "ups"]) {
        expect(objects.has(`ups0.${ch}`)).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Standard NUT coverage beyond the one sample device
  // -----------------------------------------------------------------------
  describe("standard NUT coverage beyond the sample device", () => {
    it("handles three-phase, ambient/EMP and outlet-group variables the Eaton lacks", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      // Real NUT 2.8.5 standard variables (docs/nut-names.txt) that
      // the single Eaton sample never reports — the adapter must create them just the same.
      const vars = [
        // three-phase, incl. phase-pair names that ALREADY contain a dash
        { name: "input.phases", value: "3" },
        { name: "input.L1.current", value: "133.0" },
        { name: "input.L2.current", value: "48.2" },
        { name: "input.L3-L1.voltage", value: "405.4" },
        { name: "input.bypass.L1-L2.voltage", value: "398.3" },
        // ambient / EMP environment sensors (the spec's "n" → instance 1)
        { name: "ambient.count", value: "2" },
        { name: "ambient.1.name", value: "sensor 1" },
        { name: "ambient.1.temperature", value: "23.5" },
        { name: "ambient.1.humidity", value: "45" },
        { name: "ambient.1.temperature.status", value: "good" },
        // outlet groups
        { name: "outlet.group.count", value: "2" },
        { name: "outlet.group.1.name", value: "Branch Circuit A" },
        { name: "outlet.group.1.voltage", value: "244.23" },
        { name: "outlet.group.1.status", value: "on" },
        { name: "outlet.group.1.phase", value: "L1" },
      ];
      await sm.updateVariables("ups0", vars, new Set());

      // Dash conversion survives names that already contain a dash (phase pairs): only the
      // dot after the channel becomes a dash, the existing L3-L1 / L1-L2 dashes stay.
      expect(states.get("ups0.input.L3-L1-voltage")?.val).toBe(405.4);
      expect(objects.get("ups0.input.L3-L1-voltage")?.common.unit).toBe("V");
      expect(states.get("ups0.input.bypass-L1-L2-voltage")?.val).toBe(398.3);
      expect(states.get("ups0.input.L1-current")?.val).toBe(133.0);
      expect(objects.get("ups0.input.L1-current")?.common.unit).toBe("A");

      // Ambient / EMP — numbers with units, known-string name, status as text
      expect(states.get("ups0.ambient.1-temperature")?.val).toBe(23.5);
      expect(objects.get("ups0.ambient.1-temperature")?.common.unit).toBe("°C");
      expect(states.get("ups0.ambient.1-humidity")?.val).toBe(45);
      expect(objects.get("ups0.ambient.1-humidity")?.common.unit).toBe("%");
      expect(objects.get("ups0.ambient.1-name")?.common.type).toBe("string");

      // Outlet groups
      expect(states.get("ups0.outlet.group-1-voltage")?.val).toBe(244.23);
      expect(states.get("ups0.outlet.group-1-name")?.val).toBe("Branch Circuit A");
      expect(states.get("ups0.outlet.group-1-status")?.val).toBe("on");

      // Channels the Eaton sample never created
      expect(objects.has("ups0.ambient")).toBe(true);
      expect(objects.has("ups0.outlet")).toBe(true);
      expect(objects.has("ups0.input")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // nutVarToStateId
  // -----------------------------------------------------------------------
  describe("nutVarToStateId", () => {
    it("should convert dots after channel to dashes", () => {
      expect(nutVarToStateId("ups0", "battery.charge.low")).toBe("ups0.battery.charge-low");
    });

    it("should keep single-dot variables unchanged", () => {
      expect(nutVarToStateId("ups0", "battery.charge")).toBe("ups0.battery.charge");
    });

    it("should handle no-dot variables", () => {
      expect(nutVarToStateId("ups0", "status")).toBe("ups0.status");
    });

    it("should convert multiple dots", () => {
      expect(nutVarToStateId("ups0", "driver.version.internal")).toBe("ups0.driver.version-internal");
      expect(nutVarToStateId("ups0", "driver.reload.or.error")).toBe("ups0.driver.reload-or-error");
    });
  });

  // -----------------------------------------------------------------------
  // nutVarToReadableName
  // -----------------------------------------------------------------------
  describe("nutVarToReadableName", () => {
    it("should format leaf part as readable name", () => {
      expect(nutVarToReadableName("battery.charge.low")).toBe("Charge low");
    });

    it("should handle single-dot variables", () => {
      expect(nutVarToReadableName("battery.charge")).toBe("Charge");
    });

    it("should handle no-dot variables", () => {
      expect(nutVarToReadableName("status")).toBe("Status");
    });

    it("should capitalize first letter only", () => {
      expect(nutVarToReadableName("ups.delay.shutdown")).toBe("Delay shutdown");
    });
  });

  // -----------------------------------------------------------------------
  // cleanupLegacyObjects
  // -----------------------------------------------------------------------
  describe("pruneObjectTree — orphaned roots and v0.1.0 dot-style ids", () => {
    it("should remove root-level orphans from old adapter", async () => {
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("battery", { type: "channel", common: { name: "Battery" }, native: {} });
      objects.set("battery.charge", { type: "state", common: { name: "charge" }, native: {} });
      objects.set("commands", { type: "channel", common: { name: "Commands" }, native: {} });

      await sm.ensureUpsDevice("ups0", "Main UPS");
      await sm.pruneObjectTree(new Set(["ups0"]));

      expect(deletedIds).toContain("battery");
      expect(deletedIds).toContain("commands");
    });

    it("should not remove info or known UPS objects", async () => {
      const { adapter, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");
      await sm.pruneObjectTree(new Set(["ups0"]));

      expect(deletedIds).not.toContain("info");
      expect(deletedIds).not.toContain("ups0");
    });

    it("must not eat the root-level notify trigger state as an orphan", async () => {
      // `notify` is a static instance object at the root — it is NOT a UPS device,
      // so without an exemption the orphan sweep would delete it on every discover.
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("notify", { type: "state", common: { name: "Trigger" }, native: {} });

      await sm.ensureUpsDevice("ups0", "Main UPS");
      await sm.pruneObjectTree(new Set(["ups0"]));

      expect(deletedIds).not.toContain("notify");
      expect(objects.has("notify")).toBe(true);
    });

    it("should remove v0.1.0 dot-style objects under known UPS", async () => {
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0", { type: "device", common: { name: "Main" }, native: {} });
      objects.set("ups0.battery", { type: "channel", common: { name: "Battery" }, native: {} });
      objects.set("ups0.battery.charge", { type: "state", common: { name: "charge" }, native: {} });
      objects.set("ups0.battery.charge.low", { type: "state", common: { name: "charge.low" }, native: {} });
      objects.set("ups0.driver.version.data", { type: "state", common: { name: "version.data" }, native: {} });

      await sm.pruneObjectTree(new Set(["ups0"]));

      expect(deletedIds).toContain("ups0.battery.charge.low");
      expect(deletedIds).toContain("ups0.driver.version.data");
      expect(deletedIds).not.toContain("ups0.battery.charge");
      expect(deletedIds).not.toContain("ups0.battery");
      expect(deletedIds).not.toContain("ups0");
    });

    it("should delete deepest dot-style objects first", async () => {
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0", { type: "device", common: { name: "Main" }, native: {} });
      // Shallow object FIRST: the mock hands objects back in insertion order, so only the
      // depth sort can put the deeper one in front (deep-first insertion would pass without it).
      objects.set("ups0.a.b.c", { type: "state", common: { name: "mid" }, native: {} });
      objects.set("ups0.a.b.c.d", { type: "state", common: { name: "deep" }, native: {} });

      await sm.pruneObjectTree(new Set(["ups0"]));

      const dIdx = deletedIds.indexOf("ups0.a.b.c.d");
      const cIdx = deletedIds.indexOf("ups0.a.b.c");
      expect(dIdx).toBeLessThan(cIdx);
    });
  });

  // -----------------------------------------------------------------------
  // cleanupDeprecatedInfoStates (called from ensureUpsDevice)
  // -----------------------------------------------------------------------
  describe("cleanupDeprecatedInfoStates", () => {
    it("should delete legacy info.name, info.description and the renamed info.online on device init", async () => {
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0.info.name", { type: "state", common: { name: "UPS Name" }, native: {} });
      objects.set("ups0.info.description", { type: "state", common: { name: "Description" }, native: {} });
      // 0.4.0 renamed info.online → info.reachable; the old state must be cleaned up, not
      // left frozen at its last value (ioBroker does not auto-remove abandoned states).
      objects.set("ups0.info.online", { type: "state", common: { name: "Online" }, native: {} });

      await sm.ensureUpsDevice("ups0", "Main UPS");

      expect(deletedIds).toContain("ups0.info.name");
      expect(deletedIds).toContain("ups0.info.description");
      expect(deletedIds).toContain("ups0.info.online");
      // The replacement must still be created (and must NOT be deleted by the cleanup).
      expect(objects.has("ups0.info.reachable")).toBe(true);
      expect(deletedIds).not.toContain("ups0.info.reachable");
    });

    it("should not fail when deprecated states do not exist", async () => {
      const { adapter } = createMockAdapter();
      const sm = new StateManager(adapter);

      await expect(sm.ensureUpsDevice("ups0", "Main UPS")).resolves.not.toThrow();
    });

    it("runs the deprecated-state cleanup only once per runtime, not on every reconnect", async () => {
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0.info.online", { type: "state", common: { name: "Online" }, native: {} });

      await sm.ensureUpsDevice("ups0", "Main UPS"); // first connect → cleanup runs
      await sm.ensureUpsDevice("ups0", "Main UPS"); // reconnect → cleanup must be skipped (cached)

      expect(deletedIds.filter(id => id === "ups0.info.online")).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // enrichStateMetadata
  // -----------------------------------------------------------------------
  describe("enrichStateMetadata", () => {
    it("should set common.states via extendObject", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0.output.voltage-nominal", {
        type: "state",
        common: { type: "number", role: "level", name: "Voltage nominal" },
        native: {},
      });

      await sm.enrichStateMetadata("ups0.output.voltage-nominal", {
        states: { 200: "200", 208: "208", 220: "220", 230: "230", 240: "240" },
      });

      const common = objects.get("ups0.output.voltage-nominal")?.common as any;
      expect(common.states).toEqual({ 200: "200", 208: "208", 220: "220", 230: "230", 240: "240" });
    });

    it("translates the value labels of a LIST ENUM answer", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0.ups.beeper-status", {
        type: "state",
        common: { type: "string", role: "text", name: "Beeper status" },
        native: {},
      });

      // LIST ENUM answers with the raw NUT tokens — the labels must still follow the system
      // language, the values stay the tokens the write path needs.
      await sm.enrichStateMetadata("ups0.ups.beeper-status", {
        states: { enabled: "enabled", disabled: "disabled", muted: "muted" },
      });

      const common = objects.get("ups0.ups.beeper-status")?.common as any;
      expect(common.states).toEqual({ enabled: "valEnabled", disabled: "valDisabled", muted: "valMuted" });
    });

    it("a token the catalog does not know keeps the server's own word as its label", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0.ups.vendor-mode", {
        type: "state",
        common: { type: "string", role: "text", name: "Vendor mode" },
        native: {},
      });

      await sm.enrichStateMetadata("ups0.ups.vendor-mode", { states: { on: "on", vendorX: "vendorX" } });

      const common = objects.get("ups0.ups.vendor-mode")?.common as any;
      expect(common.states).toEqual({ on: "valOn", vendorX: "vendorX" });
    });

    it("the enrichment does not undo the translated labels updateVariables just wrote", async () => {
      // The seam that produced the defect: both modules were only ever tested on their own, so
      // nobody saw that the poll runs updateVariables FIRST (localized labels) and the enrichment
      // SECOND (raw tokens) on the very same object.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables(
        "ups0",
        [{ name: "ups.beeper.status", value: "enabled" }],
        new Set(["ups.beeper.status"]),
      );
      const afterCatalog = (objects.get("ups0.ups.beeper-status")?.common as any).states;
      expect(afterCatalog).toEqual({ enabled: "valEnabled", disabled: "valDisabled", muted: "valMuted" });

      await sm.enrichStateMetadata("ups0.ups.beeper-status", {
        states: { enabled: "enabled", disabled: "disabled", muted: "muted" },
      });

      expect((objects.get("ups0.ups.beeper-status")?.common as any).states).toEqual(afterCatalog);
    });

    it("should set common.min and common.max via extendObject", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      objects.set("ups0.ups.delay-shutdown", {
        type: "state",
        common: { type: "number", role: "level", name: "Delay shutdown" },
        native: {},
      });

      await sm.enrichStateMetadata("ups0.ups.delay-shutdown", { min: 10, max: 300 });

      const common = objects.get("ups0.ups.delay-shutdown")?.common as any;
      expect(common.min).toBe(10);
      expect(common.max).toBe(300);
    });

    it("should not call extendObject when patch is empty", async () => {
      let extendCalled = false;
      const { adapter } = createMockAdapter();
      const origExtend = adapter.extendObject;
      adapter.extendObject = (...args: any[]) => {
        extendCalled = true;
        return Promise.resolve(origExtend(...args));
      };
      const sm = new StateManager(adapter);

      await sm.enrichStateMetadata("ups0.some.state", {});

      expect(extendCalled).toBe(false);
    });
  });

  describe("a value list that shrinks", () => {
    it("drops a value the device no longer offers instead of leaving it in the dropdown", async () => {
      // extendObject merges key by key, so a dropped entry would linger and stay writable.
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      objects.set("ups0.device.type", {
        type: "state",
        common: { type: "string", role: "text", name: "Device type", states: { ups: "ups", pdu: "pdu", gone: "gone" } },
        native: {},
      });

      await sm.updateVariables("ups0", [{ name: "device.type", value: "ups" }], new Set());

      const states = objects.get("ups0.device.type")?.common.states as Record<string, string>;
      expect(states).toBeDefined();
      expect(Object.keys(states)).not.toContain("gone");
    });

    it("replaces the enum list from the NUT server instead of merging into the old one", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);
      objects.set("ups0.output.voltage-nominal", {
        type: "state",
        common: {
          type: "string",
          role: "text",
          name: "Nominal voltage",
          states: { 200: "200", 230: "230", 240: "240" },
        },
        native: {},
      });

      await sm.enrichStateMetadata("ups0.output.voltage-nominal", { states: { 230: "230", 240: "240" } });

      expect(objects.get("ups0.output.voltage-nominal")?.common.states).toEqual({ 230: "230", 240: "240" });
    });

    it("touches nothing when the state has no value list yet", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.enrichStateMetadata("ups0.ups.delay-shutdown", { min: 10, max: 300 });

      const common = objects.get("ups0.ups.delay-shutdown")?.common;
      expect(common?.min).toBe(10);
      expect(common?.states).toBeUndefined();
    });
  });

  describe("a renamed datapoint keeps the user's recording", () => {
    it("carries the recording of info.online over to info.reachable before removing it", async () => {
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);
      objects.set("ups0.info.online", {
        type: "state",
        common: { type: "boolean", role: "indicator", name: "Online", custom: { "influxdb.0": { enabled: true } } },
        native: {},
      });

      await sm.ensureUpsDevice("ups0", "Main UPS");

      expect(deletedIds).toContain("ups0.info.online");
      expect(objects.get("ups0.info.reachable")?.common.custom).toEqual({ "influxdb.0": { enabled: true } });
    });

    it("carries the recording of a v0.1.0 dot-style datapoint over to its new id", async () => {
      // ups0.battery.charge.low is the SAME datapoint as ups0.battery.charge-low — a move.
      const { adapter, objects, deletedIds } = createMockAdapter();
      const sm = new StateManager(adapter);
      objects.set("ups0", { type: "device", common: { name: "Main UPS" }, native: {} });
      objects.set("ups0.battery.charge.low", {
        type: "state",
        common: { type: "number", role: "value", name: "Low", custom: { "history.0": { enabled: true } } },
        native: {},
      });

      await sm.pruneObjectTree(new Set(["ups0"]));
      expect(deletedIds).toContain("ups0.battery.charge.low");
      // The successor is built by the first poll — the recording waits for it.
      await sm.updateVariables("ups0", [{ name: "battery.charge.low", value: "20" }], new Set());

      expect(objects.get("ups0.battery.charge-low")?.common.custom).toEqual({ "history.0": { enabled: true } });
    });

    it("does not invent a recording where the predecessor had none — not even an empty one", async () => {
      // An EMPTY custom is the case that matters: writing it through would leave an empty
      // recording block on the successor and claim in the log that something was carried.
      const { adapter, objects, logs } = createMockAdapter();
      const sm = new StateManager(adapter);
      objects.set("ups0.info.online", {
        type: "state",
        common: { type: "boolean", role: "indicator", name: "Online", custom: {} },
        native: {},
      });

      await sm.ensureUpsDevice("ups0", "Main UPS");

      const successor = objects.get("ups0.info.reachable")!;
      expect("custom" in successor.common).toBe(false);
      expect(logs.some(l => l.includes("Kept the recording"))).toBe(false);
    });

    it("does not touch the successor when the predecessor does not exist at all", async () => {
      const { adapter, objects, logs } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");

      expect("custom" in objects.get("ups0.info.reachable")!.common).toBe(false);
      expect(logs.some(l => l.includes("Kept the recording"))).toBe(false);
    });
  });

  describe("object ownership — the adapter owns name and description, the user owns the recording", () => {
    it("passes no preserve option, so a hand-written name is overwritten on the next sync", async () => {
      const seen: (Record<string, unknown> | undefined)[] = [];
      const { adapter, objects } = createMockAdapter();
      const orig = adapter.extendObject;
      adapter.extendObject = (...args: any[]) => {
        seen.push(args[2]);
        return Promise.resolve(orig(...args));
      };
      const sm = new StateManager(adapter);

      await sm.ensureUpsDevice("ups0", "Main UPS");
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "100" }], new Set());
      objects.get("ups0.battery.charge")!.common.name = "Renamed by hand";
      (sm as unknown as { createdIds: Set<string> }).createdIds.delete("ups0.battery.charge");
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "100" }], new Set());

      expect(seen.every(o => o === undefined)).toBe(true);
      expect(objects.get("ups0.battery.charge")?.common.name).not.toBe("Renamed by hand");
    });

    it("leaves a recording configuration untouched when the metadata is refreshed", async () => {
      const { adapter, objects } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "100" }], new Set());
      objects.get("ups0.battery.charge")!.common.custom = { "influxdb.0": { enabled: true } };
      (sm as unknown as { createdIds: Set<string> }).createdIds.delete("ups0.battery.charge");
      await sm.updateVariables("ups0", [{ name: "battery.charge", value: "100" }], new Set());

      expect(objects.get("ups0.battery.charge")?.common.custom).toEqual({ "influxdb.0": { enabled: true } });
    });
  });

  describe("updateVariables — dotless variable (#4)", () => {
    it("stores a dotless variable as a real state under the device, not a colliding channel", async () => {
      const { adapter, objects, states } = createMockAdapter();
      const sm = new StateManager(adapter);

      await sm.updateVariables("ups0", [{ name: "ALARM", value: "On battery" }], new Set());

      const obj = objects.get("ups0.ALARM");
      expect(obj?.type).toBe("state");
      expect(obj?.common.type).toBe("string");
      expect(states.get("ups0.ALARM")?.val).toBe("On battery");
    });
  });
});

describe("sanitizeUpsName", () => {
  it("passes clean alphanumeric/underscore/dash names through unchanged", () => {
    expect(sanitizeUpsName("ups0")).toBe("ups0");
    expect(sanitizeUpsName("my-ups_2")).toBe("my-ups_2");
  });

  it("replaces spaces, dots and forbidden chars with underscore (object-ID safe)", () => {
    expect(sanitizeUpsName("my ups!")).toBe("my_ups_");
    expect(sanitizeUpsName("rack.a")).toBe("rack_a");
    expect(sanitizeUpsName("ups@home#1")).toBe("ups_home_1");
  });
});

describe("update migration — changed datapoints are updated in place", () => {
  it("upgrades an existing string state to boolean when the detected type changes (driver.flag)", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter);
    // An older adapter version stored driver.flag.ignorelb as opaque text, and the user renamed it.
    objects.set("ups0.driver.flag-ignorelb", {
      type: "state",
      common: { type: "string", role: "text", name: "My flag", read: true, write: false },
      native: {},
    });

    await sm.updateVariables("ups0", [{ name: "driver.flag.ignorelb", value: "enabled" }], new Set());

    const obj = objects.get("ups0.driver.flag-ignorelb");
    expect(obj?.common.type).toBe("boolean"); // datapoint type migrated in place
    expect(obj?.common.role).toBe("indicator");
    expect(obj?.common.name).not.toBe("My flag"); // the adapter owns the name and rewrites it
  });

  it("adds common.states to an existing enum-less state on update (device.type)", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter);
    objects.set("ups0.device.type", {
      type: "state",
      common: { type: "string", role: "text", name: "Device type" },
      native: {},
    });

    await sm.updateVariables("ups0", [{ name: "device.type", value: "ups" }], new Set());

    const obj = objects.get("ups0.device.type");
    // The values stay the NUT tokens; only their LABELS follow the system language.
    expect(obj?.common.states).toEqual({
      ups: "valUps",
      pdu: "valPdu",
      scd: "valScd",
      psu: "valPsu",
      ats: "valAts",
    });
  });
});

describe("markAllUnreachable", () => {
  it("resets info.reachable to false for every known UPS device", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.ensureUpsDevice("ups0", "Main UPS");
    await sm.ensureUpsDevice("ups1", "Second UPS");
    states.set("ups0.info.reachable", { val: true, ack: true });
    states.set("ups1.info.reachable", { val: true, ack: true });

    await sm.markAllUnreachable();

    expect(states.get("ups0.info.reachable")).toEqual({ val: false, ack: true });
    expect(states.get("ups1.info.reachable")).toEqual({ val: false, ack: true });
  });

  it("skips devices without an info.reachable state instead of writing a missing id", async () => {
    const { adapter, objects, states } = createMockAdapter();
    const sm = new StateManager(adapter);
    objects.set("legacy", { type: "device", common: { name: "Device from an older layout" }, native: {} });

    await sm.markAllUnreachable();

    expect(states.has("legacy.info.reachable")).toBe(false);
  });

  it("ignores channels and states — only device objects carry the online indicator", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.ensureUpsDevice("ups0", "Main UPS");
    await sm.updateVariables("ups0", [{ name: "ups.status", value: "OL" }], new Set());

    await sm.markAllUnreachable();

    expect(states.get("ups0.info.reachable")).toEqual({ val: false, ack: true });
    expect(states.get("ups0.ups.status")).toEqual({ val: "OL", ack: true });
  });
});

describe("UPS summary states", () => {
  it("writes how many UPSes there are and how many answer", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter as never);

    await sm.writeUpsSummary(3, 2);

    expect(states.get("info.upsTotal")).toEqual({ val: 3, ack: true });
    expect(states.get("info.upsReachable")).toEqual({ val: 2, ack: true });
    expect(states.get("info.allUpsReachable")).toEqual({ val: false, ack: true });
  });

  it("says all reachable only when every UPS answers", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter as never);

    await sm.writeUpsSummary(2, 2);

    expect(states.get("info.allUpsReachable")).toEqual({ val: true, ack: true });
  });

  it("does not claim all-reachable while no UPS is known at all", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter as never);

    await sm.writeUpsSummary(0, 0);

    // 0 of 0 is not "everything is fine" — it means nothing was found.
    expect(states.get("info.allUpsReachable")).toEqual({ val: false, ack: true });
  });

  it("takes the summary down with the devices when nothing is being read", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter as never);
    states.set("info.upsTotal", { val: 3, ack: true });
    states.set("info.upsReachable", { val: 3, ack: true });
    states.set("info.allUpsReachable", { val: true, ack: true });
    await sm.markAllUnreachable();

    // The count of UPSes that exist is still the best estimate — only the
    // "how many answer" part drops.
    expect(states.get("info.upsTotal")).toEqual({ val: 3, ack: true });
    expect(states.get("info.upsReachable")).toEqual({ val: 0, ack: true });
    expect(states.get("info.allUpsReachable")).toEqual({ val: false, ack: true });
  });
});

describe("a value that no longer fits its data point", () => {
  // The object is written ONCE per runtime (createdIds), and design #16 forbids re-typing it
  // between polls. Before this guard the VALUE went in anyway: a string landed in a
  // `type: "boolean"` data point and stood there until the next adapter restart, breaking every
  // script that trusts the declared type. js-controller only logs it at info level, once per
  // change (validator.js `performStrictObjectCheck`, reached from `_setStateChangedHelper` when
  // the value differs), so nothing loud ever pointed at it.

  it("keeps a driver.flag data point boolean and discards a value that stopped being one", async () => {
    const { adapter, objects, states, logs } = createMockAdapter();
    const sm = new StateManager(adapter);

    await sm.updateVariables("ups0", [{ name: "driver.flag.ignorelb", value: "enabled" }], new Set());
    expect(objects.get("ups0.driver.flag-ignorelb")?.common.type).toBe("boolean");
    expect(states.get("ups0.driver.flag-ignorelb")).toEqual({ val: true, ack: true });

    // parseFlagValue does not recognise "2" → detectType falls back to an opaque string.
    await sm.updateVariables("ups0", [{ name: "driver.flag.ignorelb", value: "2" }], new Set());
    expect(objects.get("ups0.driver.flag-ignorelb")?.common.type).toBe("boolean");
    // The value did NOT change — the last good one stands instead of a string in a boolean field.
    expect(states.get("ups0.driver.flag-ignorelb")).toEqual({ val: true, ack: true });
    expect(logs.filter(l => l.startsWith("WARN") && l.includes("driver.flag.ignorelb"))).toHaveLength(1);

    // …and it stays quiet from then on.
    await sm.updateVariables("ups0", [{ name: "driver.flag.ignorelb", value: "3" }], new Set());
    expect(logs.filter(l => l.startsWith("WARN") && l.includes("driver.flag.ignorelb"))).toHaveLength(1);
  });

  it("also guards a numeric variable the unit catalog does not know", async () => {
    // `expectedNumeric` only ever fired for variables detectUnit recognises — a unit-less numeric
    // (input.phases has no unit rule) slipped straight through into a `type: "number"` object.
    const { adapter, objects, states, logs } = createMockAdapter();
    const sm = new StateManager(adapter);

    await sm.updateVariables("ups0", [{ name: "input.phases", value: "1" }], new Set());
    expect(objects.get("ups0.input.phases")?.common.type).toBe("number");
    expect(states.get("ups0.input.phases")).toEqual({ val: 1, ack: true });

    await sm.updateVariables("ups0", [{ name: "input.phases", value: "n/a" }], new Set());
    expect(states.get("ups0.input.phases")).toEqual({ val: 1, ack: true });
    expect(logs.some(l => l.startsWith("WARN") && l.includes("input.phases"))).toBe(true);
  });

  it("still stores null — an idle countdown is 'no value', not a type mismatch", async () => {
    const { adapter, states } = createMockAdapter();
    const sm = new StateManager(adapter);
    // The HID drivers report -1 for "no countdown running" → parsedValue null on a number state.
    await sm.updateVariables("ups0", [{ name: "ups.timer.shutdown", value: "-1" }], new Set());
    expect(states.get("ups0.ups.timer-shutdown")).toEqual({ val: null, ack: true });
  });

  it("re-types the object across an adapter restart — the freeze is per runtime, not forever", async () => {
    const { adapter, objects } = createMockAdapter();
    await new StateManager(adapter).updateVariables("ups0", [{ name: "driver.flag.x", value: "enabled" }], new Set());
    expect(objects.get("ups0.driver.flag-x")?.common.type).toBe("boolean");

    // A fresh StateManager is what a restarted adapter has: createdIds is empty again.
    await new StateManager(adapter).updateVariables("ups0", [{ name: "driver.flag.x", value: "2" }], new Set());
    expect(objects.get("ups0.driver.flag-x")?.common.type).toBe("string");
  });
});

describe("a dotless variable must not take a channel's id", () => {
  // NUT 2.8.5 emits none (all 321 literal dstate_setinfo names carry a dot; the "bare ALARM" is a
  // VALUE of ups.status), but the adapter accepts any name a server sends — and dotless names sort
  // first, so without this guard the state always won the id and the channel's children ended up
  // hanging beneath a state object.

  it("skips a dotless variable named like an adapter-owned channel and says so once", async () => {
    const { adapter, objects, logs } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.updateVariables("ups0", [{ name: "status", value: "OL" }], new Set());
    expect(objects.has("ups0.status")).toBe(false);
    expect(logs.filter(l => l.startsWith("WARN") && l.includes("'status'"))).toHaveLength(1);

    // The status channel is now free to be created as a CHANNEL, with its flags below it.
    await sm.updateStatusFlags("ups0", "OL");
    expect(objects.get("ups0.status")?.type).toBe("channel");
    expect(objects.has("ups0.status.raw")).toBe(true);

    await sm.updateVariables("ups0", [{ name: "status", value: "OB" }], new Set());
    expect(logs.filter(l => l.startsWith("WARN") && l.includes("'status'"))).toHaveLength(1);
  });

  it("skips a dotless variable that collides with a NUT channel in the same batch", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.updateVariables(
      "ups0",
      [
        { name: "battery", value: "something" },
        { name: "battery.charge", value: "80" },
      ],
      new Set(),
    );
    expect(objects.get("ups0.battery")?.type).toBe("channel");
    expect(objects.get("ups0.battery.charge")?.common.type).toBe("number");
  });

  it("creates a harmless dotless variable normally", async () => {
    const { adapter, objects, states } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.updateVariables("ups0", [{ name: "SOMEVAR", value: "42" }], new Set(["SOMEVAR"]));
    expect(objects.get("ups0.SOMEVAR")?.common.write).toBe(true);
    expect(states.get("ups0.SOMEVAR")).toEqual({ val: 42, ack: true });
    // The lossless reverse lookup is what makes it writable through onStateChange.
    expect(sm.nutNameForState("ups0.SOMEVAR")).toBe("SOMEVAR");
  });
});

describe("bounds never outlive the LIST RANGE that produced them", () => {
  it("clears min/max when the enrichment no longer reports them", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.updateVariables("ups0", [{ name: "battery.charge.low", value: "20" }], new Set(["battery.charge.low"]));
    await sm.enrichStateMetadata("ups0.battery.charge-low", { min: 10, max: 50 });
    expect(objects.get("ups0.battery.charge-low")?.common).toMatchObject({ min: 10, max: 50 });

    // A driver update drops the range: the caller now says so explicitly instead of staying silent.
    await sm.enrichStateMetadata("ups0.battery.charge-low", { min: null, max: null });
    // GONE, not null: `common.min` must be a number, and the object-structure checker rejects a
    // null there (E1004) — writing null was the first thing the inventory gate ever caught here.
    const common = objects.get("ups0.battery.charge-low")?.common ?? {};
    expect("min" in common).toBe(false);
    expect("max" in common).toBe(false);
    // …and the rest of the object survived the replacing write.
    expect(common.type).toBe("number");
    expect(common.unit).toBe("%");
  });

  it("clears stale bounds at the next adapter start, even when nothing enriches any more", async () => {
    // The variable stopped being writable, so the enrichment never visits it again — the bounds
    // used to stand forever, with js-controller warning about every value outside them.
    const { adapter, objects } = createMockAdapter();
    await new StateManager(adapter).updateVariables(
      "ups0",
      [{ name: "battery.charge.low", value: "20" }],
      new Set(["battery.charge.low"]),
    );
    await new StateManager(adapter).enrichStateMetadata("ups0.battery.charge-low", { min: 10, max: 50 });
    expect(objects.get("ups0.battery.charge-low")?.common).toMatchObject({ min: 10, max: 50 });

    await new StateManager(adapter).updateVariables("ups0", [{ name: "battery.charge.low", value: "20" }], new Set());
    const after = objects.get("ups0.battery.charge-low")?.common ?? {};
    expect("min" in after).toBe(false);
    expect("max" in after).toBe(false);
    expect(after.write).toBe(false);
  });

  it("keeps the user's recording when it removes an attribute", async () => {
    // Removal replaces the whole object, so `common.custom` is the thing that could get lost —
    // it belongs to the user, and a repair of adapter-owned metadata must never cost it (#31).
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.updateVariables("ups0", [{ name: "battery.charge.low", value: "20" }], new Set(["battery.charge.low"]));
    await sm.enrichStateMetadata("ups0.battery.charge-low", { min: 10, max: 50 });
    const obj = objects.get("ups0.battery.charge-low");
    assert(obj, "the state has to exist before the recording is attached");
    obj.common.custom = { "history.0": { enabled: true } };

    await sm.enrichStateMetadata("ups0.battery.charge-low", { min: null, max: null });
    expect(objects.get("ups0.battery.charge-low")?.common.custom).toEqual({ "history.0": { enabled: true } });
  });

  it("clears a value list that shrank to nothing", async () => {
    const { adapter, objects } = createMockAdapter();
    const sm = new StateManager(adapter);
    await sm.updateVariables("ups0", [{ name: "ups.beeper.status", value: "enabled" }], new Set());
    expect(Object.keys(objects.get("ups0.ups.beeper-status")?.common.states ?? {})).toContain("muted");

    await sm.enrichStateMetadata("ups0.ups.beeper-status", { states: null });
    expect("states" in (objects.get("ups0.ups.beeper-status")?.common ?? {})).toBe(false);
  });
});

describe("mutation-audit gaps (2026-09-06)", () => {
  it("reads the adapter namespace ONCE for the whole prune, not once per pass", async () => {
    // Since design #25 the prune runs on every (re)connect and every change of the UPS list. It
    // used to be two public methods with a full `getAdapterObjectsAsync()` each, back to back.
    const { adapter, objects } = createMockAdapter();
    objects.set("ups0", { type: "device", common: {}, native: {} });
    objects.set("gone", { type: "device", common: {}, native: {} });
    objects.set("orphan.leaf", { type: "state", common: {}, native: {} });
    let reads = 0;
    const real = adapter.getAdapterObjectsAsync;
    adapter.getAdapterObjectsAsync = () => {
      reads += 1;
      return real();
    };

    await new StateManager(adapter).pruneObjectTree(new Set(["ups0"]));
    expect(reads).toBe(1);
  });

  it("does not report a removed UPS a second time as an orphan of an older version", async () => {
    // The order is why the prune is ONE method: the device pass deletes, and the later passes must
    // not judge the same snapshot again — "orphan from a previous adapter version" is the wrong
    // sentence for a UPS the user has just unplugged.
    const { adapter, objects, logs, deletedIds } = createMockAdapter();
    objects.set("gone", { type: "device", common: {}, native: {} });
    objects.set("gone.battery", { type: "channel", common: {}, native: {} });

    await new StateManager(adapter).pruneObjectTree(new Set(["ups0"]));

    expect(logs.filter(l => l.includes("Removing stale UPS device: gone"))).toHaveLength(1);
    expect(logs.filter(l => l.includes("orphaned root object"))).toHaveLength(0);
    expect(deletedIds).toContain("gone");
  });

  it("collapses BOTH variant segments — a sensor contact is named and explained", async () => {
    // `ambient.1.contacts.1.status` carries two of them. Collapsing only the first left
    // `ambient.contacts.1.status`, a name no catalog knows — so the data point had neither a
    // translated label nor an explanation, while its single-segment siblings did.
    const { adapter, objects } = createMockAdapter();
    await new StateManager(adapter).updateVariables(
      "ups0",
      [
        { name: "ambient.1.contacts.1.status", value: "closed" },
        { name: "ambient.1.temperature", value: "22.5" },
      ],
      new Set(),
    );
    const contact = objects.get("ups0.ambient.1-contacts-1-status")?.common ?? {};
    expect(contact.desc, "the two-segment name must reach the catalog too").toBeDefined();
    expect(contact.name).toBeDefined();
    // …and the one-segment sibling keeps working.
    expect(objects.get("ups0.ambient.1-temperature")?.common.desc).toBeDefined();
  });
});
