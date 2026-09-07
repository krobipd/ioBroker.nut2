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
// record), never from the maintainer's own UPS: the point is to cover every device type and every
// detection rule, not one Eaton.
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

const FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter(f => f.endsWith(".json"))
  .sort()
  .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")));

/** upsd quotes every value and escapes a backslash and a quote inside it (common/parseconf.c). */
function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A fake `upsd` speaking the NUT protocol on localhost, backed by the fixtures.
 *
 * The adapter talks plain TCP to a host:port, so a server inside the mocha process is all it takes
 * — no test seam in the production code, and nothing leaves the machine. Every command the adapter
 * can send is answered; anything else is refused, so a call the fixtures forgot shows up as an
 * error instead of silently doing nothing.
 */
function createFakeNutServer() {
  const byName = new Map(FIXTURES.map(f => [f.name, f]));

  const answer = cmd => {
    const [verb, ...args] = cmd.split(" ");
    if (verb === "LIST") {
      const [what, ups, varName] = args;
      const f = ups ? byName.get(ups) : null;
      if (what === "UPS") {
        return ["BEGIN LIST UPS", ...FIXTURES.map(x => `UPS ${x.name} ${quote(x.description)}`), "END LIST UPS"];
      }
      if (!f) {
        return ["ERR UNKNOWN-UPS"];
      }
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
    if (verb === "USERNAME" || verb === "PASSWORD" || verb === "SET" || verb === "INSTCMD") {
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
          socket.write(`${answer(cmd).join("\n")}\n`);
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
 * Adapter-specific: make the adapter create every object it can create. Waiting on a STATE the
 * adapter itself reports, never on "the tree stopped growing" — the UPSes are polled in one pass,
 * but the enrichment (LIST ENUM/RANGE) trails it.
 *
 * @param {object} harness the @iobroker/testing harness
 */
async function feedFixtures(harness) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const total = await harness.states.getStateAsync(`${NS}info.upsTotal`);
    const all = await harness.states.getStateAsync(`${NS}info.allUpsReachable`);
    if (total && total.val === FIXTURES.length && all && all.val === true) {
      break;
    }
    assert.ok(Date.now() < deadline, `the adapter never reached ${FIXTURES.length} reachable UPSes`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // One more full poll, so the enrichment that runs after the first pass has landed as well.
  await new Promise(resolve => setTimeout(resolve, 3000));
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
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(120000);
        fakePort = await fakeServer.start();
        harness = getHarness();
        await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative() });
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
        for (const f of FIXTURES) {
          assert.ok(objects[`${NS}${f.name}`], `device missing for fixture ${f.name}`);
          assert.ok(objects[`${NS}${f.name}.info.reachable`], `info.reachable missing for ${f.name}`);
          assert.ok(objects[`${NS}${f.name}.status.online`], `status flags missing for ${f.name}`);
        }
        // The command buttons and the writable variables only exist with both gates open —
        // an inventory without them would hide exactly the objects nobody else checks.
        assert.ok(objects[`${NS}ups-single-phase.commands.beeper-mute`], "command buttons missing");
        const writable = Object.values(objects).filter(o => o.common && o.common.write === true);
        assert.ok(writable.length >= 8, `expected writable variables, found ${writable.length}`);
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
          await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative() });
          await harness.startAdapterAndWait();
          await feedFixtures(harness);
        });

        after(async function () {
          this.timeout(30000);
          await fakeServer.stop();
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
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
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
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
