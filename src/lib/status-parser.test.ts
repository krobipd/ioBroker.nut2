import { ALL_FLAG_KEYS, FLAG_META, getDisplayEntries, parseStatus, STATUS_FLAGS } from "./status-parser";

describe("status-parser", () => {
  // -----------------------------------------------------------------------
  // Individual flags
  // -----------------------------------------------------------------------
  describe("flag parsing", () => {
    it("should parse OL as online", () => {
      const r = parseStatus("OL");
      expect(r.flags.online).toBe(true);
      expect(r.flags.onBattery).toBe(false);
    });

    it("ignores an unknown token instead of inventing a flag", () => {
      // NUT drivers emit private tokens (ACFAIL, COMMFAULT, …) the spec lets
      // clients ignore. Setting a flag for them would create a state named
      // after "undefined" in the object tree.
      const r = parseStatus("OL ACFAIL TIP");
      expect(Object.keys(r.flags).sort()).toEqual([...ALL_FLAG_KEYS].sort());
      expect(Object.prototype.hasOwnProperty.call(r.flags, "undefined")).toBe(false);
      expect(r.flags.online).toBe(true);
      // The raw string keeps them, so nothing is lost for diagnosis.
      expect(r.raw).toContain("ACFAIL");
    });

    it("should parse OB as onBattery", () => {
      expect(parseStatus("OB").flags.onBattery).toBe(true);
    });

    it("should parse LB as lowBattery", () => {
      expect(parseStatus("LB").flags.lowBattery).toBe(true);
    });

    it("should parse HB as highBattery", () => {
      expect(parseStatus("HB").flags.highBattery).toBe(true);
    });

    it("should parse RB as replaceBattery", () => {
      expect(parseStatus("RB").flags.replaceBattery).toBe(true);
    });

    it("should parse CHRG as charging", () => {
      expect(parseStatus("CHRG").flags.charging).toBe(true);
    });

    it("should parse DISCHRG as discharging", () => {
      expect(parseStatus("DISCHRG").flags.discharging).toBe(true);
    });

    it("should parse BYPASS as bypass", () => {
      expect(parseStatus("BYPASS").flags.bypass).toBe(true);
    });

    it("should parse CAL as calibrating", () => {
      expect(parseStatus("CAL").flags.calibrating).toBe(true);
    });

    it("should parse OFF as off", () => {
      expect(parseStatus("OFF").flags.off).toBe(true);
    });

    it("should parse OVER as overloaded", () => {
      expect(parseStatus("OVER").flags.overloaded).toBe(true);
    });

    it("should parse TRIM as trimming", () => {
      expect(parseStatus("TRIM").flags.trimming).toBe(true);
    });

    it("should parse BOOST as boosting", () => {
      expect(parseStatus("BOOST").flags.boosting).toBe(true);
    });

    it("should parse FSD as forcedShutdown", () => {
      expect(parseStatus("FSD").flags.forcedShutdown).toBe(true);
    });

    it("should parse ALARM as alarm", () => {
      expect(parseStatus("ALARM").flags.alarm).toBe(true);
    });

    it("should parse WAIT as waiting", () => {
      expect(parseStatus("WAIT").flags.waiting).toBe(true);
    });

    it("should parse ECO as ecoMode", () => {
      expect(parseStatus("ECO").flags.ecoMode).toBe(true);
    });

    it("should parse legacy HE as ecoMode (alias)", () => {
      expect(parseStatus("HE").flags.ecoMode).toBe(true);
    });

    it("should parse TEST as testing (real token: powercom, apc_modbus, …)", () => {
      expect(parseStatus("TEST").flags.testing).toBe(true);
    });

    it("should parse OVERHEAT as overheat (real token: belkinunv, microsol)", () => {
      expect(parseStatus("OVERHEAT").flags.overheat).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Flag combinations
  // -----------------------------------------------------------------------
  describe("flag combinations", () => {
    it("should parse OL CHRG", () => {
      const r = parseStatus("OL CHRG");
      expect(r.flags.online).toBe(true);
      expect(r.flags.charging).toBe(true);
      expect(r.flags.onBattery).toBe(false);
    });

    it("should parse OB LB", () => {
      const r = parseStatus("OB LB");
      expect(r.flags.onBattery).toBe(true);
      expect(r.flags.lowBattery).toBe(true);
    });

    it("should parse OB LB FSD", () => {
      const r = parseStatus("OB LB FSD");
      expect(r.flags.onBattery).toBe(true);
      expect(r.flags.lowBattery).toBe(true);
      expect(r.flags.forcedShutdown).toBe(true);
    });

    it("should parse OL ECO", () => {
      const r = parseStatus("OL ECO");
      expect(r.flags.online).toBe(true);
      expect(r.flags.ecoMode).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // charging/discharging from battery.charger.status (modern NUT)
  // -----------------------------------------------------------------------
  describe("battery.charger.status (charging/discharging fallback)", () => {
    it("derives discharging from charger.status when no DISCHRG flag (OB)", () => {
      const r = parseStatus("OB", "discharging");
      expect(r.flags.discharging).toBe(true);
      expect(r.flags.onBattery).toBe(true);
    });

    it("derives charging from charger.status when no CHRG flag (OL)", () => {
      const r = parseStatus("OL", "charging");
      expect(r.flags.charging).toBe(true);
    });

    it("floating charger.status → neither charging nor discharging", () => {
      const r = parseStatus("OL", "floating");
      expect(r.flags.charging).toBe(false);
      expect(r.flags.discharging).toBe(false);
    });

    it("resting charger.status → neither", () => {
      const r = parseStatus("OL", "resting");
      expect(r.flags.charging).toBe(false);
      expect(r.flags.discharging).toBe(false);
    });

    it("CHRG flag still works without charger.status", () => {
      expect(parseStatus("OL CHRG").flags.charging).toBe(true);
    });

    it("ignores empty/unknown charger.status", () => {
      const r = parseStatus("OL", "");
      expect(r.flags.charging).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Severity (power-source ladder only — fault flags intentionally excluded)
  // -----------------------------------------------------------------------
  describe("severity", () => {
    it("should be 0 for OL (OK)", () => {
      expect(parseStatus("OL").severity).toBe(0);
    });

    it("should be 0 for OL CHRG (OK)", () => {
      expect(parseStatus("OL CHRG").severity).toBe(0);
    });

    it("should be 0 for ECO (OK — informational)", () => {
      expect(parseStatus("OL ECO").severity).toBe(0);
    });

    it("should be 0 for WAIT (OK — informational)", () => {
      expect(parseStatus("OL WAIT").severity).toBe(0);
    });

    it("should be 1 for TRIM (Info)", () => {
      expect(parseStatus("OL TRIM").severity).toBe(1);
    });

    it("should be 1 for BOOST (Info)", () => {
      expect(parseStatus("OL BOOST").severity).toBe(1);
    });

    it("should be 1 for CAL (Info)", () => {
      expect(parseStatus("OL CAL").severity).toBe(1);
    });

    it("should be 2 for OB without LB (Warning)", () => {
      expect(parseStatus("OB").severity).toBe(2);
    });

    it("should be 2 for RB (Warning)", () => {
      expect(parseStatus("OL RB").severity).toBe(2);
    });

    it("should be 2 for BYPASS (Warning)", () => {
      expect(parseStatus("BYPASS").severity).toBe(2);
    });

    it("should be 3 for OB LB (Critical)", () => {
      expect(parseStatus("OB LB").severity).toBe(3);
    });

    it("should be 4 for FSD (Emergency)", () => {
      expect(parseStatus("FSD").severity).toBe(4);
    });

    it("should be 4 for OB LB FSD (Emergency — highest wins)", () => {
      expect(parseStatus("OB LB FSD").severity).toBe(4);
    });

    it("OVER does NOT raise severity (fault flag, by design)", () => {
      expect(parseStatus("OL OVER").severity).toBe(0);
      expect(parseStatus("OL OVER").flags.overloaded).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("E1: an empty status says nothing about the power source — severity is empty, not OK", () => {
      const r = parseStatus("");
      expect(r.severity).toBeNull();
      expect(Object.values(r.flags).every(v => v === false)).toBe(true);
    });

    it("should handle whitespace-only string", () => {
      expect(parseStatus("   ").severity).toBeNull();
    });

    it("should ignore unknown flags", () => {
      const r = parseStatus("OL UNKNOWN_FLAG CHRG");
      expect(r.flags.online).toBe(true);
      expect(r.flags.charging).toBe(true);
    });

    it("should handle leading/trailing whitespace", () => {
      expect(parseStatus("  OL  ").flags.online).toBe(true);
    });

    it("should handle TICK/TOCK (unknown but not crashing)", () => {
      expect(parseStatus("OL TICK").flags.online).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Catalog constants
  // -----------------------------------------------------------------------
  describe("constants", () => {
    it("should have 19 flags (14 standard + ALARM + WAIT + ECO + TEST + OVERHEAT)", () => {
      expect(ALL_FLAG_KEYS.length).toBe(19);
    });

    it("STATUS_FLAGS maps the documented tokens + real extras + HE alias", () => {
      for (const t of [
        "OL",
        "OB",
        "LB",
        "HB",
        "RB",
        "CHRG",
        "DISCHRG",
        "BYPASS",
        "CAL",
        "OFF",
        "OVER",
        "TRIM",
        "BOOST",
        "FSD",
        "ALARM",
        "WAIT",
        "ECO",
        "HE",
        "TEST",
        "OVERHEAT",
      ]) {
        expect(STATUS_FLAGS[t], `${t} should map to a flag`).toBeDefined();
      }
      expect(STATUS_FLAGS.HE).toBe("ecoMode");
      expect(STATUS_FLAGS.ECO).toBe("ecoMode");
      expect(STATUS_FLAGS.TEST).toBe("testing");
      expect(STATUS_FLAGS.OVERHEAT).toBe("overheat");
    });

    it("driver-private one-off tokens are not mapped (clients ignore unknowns)", () => {
      for (const t of ["COMM", "NOCOMM", "ACFAIL", "COMMFAULT", "DEPLETED", "BY", "TIP", "SD"]) {
        expect(STATUS_FLAGS[t]).toBeUndefined();
      }
    });

    it("should have unique flag key names", () => {
      expect(new Set(ALL_FLAG_KEYS).size).toBe(ALL_FLAG_KEYS.length);
    });

    it("every flag role is an indicator role — the flags are booleans", () => {
      // The state-role gate cannot resolve `meta?.role ?? "indicator"` statically (it reports the
      // spot as "please check by hand"). This nails the property instead: a boolean state may
      // only carry an indicator* role, so every catalogue entry has to be one.
      for (const flag of ALL_FLAG_KEYS) {
        expect(FLAG_META[flag].role, `${flag} role`).toMatch(/^indicator(\.|$)/);
      }
    });

    it("FLAG_META has i18nKey + role for every flag", () => {
      for (const flag of ALL_FLAG_KEYS) {
        expect(FLAG_META[flag], `${flag} meta`).toBeDefined();
        expect(typeof FLAG_META[flag].i18nKey).toBe("string");
        expect(typeof FLAG_META[flag].role).toBe("string");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Display string
  // -----------------------------------------------------------------------
  describe("getDisplayEntries", () => {
    // The readable line is user-facing, so this module hands out KEYS and the caller resolves
    // them in the system language — the raw token stays as the fallback for an unmapped one.
    it("maps a known token to its catalogue key", () => {
      expect(getDisplayEntries("OL")).toEqual([{ i18nKey: "flagOnline", token: "OL" }]);
    });

    it("keeps the order of the tokens", () => {
      expect(getDisplayEntries("OL CHRG").map(e => e.i18nKey)).toEqual(["flagOnline", "flagCharging"]);
    });

    it("passes an unknown token through without a key", () => {
      expect(getDisplayEntries("OL UNKNOWN")).toEqual([{ i18nKey: "flagOnline", token: "OL" }, { token: "UNKNOWN" }]);
    });

    it("returns nothing for an empty status", () => {
      expect(getDisplayEntries("")).toEqual([]);
    });

    it("resolves the legacy HE alias to the ECO key", () => {
      expect(getDisplayEntries("HE")).toEqual([{ i18nKey: "flagEcoMode", token: "HE" }]);
    });

    it("knows the WAIT token", () => {
      expect(getDisplayEntries("WAIT")).toEqual([{ i18nKey: "flagWaiting", token: "WAIT" }]);
    });
  });

  // -----------------------------------------------------------------------
  // Default-false initialization
  // -----------------------------------------------------------------------
  describe("default-false initialization", () => {
    it("should set all flags to false when none are active", () => {
      const r = parseStatus("");
      for (const key of ALL_FLAG_KEYS) {
        expect(r.flags[key]).toBe(false);
      }
    });

    it("should have all flags present even for single-flag input", () => {
      const r = parseStatus("OL");
      for (const key of ALL_FLAG_KEYS) {
        expect(key in r.flags).toBe(true);
      }
    });
  });
});

describe("E1 severity without a power source (audit 30)", () => {
  it.each(["OFF", "WAIT", "RB", "BOOST", "CAL", "CHRG", "ALARM"])("%s alone → no severity", status => {
    expect(parseStatus(status).severity).toBeNull();
  });

  it("keeps BYPASS-only (apc-mib) at 2 and FSD-only (upsd prefix) at 4", () => {
    expect(parseStatus("BYPASS").severity).toBe(2);
    expect(parseStatus("FSD").severity).toBe(4);
  });

  it("OFF next to a power source keeps the power-source severity", () => {
    expect(parseStatus("OL OFF").severity).toBe(0);
    expect(parseStatus("OB OFF").severity).toBe(2);
  });
});

describe("N15 battery.charger.status only fills in when the status says nothing about charging", () => {
  it("does not add charging next to a DISCHRG flag", () => {
    const r = parseStatus("OB DISCHRG", "charging");
    expect(r.flags.discharging).toBe(true);
    expect(r.flags.charging).toBe(false);
  });

  it("does not add discharging next to a CHRG flag", () => {
    const r = parseStatus("OL CHRG", "discharging");
    expect(r.flags.charging).toBe(true);
    expect(r.flags.discharging).toBe(false);
  });

  it("still fills in when the flags are absent", () => {
    expect(parseStatus("OL", "charging").flags.charging).toBe(true);
    expect(parseStatus("OB", "discharging").flags.discharging).toBe(true);
  });
});
