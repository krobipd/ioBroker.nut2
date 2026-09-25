/**
 * Audit 6 / E6: every name the NUT 2.8.5 registries define gets a translated label, an explanation
 * (or a reasoned self-explaining entry) and the unit its catalog description states.
 *
 * The object inventory only sees what the fixtures report; a variable no fixture carries could stay
 * untranslated forever. This walks the registries themselves — test/nut-names-2.8.5.json, generated
 * from docs/nut-names.txt and data/cmdvartab of the NUT 2.8.5 release.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  },
}));

import {
  CATALOG_COMMANDS,
  commandCatalogEntry,
  nutVarToStateId,
  varDescription,
  varTranslation,
} from "./state-manager";
import { detectType } from "./type-detector";

const ROOT = join(__dirname, "..", "..");
const registry = JSON.parse(readFileSync(join(ROOT, "test", "nut-names-2.8.5.json"), "utf8")) as {
  variables: Record<string, string>;
  cmdvartabVariables: Record<string, string>;
  outletGroupDerived: string[];
  domains: string[];
  contexts: { voltage: string[]; current: string[]; power: string[] };
  specsWithContext: string[];
  specsWithoutContext: string[];
  commands: Record<string, string>;
  cmdvartabCommands: Record<string, string>;
};
const selfExplaining = Object.keys(
  JSON.parse(readFileSync(join(ROOT, "test", "self-explaining.json"), "utf8")) as Record<string, string>,
);

/**
 * Names the adapter can never receive from LIST VAR, with the reason. Nothing else is exempt.
 */
const NEVER_LISTED: Record<string, string> = {
  // server/netget.c:200-223 answers them to GET VAR only; LIST VAR (netlist.c) never carries them.
  "server.info": "upsd answers it to GET VAR only",
  "server.version": "upsd answers it to GET VAR only",
};

/**
 * `n`/`x` → a concrete index; the placeholder keys of the driver tables → a real key of that family.
 *
 * @param name Registry name
 */
function concrete(name: string): string {
  return name
    .replace(/\.[nx]\./g, ".1.")
    .replace(/^driver\.parameter\.xxx$/, "driver.parameter.port")
    .replace(/^driver\.flag\.xxx$/, "driver.flag.ignorelb");
}

/** DOMAIN(.CONTEXT).SPEC per nut-names.txt:520-638. */
function domainNames(): string[] {
  const out: string[] = [];
  for (const domain of registry.domains) {
    for (const spec of [...registry.specsWithContext, ...registry.specsWithoutContext]) {
      out.push(`${domain}.${spec}`);
    }
    for (const spec of registry.specsWithContext) {
      const contexts = spec.startsWith("voltage")
        ? registry.contexts.voltage
        : spec.startsWith("current")
          ? registry.contexts.current
          : registry.contexts.power;
      for (const ctx of contexts) {
        out.push(`${domain}.${ctx}.${spec}`);
      }
    }
  }
  return out;
}

const VARIABLES = [
  ...new Set(
    [
      ...Object.keys(registry.variables),
      ...Object.keys(registry.cmdvartabVariables),
      ...registry.outletGroupDerived,
      ...domainNames(),
    ]
      .filter(n => !(n in NEVER_LISTED))
      .map(concrete),
  ),
].sort();
const COMMANDS = [...Object.keys(registry.commands), ...Object.keys(registry.cmdvartabCommands)].map(concrete).sort();

/**
 * A self-explaining.json pattern against a local state id — the fleet gate's rule exactly
 * (check-object-inventory.py `_matches`): `*` stands for ONE whole id segment, nothing partial.
 *
 * @param stateId Local state id
 */
function explainedByPattern(stateId: string): boolean {
  const id = stateId.split(".");
  return selfExplaining.some(pattern => {
    const p = pattern.split(".");
    return p.length === id.length && p.every((seg, i) => seg === "*" || seg === id[i]);
  });
}

describe("catalog completeness against the NUT 2.8.5 registries (E6)", () => {
  it("the registry file is what it claims to be", () => {
    expect(Object.keys(registry.variables).length).toBeGreaterThan(200);
    expect(registry.commands["load.off"]).toBeDefined();
    expect(registry.cmdvartabCommands["driver.killpower"]).toBeDefined();
  });

  it("every variable has a translated label", () => {
    const missing = VARIABLES.filter(v => varTranslation(v) === undefined);
    expect(missing, "variables without a catalog label").toEqual([]);
  });

  it("every variable is explained — or reasoned self-explaining in test/self-explaining.json", () => {
    const missing = VARIABLES.filter(
      v => varDescription(v) === undefined && !explainedByPattern(nutVarToStateId("x", v)),
    );
    expect(missing, "variables neither explained nor reasoned self-explaining").toEqual([]);
  });

  it("every command has a catalog entry (label + explanation)", () => {
    const missing = COMMANDS.filter(c => commandCatalogEntry(c) === undefined);
    expect(missing, "commands without a catalog entry").toEqual([]);
  });

  it("⚠ marks exactly the commands that can cut power, leave the load unprotected or stop the driver", () => {
    // One rule for all eleven languages and every command: switching something ON is never marked,
    // switching it OFF (also "off and back on", "shut down") always is — whole UPS, outlet or group.
    const en = JSON.parse(readFileSync(join(ROOT, "admin", "i18n", "en.json"), "utf8")) as Record<string, string>;
    const risky = (cmd: string): boolean =>
      /(^|\.)load\.(off|cycle)(\.delay)?$/.test(cmd) ||
      /(^|\.)shutdown\.(default|return|stayoff|reboot|reboot\.graceful)$/.test(cmd) ||
      /(^|\.)bypass(\.ecomode)?\.start$/.test(cmd) ||
      ["input.off", "driver.exit", "driver.killpower", "driver.reload-or-exit", "experimental.ve-direct.set"].includes(
        cmd,
      );
    const wrong: string[] = [];
    const names = [...new Set([...COMMANDS, ...Object.keys(CATALOG_COMMANDS)])];
    for (const cmd of names) {
      const entry = commandCatalogEntry(cmd);
      if (!entry) {
        continue;
      }
      const descKey = `desc${entry.key[0].toUpperCase()}${entry.key.slice(1)}`;
      const marked = (en[descKey] ?? "").startsWith("⚠");
      if (marked !== risky(cmd)) {
        wrong.push(`${cmd}: ${marked ? "marked" : "not marked"}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every variable carries the unit its catalog description states", () => {
    // nut-names.txt / cmdvartab put the unit in parentheses: "Input voltage (V)".
    const UNIT_OF: Array<[RegExp, string]> = [
      [/\((?:V)\)/, "V"],
      [/\((?:A)\)/, "A"],
      [/\((?:Hz)\)/, "Hz"],
      [/\((?:W|Watts)\)/, "W"],
      [/\((?:VA|Volt-Amps)\)/, "VA"],
      [/\((?:Ah)\)/, "Ah"],
      [/\((?:degrees C)\)/, "°C"],
      [/\((?:degrees)\)/, "°"],
      [/\((?:seconds|seconds, floating-point)\)/, "s"],
      [/\((?:min)\)/, "min"],
      [/\((?:percent|percent of full|percent of nominal Hz)\)/, "%"],
    ];
    const described: Record<string, string> = {
      ...registry.variables,
      ...registry.cmdvartabVariables,
    };
    const wrong: string[] = [];
    for (const [name, text] of Object.entries(described)) {
      if (name in NEVER_LISTED) {
        continue;
      }
      const hit = UNIT_OF.find(([re]) => re.test(text));
      if (!hit) {
        continue;
      }
      const got = detectType(concrete(name), "1", false).unit;
      if (got !== hit[1]) {
        wrong.push(`${name}: catalog "${text}" → ${hit[1]}, adapter ${got ?? "none"}`);
      }
    }
    expect(wrong, "units that differ from the catalog").toEqual([]);
  });
});
