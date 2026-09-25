/* global describe, it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller against a fake
//   NUT server that serves EVERY device type the adapter supports (feedFixtures), then dump every
//   nut2.0.* object to test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is set — pre-release.py
//   exports the last tag's inventory): seed the previous objects BEFORE start, start, feed, then
//   assert that every object carries the current name/desc/role/type/unit and that removed objects
//   are gone.
//
// The fixtures come from the NUT 2.8.5 catalog (docs/nut-names.txt, the RFC 9271 document of
// record), the NUT Device Dump Library and the driver sources, never from the maintainer's own UPS:
// the point is to cover every device type and every detection rule, not one Eaton.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const FIXTURE_DIR = path.join(__dirname, "fixtures", "inventory");
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );

const FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter(f => f.endsWith(".json"))
  .sort()
  .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")));
/** The object id a fixture's UPS gets: its NUT name, unless the tree cannot take that name as it is. */
const idOf = f => f.id || f.name;
const LIVE = FIXTURES.filter(f => !f.stale);

/** Same mapping as src/lib/state-manager.ts nutVarToStateId: channel = first segment, dots → dashes after it. */
function stateIdOf(upsId, nutVar) {
  const dot = nutVar.indexOf(".");
  return dot < 0
    ? `${upsId}.${nutVar}`
    : `${upsId}.${nutVar.slice(0, dot)}.${nutVar.slice(dot + 1).replace(/\./g, "-")}`;
}

// A room the USER made, with the kinds of data point an upgrade rewrites: one with a value list
// (every UPS has status.severity), one catalog enum, one with LIST RANGE bounds — and one plain
// number as the control that nothing rewrites. Measured 2026-09-12 on a real js-controller: the
// first three LOST their room on every adapter start, because the rewrite went through delObject,
// which strikes the id from every enum. The assignment belongs to the user; no upgrade may cost it.
const USER_ROOM = "enum.rooms.inventory-audit";
const USER_ROOM_MEMBERS = [
  `${NS}ups-single-phase.status.severity`,
  `${NS}ups-single-phase.ups.beeper-status`,
  `${NS}ups-single-phase.battery.charge-low`,
  `${NS}ups-single-phase.battery.charge`,
];
// Data points an older version stored under another id: the adapter MOVES them (design #12/#51),
// and the room assignment has to move along. None of them is in the previous release's inventory —
// the seed adds them, so every move path runs on every upgrade run.
const MOVED = {
  // 0.4.0: info.online collided with the status.online / OL flag.
  [`${NS}ups-single-phase.info.online`]: `${NS}ups-single-phase.info.reachable`,
  // 0.6.0: the non-standard flag name was replaced by the real ECO token.
  [`${NS}ups-single-phase.status.highEfficiency`]: `${NS}ups-single-phase.status.ecoMode`,
  // 0.1.0: dots after the channel instead of dashes.
  [`${NS}ups-single-phase.input.transfer.high`]: `${NS}ups-single-phase.input.transfer-high`,
};

/**
 * upsd quotes every value and escapes a backslash, a quote and a '#' inside it (common/parseconf.c
 * pconf_encode, PCONF_ESCAPE "#\\\"").
 */
function quote(value) {
  return `"${String(value).replace(/[\\"#]/g, c => `\\${c}`)}"`;
}

/**
 * A fake `upsd` speaking the NUT protocol on localhost, backed by the fixtures.
 *
 * The adapter talks plain TCP to a host:port, so a server inside the mocha process is all it takes
 * — no test seam in the production code, and nothing leaves the machine. Every command the adapter
 * can send is answered the way upsd 2.8.5 answers it; anything else is refused, so a call the
 * fixtures forgot shows up as an error instead of silently doing nothing.
 */
function createFakeNutServer() {
  const byName = new Map(FIXTURES.map(f => [f.name, f]));
  let trackingSeq = 0;

  /** A command addressed to a UPS: unknown → UNKNOWN-UPS, lost driver → DATA-STALE (server/netlist.c, sstate.c). */
  const upsError = ups => {
    const f = byName.get(ups);
    return !f ? ["ERR UNKNOWN-UPS"] : f.stale ? ["ERR DATA-STALE"] : null;
  };
  /** SET VAR / INSTCMD acknowledgement: "OK TRACKING <id>" once the client asked for it (server/netset.c:183). */
  const accepted = conn => {
    if (!conn.tracking) {
      return ["OK"];
    }
    const id = `00000000-0000-0000-0000-${String(++trackingSeq).padStart(12, "0")}`;
    conn.ids.add(id);
    return [`OK TRACKING ${id}`];
  };

  const answer = (cmd, conn) => {
    const [verb, ...args] = cmd.split(" ");
    if (verb === "VER") {
      return ["Network UPS Tools upsd 2.8.5 - https://www.networkupstools.org/"];
    }
    if (verb === "NETVER") {
      return ["1.3"];
    }
    if (verb === "STARTTLS") {
      return ["ERR FEATURE-NOT-CONFIGURED"];
    }
    if (verb === "LIST") {
      const [what, ups, varName] = args;
      if (what === "UPS") {
        return ["BEGIN LIST UPS", ...FIXTURES.map(x => `UPS ${x.name} ${quote(x.description)}`), "END LIST UPS"];
      }
      const bad = upsError(ups);
      if (bad) {
        return bad;
      }
      const f = byName.get(ups);
      if (what === "VAR") {
        return [
          `BEGIN LIST VAR ${ups}`,
          ...Object.entries(f.vars).map(([k, v]) => `VAR ${ups} ${k} ${quote(v)}`),
          `END LIST VAR ${ups}`,
        ];
      }
      if (what === "RW") {
        return [
          `BEGIN LIST RW ${ups}`,
          ...Object.entries(f.rw).map(([k, v]) => `RW ${ups} ${k} ${quote(v)}`),
          `END LIST RW ${ups}`,
        ];
      }
      if (what === "CMD") {
        return [`BEGIN LIST CMD ${ups}`, ...f.cmd.map(c => `CMD ${ups} ${c}`), `END LIST CMD ${ups}`];
      }
      if (what === "ENUM") {
        const values = f.enum[varName] || [];
        return [
          `BEGIN LIST ENUM ${ups} ${varName}`,
          ...values.map(v => `ENUM ${ups} ${varName} ${quote(v)}`),
          `END LIST ENUM ${ups} ${varName}`,
        ];
      }
      if (what === "RANGE") {
        const ranges = f.range[varName] || [];
        return [
          `BEGIN LIST RANGE ${ups} ${varName}`,
          ...ranges.map(([lo, hi]) => `RANGE ${ups} ${varName} ${quote(lo)} ${quote(hi)}`),
          `END LIST RANGE ${ups} ${varName}`,
        ];
      }
      return ["ERR INVALID-ARGUMENT"];
    }
    if (verb === "GET") {
      const [what, ups, name] = args;
      if (what === "TRACKING") {
        // server/netget.c:273-284 — without SET TRACKING ON the feature is not configured.
        if (!conn.tracking) {
          return ["ERR FEATURE-NOT-CONFIGURED"];
        }
        return [conn.ids.has(ups) ? "SUCCESS" : "ERR UNKNOWN"];
      }
      const bad = upsError(ups);
      if (bad) {
        return bad;
      }
      const f = byName.get(ups);
      if (what === "VAR") {
        return name in f.vars ? [`VAR ${ups} ${name} ${quote(f.vars[name])}`] : ["ERR VAR-NOT-SUPPORTED"];
      }
      if (what === "DESC") {
        return [`DESC ${ups} ${name} "Description unavailable"`];
      }
      if (what === "CMDDESC") {
        return [`CMDDESC ${ups} ${name} "Description unavailable"`];
      }
      return ["ERR INVALID-ARGUMENT"];
    }
    if (verb === "SET") {
      if (args[0] === "TRACKING") {
        // server/netset.c:215-243
        if (args[1] !== "ON" && args[1] !== "OFF") {
          return ["ERR INVALID-ARGUMENT"];
        }
        conn.tracking = args[1] === "ON";
        return ["OK"];
      }
      return upsError(args[1]) || accepted(conn);
    }
    if (verb === "INSTCMD") {
      return upsError(args[0]) || accepted(conn);
    }
    if (verb === "USERNAME" || verb === "PASSWORD") {
      return ["OK"];
    }
    if (verb === "LOGIN") {
      return byName.has(args[0]) ? ["OK"] : ["ERR UNKNOWN-UPS"];
    }
    if (verb === "LOGOUT") {
      return ["OK Goodbye"];
    }
    return ["ERR UNKNOWN-COMMAND"];
  };

  const open = new Set();
  const server = net.createServer(socket => {
    const conn = { tracking: false, ids: new Set() };
    let buffer = "";
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.setEncoding("utf8");
    socket.on("error", () => {}); // a client that vanishes is not a test failure
    socket.on("data", chunk => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const cmd = line.replace(/\r$/, "").trim();
        if (cmd) {
          socket.write(`${answer(cmd, conn).join("\n")}\n`);
        }
      }
    });
  });

  return {
    start: () => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    // `close()` only stops listening — it waits for every open connection, and the adapter is
    // still holding one while it shuts down. Drop them, or the teardown hangs. (`net.Server` has
    // no `closeAllConnections()`; that one belongs to `http.Server`.)
    stop: () =>
      new Promise(resolve => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}

const fakeServer = createFakeNutServer();
let fakePort = 0;
/** Adapter-specific config the fixtures need: the fake NUT server and both safety gates open. */
function fixtureNative() {
  return {
    host: "127.0.0.1",
    port: fakePort,
    networkInterface: "0.0.0.0",
    pollInterval: 2,
    // Plaintext on purpose: `username`/`password` are `encryptedNative` (io-package.json), and
    // @iobroker/testing >= 6 encrypts exactly those fields itself in `changeAdapterConfig`
    // (`encryptNativeChanges`). Under 5.x it did NOT — the plaintext went into the instance object
    // untouched, js-controller decrypted it on start, and the adapter received XOR noise against
    // the system secret. Whenever that noise held a space, the credential guard (design #46)
    // refused to send it and the inventory silently lost every command button. Pre-encrypting here
    // would now be encrypted a SECOND time; the version floor in package.json is what keeps this
    // correct.
    username: "inventory",
    password: "inventory",
    useTls: false,
    tlsRejectUnauthorized: false,
    tlsCaFile: "",
    commandTimeout: 5,
    // Both gates open on purpose: with them shut the adapter creates neither the command
    // buttons nor the writable variables, and the inventory would silently miss them.
    enableCommands: true,
    enableSetVar: true,
  };
}

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration, which expects a host restart the harness never performs. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function resetInstanceNative(harness) {
  const wanted = fixtureNative();
  const instance = await harness.objects.getObjectAsync(`system.adapter.${ADAPTER}.0`);
  const stale = {};
  for (const key of Object.keys((instance && instance.native) || {})) {
    if (!Object.hasOwn(wanted, key)) stale[key] = null;
  }
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...wanted } });
}

/**
 * Adapter-specific: wait until the adapter has really DONE its work — for both suites. The
 * fixtures are fed by the fake upsd the adapter polls, so "feeding" is waiting for a poll.
 *
 * The seed of suite 2 writes OBJECTS only, never a value, so state VALUES are the signal it cannot
 * fake: per UPS the two values every poll writes unconditionally — `status.raw` (written after the
 * variables, the device name and before the enrichment's successor poll) and `info.reachable` —
 * plus the instance summary. A UPS whose driver is stale only gets `info.reachable = false`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForAdapterWork(harness) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const missing = [];
    const total = await harness.states.getStateAsync(`${NS}info.upsTotal`);
    const reachable = await harness.states.getStateAsync(`${NS}info.upsReachable`);
    if (!total || total.val !== FIXTURES.length) missing.push(`info.upsTotal = ${FIXTURES.length}`);
    if (!reachable || reachable.val !== LIVE.length) missing.push(`info.upsReachable = ${LIVE.length}`);
    for (const f of FIXTURES) {
      const r = await harness.states.getStateAsync(`${NS}${idOf(f)}.info.reachable`);
      if (!r || r.val !== !f.stale) missing.push(`${idOf(f)}.info.reachable = ${!f.stale}`);
      if (!f.stale && !(await harness.states.getStateAsync(`${NS}${idOf(f)}.status.raw`))) {
        missing.push(`${idOf(f)}.status.raw`);
      }
    }
    if (missing.length === 0) return;
    assert.ok(Date.now() < deadline, `no completed poll — still waiting for ${missing.slice(0, 5).join(", ")}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Wait for REST, not for a period: the dump is read once its content stayed identical across one
 * full poll interval (8 × 250 ms at pollInterval 2 s). A fixed pause is calibrated on one machine;
 * the CI runner is slower, and a dump taken in the middle of the enrichment (LIST ENUM/RANGE trails
 * the first pass) gives another inventory than the release run.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForStableTree(harness) {
  const deadline = Date.now() + 60000;
  let last = "";
  let calm = 0;
  while (calm < 8) {
    assert.ok(Date.now() < deadline, "the object tree never came to rest");
    await new Promise(resolve => setTimeout(resolve, 250));
    const now = canonical(await dumpObjects(harness));
    calm = now === last ? calm + 1 : 0;
    last = now;
  }
}

/** Adapter-specific: make the adapter create every object it can create. */
async function feedFixtures(harness) {
  await waitForAdapterWork(harness);
  await waitForStableTree(harness);
}

async function dumpObjects(harness) {
  // The range starts at "nut2.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(120000);
        fakePort = await fakeServer.start();
        harness = getHarness();
        await resetInstanceNative(harness);
        await harness.startAdapterAndWait();
        await feedFixtures(harness);
      });

      after(async function () {
        this.timeout(30000);
        await fakeServer.stop();
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("covers every fixture device and every channel the adapter can build", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        const missing = [];
        for (const f of FIXTURES) {
          const id = `${NS}${idOf(f)}`;
          const channels = new Set(["info"]);
          if (!f.stale) {
            for (const v of Object.keys(f.vars)) {
              if (v.includes(".")) channels.add(v.slice(0, v.indexOf(".")));
            }
            if ("ups.status" in f.vars) channels.add("status");
            if (f.cmd.length > 0) channels.add("commands");
          }
          if (!objects[id] || objects[id].type !== "device") missing.push(`${id} (device)`);
          for (const ch of channels) {
            const obj = objects[`${id}.${ch}`];
            if (!obj || obj.type !== "channel") missing.push(`${id}.${ch} (channel)`);
          }
          // No commands channel without commands: an empty channel or an execute field that can
          // never run anything is noise in the tree.
          if (f.cmd.length === 0 && objects[`${id}.commands`]) missing.push(`${id}.commands should not exist`);
          if (!f.stale && !objects[`${id}.info.reachable`]) missing.push(`${id}.info.reachable`);
        }
        assert.deepStrictEqual(
          missing,
          [],
          `devices/channels the fixtures should have produced:\n${missing.join("\n")}`,
        );

        // Writability against CONCRETE ids: every LIST RW variable with the set-variable gate open
        // (driver.flag.* stays read-only by design #16) — and nothing else outside the command and
        // trigger objects. A count would pass with the wrong eight.
        const expected = LIVE.flatMap(f =>
          Object.keys(f.rw)
            .filter(v => !v.startsWith("driver.flag."))
            .map(v => `${NS}${stateIdOf(idOf(f), v)}`),
        ).sort();
        const writable = Object.entries(objects)
          .filter(([, o]) => o.common && o.common.write === true)
          .map(([id]) => id)
          .filter(id => !id.includes(".commands.") && id !== `${NS}notify`)
          .sort();
        assert.deepStrictEqual(writable, expected, "writable variables");
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(120000);
          fakePort = await fakeServer.start();
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          // …plus the data points older versions kept under another id, shaped like their successor.
          for (const [oldId, newId] of Object.entries(MOVED)) {
            const shape = previous[newId] || {
              type: "state",
              common: { name: "legacy", type: "boolean", role: "indicator", read: true, write: false },
              native: {},
            };
            await harness.objects.setObjectAsync(oldId, JSON.parse(JSON.stringify(shape)));
          }
          // …and the user has put some of its data points into a room, the moved ones included.
          await harness.objects.setObjectAsync(USER_ROOM, {
            type: "enum",
            common: { name: "Inventory audit", members: [...USER_ROOM_MEMBERS, ...Object.keys(MOVED)] },
            native: {},
          });
          await resetInstanceNative(harness);
          await harness.startAdapterAndWait();
          // The seeded set makes an object wait worthless here — waitForAdapterWork reads values.
          await feedFixtures(harness);
        });

        after(async function () {
          this.timeout(30000);
          await fakeServer.stop();
        });

        it("the user's room assignments survive the upgrade — moved data points included", async function () {
          this.timeout(30000);
          const room = await harness.objects.getObjectAsync(USER_ROOM);
          const members = (room && room.common && room.common.members) || [];
          const wanted = [...USER_ROOM_MEMBERS, ...Object.values(MOVED)];
          const lost = wanted.filter(id => !members.includes(id));
          assert.deepStrictEqual(lost, [], `data points the upgrade struck from the user's room:\n${lost.join("\n")}`);
          const stale = Object.keys(MOVED).filter(id => members.includes(id));
          assert.deepStrictEqual(stale, [], "the room still lists the old ids");
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            // The object KIND (state/channel/folder) first — it is not `common.type` (that is the
            // value type), and comparing only `common` would let a failed type migration pass green.
            if (got.type !== obj.type) {
              stale.push(`${id}: still type "${got.type}", expected "${obj.type}"`);
            }
            for (const f of COMPARED) {
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          // A variable the device no longer reports keeps its data point and channel (design #25: a
          // driver may skip a variable for a poll, and a deletion would cost the user's history and
          // room). The fixtures of the previous release declared variables the current ones do not;
          // those are kept by design, not left over by the release.
          const ups = new Set(FIXTURES.map(idOf));
          const keptByDesign = id => {
            const [upsId, channel] = id.slice(NS.length).split(".");
            return (
              !(id in MOVED) &&
              ups.has(upsId) &&
              channel !== undefined &&
              !["info", "status", "commands"].includes(channel)
            );
          };
          const seeded = [...Object.keys(previous), ...Object.keys(MOVED)];
          const leftovers = seeded.filter(id => !(id in current) && id in live && !keptByDesign(id));
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
