/**
 * Completeness of the naming catalogs: every NUT variable the adapter can create either carries an
 * explanation, or is listed here as self-explaining — with the decision visible instead of implied.
 *
 * The list of variables is not invented here: it is read back from the object inventory
 * (`test/objects.inventory.json`, produced by `npm run test:inventory` from the NUT 2.8.5 catalog),
 * so this test grows with the fixtures rather than with someone's memory.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import enJson from "../../admin/i18n/en.json";
import { nutVarToStateId } from "./state-manager";

/**
 * NUT variables whose NAME already says everything — an invented sentence would be worse than none
 * (design #34). Grouped by the reason, so the next reader can judge the call instead of trusting it.
 */
const SELF_EXPLAINING = new Set<string>([
  // Plain identification of the hardware — the label is the whole content.
  "device.mfr",
  "device.model",
  "device.serial",
  "device.description",
  "device.contact",
  "device.location",
  "ups.mfr",
  "ups.model",
  "ups.serial",
  "ups.id",
  "ups.type",
  "ups.vendorid",
  "ups.productid",
  "ups.firmware",
  "ups.firmware.aux",
  // Versions and dates — a sentence could only repeat the name.
  "driver.name",
  "driver.version",
  "driver.version.data",
  "driver.version.internal",
  "driver.version.usb",
  "ups.date",
  "ups.time",
  "ups.mfr.date",
  "battery.date",
  "battery.mfr.date",
]);

/**
 * Collapse every phase/instance segment, repeatedly until nothing changes.
 *
 * The state ID has already turned the variable's dots into dashes, so `input.L1-N.voltage` arrives
 * here as `input.L1.N.voltage` — two ADJACENT segments, and a single global pass consumes the dot
 * that the second one needs. Only the fixpoint gives the same base name the adapter looked up.
 *
 * @param name Variable name rebuilt from the state ID
 */
function collapseVariants(name: string): string {
  let previous;
  let current = name;
  do {
    previous = current;
    current = current.replace(/\.(\d+|L\d(-(L\d|N))?|N)\./g, ".");
  } while (current !== previous);
  return current;
}

/**
 * Every NUT variable in the inventory, with the phase/instance segment collapsed the way the
 * adapter collapses it, together with whether its data point actually carries an explanation.
 *
 * Read from the INVENTORY, not derived from a key name: the inventory is what the adapter really
 * wrote, so this measures the outcome instead of re-implementing the lookup (and it does not trip
 * over a variable whose camel-case key cannot be derived, such as `driver.flag.allow_killpower`).
 */
function variablesFromInventory(): Map<string, boolean> {
  const raw = readFileSync(join(__dirname, "..", "..", "test", "objects.inventory.json"), "utf8");
  const inventory = JSON.parse(raw) as Record<string, { type?: string; common?: { desc?: unknown } }>;
  const out = new Map<string, boolean>();
  for (const [id, obj] of Object.entries(inventory)) {
    const parts = id.split(".");
    // nut2 . 0 . <device> . <channel> . <leaf…> — anything shorter is an instance-wide object
    // (info.connection, notify), which is the adapter's own, not a NUT variable.
    if (obj.type !== "state" || parts.length < 5) {
      continue;
    }
    const seg = parts.slice(3);
    if (seg[0] === "info" || seg[0] === "status" || seg[0] === "commands") {
      continue;
    }
    const nut = collapseVariants(`${seg[0]}.${seg.slice(1).join(".").replace(/-/g, ".")}`);
    const has = Boolean(obj.common?.desc);
    out.set(nut, (out.get(nut) ?? false) || has);
  }
  return out;
}

/**
 * `driver.flag.*` and `driver.parameter.*` are OPEN namespaces — every driver may invent its own,
 * and the adapter cannot know what a private one means. The catalog explains the ones NUT itself
 * documents; the rest is deliberately left without a sentence rather than given an invented one.
 *
 * @param nut NUT variable name
 */
function isDriverPrivate(nut: string): boolean {
  return (
    (nut.startsWith("driver.flag.") || nut.startsWith("driver.parameter.")) &&
    !(
      `desc${nut
        .split(".")
        .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
        .join("")}`.replace(/^desc(.)/, (_, c: string) => `desc${c.toUpperCase()}`) in enJson
    )
  );
}

describe("catalog completeness", () => {
  it("every NUT variable the adapter creates is either explained or declared self-explaining", () => {
    const undecided = [...variablesFromInventory()]
      .filter(([nut, explained]) => !explained && !SELF_EXPLAINING.has(nut) && !isDriverPrivate(nut))
      .map(([nut]) => nut)
      .sort();
    expect(undecided, "variables with neither an explanation nor a self-explaining entry").toEqual([]);
  });

  it("the self-explaining list carries no variable that also has an explanation", () => {
    // A variable in both places means someone wrote a sentence and forgot to take it off the list —
    // the sentence wins, and the stale entry would hide the next real gap.
    const inventory = variablesFromInventory();
    const both = [...SELF_EXPLAINING].filter(nut => inventory.get(nut) === true).sort();
    expect(both, "listed as self-explaining although an explanation exists").toEqual([]);
  });

  it("the self-explaining list carries no variable the adapter never creates", () => {
    const inventory = variablesFromInventory();
    const unknown = [...SELF_EXPLAINING].filter(nut => !inventory.has(nut)).sort();
    expect(unknown, "self-explaining entries with no data point").toEqual([]);
  });
});

describe("inventory freshness", () => {
  it("every variable the fixtures declare has a data point in the inventory", () => {
    // `catalog completeness` reads a CHECKED-IN snapshot. Without this check, adding a variable to
    // a fixture and forgetting `npm run test:inventory` leaves vitest green on a file that does not
    // know the new variable — the gap would only surface at the next release. The expected ID comes
    // from the production mapping, not from a second one rebuilt here.
    const dir = join(__dirname, "..", "..", "test", "fixtures", "inventory");
    const inventory = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "test", "objects.inventory.json"), "utf8"),
    ) as Record<string, unknown>;
    const missing: string[] = [];
    for (const file of readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .sort()) {
      const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        name: string;
        vars: Record<string, string>;
      };
      for (const nutVar of Object.keys(fixture.vars)) {
        const id = `nut2.0.${nutVarToStateId(fixture.name, nutVar)}`;
        if (!(id in inventory)) {
          missing.push(`${file}: ${nutVar} -> ${id}`);
        }
      }
    }
    expect(
      missing,
      "fixture variables without a data point — regenerate: npm run build && npm run test:inventory",
    ).toEqual([]);
  });
});

describe("explanation style", () => {
  it("no explanation ends in a full stop, in ANY language", () => {
    // Measured house convention, not taste: before this guard the catalog held 103 explanations
    // without a closing stop and 149 with one, because a later wave brought its own habit along.
    // All eleven files, not just English — the wave put a stop into every one of them (and `。`
    // into zh-cn), so a guard that reads one file locks one eleventh of what it claims to.
    const dir = join(__dirname, "..", "..", "admin", "i18n");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .sort()) {
      const texts = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      for (const [key, text] of Object.entries(texts)) {
        if (key.startsWith("desc") && typeof text === "string" && /[.。]$/.test(text.trim())) {
          offenders.push(`${file}: ${key}`);
        }
      }
    }
    expect(offenders.sort(), "explanations ending in a full stop").toEqual([]);
  });
});
