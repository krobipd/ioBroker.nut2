/**
 * Two guards around the checked-in object inventory that no fleet gate can see.
 *
 * The decision "explained or self-explaining" itself is NOT here: since 2026-09-07 the fleet gate
 * `check-object-inventory.py` owns it and reads `test/self-explaining.json`, so a second list in
 * this file could only drift away from it. What stays are the two questions the gate cannot ask —
 * whether the checked-in dump still matches the fixtures that produced it, and whether the
 * explanations keep the house style across all eleven languages.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// `nutVarToStateId` lives in state-manager, which pulls in adapter-core — the mock keeps this
// file free of the real I18n singleton.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import { nutVarToStateId } from "./state-manager";

describe("inventory freshness", () => {
  it("every variable the fixtures declare has a data point in the inventory", () => {
    // The fleet gate judges a CHECKED-IN snapshot. Without this check, adding a variable to a
    // fixture and forgetting `npm run test:inventory` leaves both green on a file that does not
    // know the new variable — the gap would only surface at the next release. The expected ID
    // comes from the production mapping, not from a second one rebuilt here.
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

  it("every device icon in the inventory IS one of the pictogram files, and every known type has one (E12)", () => {
    // Read from what the real adapter wrote under js-controller, not from the loader: a path, a
    // re-encoded file or a device of a known type without an icon would all pass the unit tests.
    const root = join(__dirname, "..", "..");
    const inventory = JSON.parse(readFileSync(join(root, "test", "objects.inventory.json"), "utf8")) as Record<
      string,
      { type: string; common: { icon?: unknown } }
    >;
    const iconDir = join(root, "admin", "icons");
    const files = new Map(
      readdirSync(iconDir)
        .filter(f => f.endsWith(".svg"))
        .map(f => [readFileSync(join(iconDir, f), "utf8").replace(/\r\n/g, "\n"), f]),
    );
    const prefix = "data:image/svg+xml;base64,";
    const wrong: string[] = [];
    for (const [id, obj] of Object.entries(inventory)) {
      const icon = obj.common.icon;
      if (icon === undefined) {
        continue;
      }
      const decoded =
        typeof icon === "string" && icon.startsWith(prefix)
          ? Buffer.from(icon.slice(prefix.length), "base64").toString("utf8")
          : undefined;
      if (obj.type !== "device" || decoded === undefined || !files.has(decoded)) {
        wrong.push(id);
      }
    }
    expect(wrong, "icons that are not one of admin/icons/*.svg").toEqual([]);

    const dir = join(root, "test", "fixtures", "inventory");
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith(".json"))) {
      const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        name: string;
        vars: Record<string, string>;
      };
      const type = fixture.vars["device.type"];
      if (type === undefined || ![...files.values()].includes(`${type}.svg`)) {
        continue;
      }
      const icon = inventory[`nut2.0.${fixture.name}`]?.common.icon;
      const decoded = typeof icon === "string" ? Buffer.from(icon.slice(prefix.length), "base64").toString("utf8") : "";
      if (files.get(decoded) !== `${type}.svg`) {
        missing.push(`${fixture.name} (${type})`);
      }
    }
    expect(missing, "devices of a known type without their pictogram").toEqual([]);
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
