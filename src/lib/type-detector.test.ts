import { detectStates, detectType, isNumericStateWord } from "./type-detector";

describe("type-detector", () => {
  // -----------------------------------------------------------------------
  // Known-string detection
  // -----------------------------------------------------------------------
  describe("known-string variables", () => {
    it("should detect *.model as string", () => {
      const r = detectType("device.model", "Ellipse PRO 1600", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("Ellipse PRO 1600");
    });

    it("should detect *.mfr as string", () => {
      const r = detectType("device.mfr", "EATON", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.serial as string", () => {
      const r = detectType("device.serial", "G364T29133", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.firmware as string", () => {
      const r = detectType("ups.firmware", "01.18.0022", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("01.18.0022");
    });

    it("should detect *.status as string even when value looks numeric", () => {
      const r = detectType("ups.beeper.status", "enabled", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.alarm as string", () => {
      const r = detectType("ups.alarm", "High temperature!", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.type as string", () => {
      const r = detectType("battery.type", "PbAc", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.desc as string", () => {
      const r = detectType("outlet.desc", "Main Outlet", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.name as string", () => {
      const r = detectType("driver.name", "usbhid-ups", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.id as string even with numeric value", () => {
      const r = detectType("outlet.id", "1", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("1");
    });

    it("should detect driver.parameter.port as string", () => {
      const r = detectType("driver.parameter.port", "auto", false);
      expect(r.type).toBe("string");
    });

    it("should detect driver.parameter.synchronous as string", () => {
      const r = detectType("driver.parameter.synchronous", "auto", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.version as string", () => {
      const r = detectType("driver.version", "2.8.0", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.version.* as string", () => {
      const r = detectType("driver.version.data", "MGE HID 1.46", false);
      expect(r.type).toBe("string");
    });

    it("should detect driver.version.internal as string", () => {
      const r = detectType("driver.version.internal", "0.47", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("0.47");
    });

    it("should detect *.location as string", () => {
      const r = detectType("ups.location", "Server Room", false);
      expect(r.type).toBe("string");
    });

    it("should detect *.contact as string", () => {
      const r = detectType("ups.contact", "admin@example.com", false);
      expect(r.type).toBe("string");
    });

    it("should detect ups.status as string", () => {
      const r = detectType("ups.status", "OL", false);
      expect(r.type).toBe("string");
      expect(r.role).toBe("text");
    });
  });

  // -----------------------------------------------------------------------
  // driver.flag.* — NUT-core on/off flags: a real boolean, not dead text
  // -----------------------------------------------------------------------
  describe("driver.flag.* boolean", () => {
    it("should detect driver.flag.* as read-only boolean (enabled → true)", () => {
      const r = detectType("driver.flag.ignorelb", "enabled", false);
      expect(r.type).toBe("boolean");
      expect(r.parsedValue).toBe(true);
      expect(r.write).toBe(false);
    });

    it("should map driver.flag.* disabled → false", () => {
      expect(detectType("driver.flag.nolock", "disabled", false).parsedValue).toBe(false);
    });

    it("should map numeric driver.flag.* (ST_FLAG_NUMBER, e.g. allow_killpower) 1→true 0→false", () => {
      expect(detectType("driver.flag.allow_killpower", "1", false).parsedValue).toBe(true);
      expect(detectType("driver.flag.allow_killpower", "0", false).parsedValue).toBe(false);
    });

    it("should keep driver.flag.* read-only even when LIST RW marks it writable", () => {
      const r = detectType("driver.flag.allow_killpower", "1", true);
      expect(r.type).toBe("boolean");
      expect(r.write).toBe(false);
    });

    it("should leave a driver.flag.* with an unexpected value as opaque string", () => {
      const r = detectType("driver.flag.weird", "sometimes", false);
      expect(r.type).toBe("string");
    });

    it("should leave a NUMERIC unrecognised driver.flag.* as opaque string, not a number", () => {
      const r = detectType("driver.flag.weird", "2", false);
      expect(r.type).toBe("string");
      expect(r.role).toBe("text");
    });
  });

  // -----------------------------------------------------------------------
  // parseFloat heuristic
  // -----------------------------------------------------------------------
  describe("parseFloat heuristic", () => {
    it("should detect integer values as number", () => {
      const r = detectType("battery.charge", "100", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(100);
    });

    it("should detect float values as number", () => {
      const r = detectType("input.voltage", "221.0", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(221.0);
    });

    it("a string state always gets the text role — never a value.* one", () => {
      // Same reason as the flag-role test in status-parser: the gate sees `detectRole(...)` and
      // asks for a manual look. The property it cannot see is that the string branch returns
      // "text" for every input — a value.* role on a string would be an E1009 finding.
      for (const [name, value] of [
        ["device.model", "X"],
        ["ups.status", "OL"],
        ["some.unknown.var", "enabled"],
        ["battery.type", "PbAc"],
        ["driver.parameter.port", "auto"],
      ] as const) {
        const r = detectType(name, value, false);
        expect(r.type, `${name} type`).toBe("string");
        expect(r.role, `${name} role`).toBe("text");
      }
      // …including the writable case, which must not turn into a level role either.
      expect(detectType("device.model", "X", true).role).toBe("text");
    });

    it("should detect negative values as number", () => {
      // Not a timer variable — a plain negative reading stays the number it is.
      const r = detectType("ups.temperature", "-1", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(-1);
    });

    it("should detect non-numeric strings as string", () => {
      const r = detectType("some.unknown.var", "enabled", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("enabled");
    });

    it("should handle empty string as string", () => {
      const r = detectType("some.var", "", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("");
    });

    it("should handle whitespace-only as string", () => {
      const r = detectType("some.var", "  ", false);
      expect(r.type).toBe("string");
    });

    it("should handle value with trailing space", () => {
      const r = detectType("ups.load", "15 ", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(15);
    });

    // Strict decimal: garbage suffixes and non-finite tokens are NOT numbers
    // (krobi 2026-06-21 via test-lab: a number field never holds letters; a
    // non-finite value must not silently become null on setState). Since the 2026-09-25 audit
    // (E10) a measurement keeps its number type and gets NO value instead of being discarded —
    // a discarded value left the last reading standing.
    it("should NOT parse garbage-suffix as number (12abc)", () => {
      const r = detectType("battery.charge", "12abc", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBeNull();
      expect(r.unit).toBe("%");
      expect(r.expectedNumeric).toBe(true); // charge is a numeric quantity (%)
      expect(r.stateWord).toBe(false); // garbage, not a "no reading" word
    });

    it("should NOT parse Infinity as number", () => {
      const r = detectType("input.voltage", "Infinity", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBeNull();
      expect(r.expectedNumeric).toBe(true); // voltage is a numeric quantity (V)
    });

    it("flags garbage in a numeric field but not in a genuine text field", () => {
      // numeric quantity (has a unit) + a word → an empty number; n/a is a "no reading" word
      const na = detectType("ups.load", "n/a", false);
      expect(na.expectedNumeric).toBe(true);
      expect(na.stateWord).toBe(true);
      expect(na.role).toBe("value");
      // no unit → a genuine text value, keep it as string
      expect(detectType("some.unknown.var", "enabled", false).expectedNumeric).toBeUndefined();
    });

    it("types yes/no readings as real booleans, even with a unit substring in the name", () => {
      // input.frequency.extended = "no": the "frequency" substring must NOT make it a numeric
      // field — it is a yes/no flag, so it becomes a real boolean state (not text, not discarded).
      const ext = detectType("input.frequency.extended", "no", false);
      expect(ext.type).toBe("boolean");
      expect(ext.parsedValue).toBe(false);
      expect(ext.role).toBe("indicator");
      expect(ext.expectedNumeric).toBeFalsy();

      // input.voltage.extended = "yes" (the twin) and ambient.n.present = "yes" → boolean true.
      expect(detectType("input.voltage.extended", "yes", false).type).toBe("boolean");
      expect(detectType("input.voltage.extended", "yes", false).parsedValue).toBe(true);
      expect(detectType("ambient.1.present", "yes", false).parsedValue).toBe(true);
    });

    it("B2: keeps battery.charge.approx as text — the only driver reports <85 / >85", () => {
      // nut-names.txt: "Rough approximation of battery charge (opaque, percent)"; the only driver
      // setting it (nutdrv_siemens_sitop.c:237) writes ">85" or "<85". As a number it was discarded
      // on every poll, and the datapoint never got a value.
      for (const v of ["<85", ">85", "85"]) {
        const r = detectType("battery.charge.approx", v, false);
        expect(r.type).toBe("string");
        expect(r.parsedValue).toBe(v);
        expect(r.role).toBe("text");
      }
    });

    it("should NOT parse -Infinity as number", () => {
      const r = detectType("output.voltage", "-Infinity", false);
      expect(r.parsedValue).toBeNull();
      expect(r.expectedNumeric).toBe(true);
    });

    it("should NOT parse locale comma as number (230,4)", () => {
      const r = detectType("battery.voltage", "230,4", false);
      expect(r.parsedValue).toBeNull();
      expect(r.expectedNumeric).toBe(true);
    });

    it("should NOT parse scientific notation as number (1e3)", () => {
      const r = detectType("ups.realpower", "1e3", false);
      expect(r.parsedValue).toBeNull();
      expect(r.expectedNumeric).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Unit detection
  // -----------------------------------------------------------------------
  describe("unit detection", () => {
    it("should assign V for voltage", () => {
      expect(detectType("input.voltage", "221.0", false).unit).toBe("V");
    });

    it("should not assign V for input.voltage.extended (boolean string, not a voltage)", () => {
      expect(detectType("input.voltage.extended", "no", false).unit).toBeUndefined();
    });

    it("should not assign V for input.voltage.extended=yes (it is a boolean)", () => {
      const r = detectType("input.voltage.extended", "yes", false);
      expect(r.unit).toBeUndefined();
      expect(r.type).toBe("boolean");
    });

    it("should assign Hz for frequency", () => {
      expect(detectType("input.frequency", "50.0", false).unit).toBe("Hz");
    });

    it("should assign A for current", () => {
      expect(detectType("output.current", "2.5", false).unit).toBe("A");
    });

    it("should assign % for charge", () => {
      expect(detectType("battery.charge", "100", false).unit).toBe("%");
    });

    it("should assign % for charge.low", () => {
      expect(detectType("battery.charge.low", "15", false).unit).toBe("%");
    });

    it("should assign % for load", () => {
      expect(detectType("ups.load", "15", false).unit).toBe("%");
    });

    it("should assign °C for temperature", () => {
      expect(detectType("ups.temperature", "32.5", false).unit).toBe("°C");
    });

    it("should assign s for runtime", () => {
      expect(detectType("battery.runtime", "2050", false).unit).toBe("s");
    });

    it("should assign s for delay", () => {
      expect(detectType("ups.delay.shutdown", "20", false).unit).toBe("s");
    });

    it("should assign s for timer", () => {
      expect(detectType("ups.timer.shutdown", "-1", false).unit).toBe("s");
    });

    it("should assign VA for power", () => {
      expect(detectType("ups.power", "159", false).unit).toBe("VA");
    });

    it("should assign VA for power.nominal", () => {
      expect(detectType("ups.power.nominal", "1600", false).unit).toBe("VA");
    });

    it("should assign W for realpower", () => {
      expect(detectType("ups.realpower", "147", false).unit).toBe("W");
    });

    it("should assign Ah for capacity", () => {
      expect(detectType("battery.capacity", "9", false).unit).toBe("Ah");
    });

    it("should assign % for efficiency", () => {
      expect(detectType("ups.efficiency", "95", false).unit).toBe("%");
    });

    it("should assign % for ambient.humidity", () => {
      expect(detectType("ambient.humidity", "45", false).unit).toBe("%");
    });

    it("should assign % for ambient.1.humidity", () => {
      expect(detectType("ambient.1.humidity", "55", false).unit).toBe("%");
    });

    it("should assign % for *.percent suffix", () => {
      expect(detectType("battery.charge.percent", "100", false).unit).toBe("%");
    });

    it("should have no unit for string variables", () => {
      expect(detectType("device.mfr", "EATON", false).unit).toBeUndefined();
    });

    it("should have no unit for unknown numeric variables", () => {
      // A real numeric NUT variable with no unit rule in the catalog (a count): the value must
      // become a number WITHOUT a unit. (ups.productid is a known STRING variable — it never
      // reaches unit detection, so it could not prove this.)
      const packs = detectType("battery.packs", "2", false);
      expect(packs.type).toBe("number");
      expect(packs.unit).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Role detection
  // -----------------------------------------------------------------------
  describe("role detection", () => {
    it("should assign value.battery for battery.charge", () => {
      expect(detectType("battery.charge", "100", false).role).toBe("value.battery");
    });

    it("should assign value.voltage for voltage vars", () => {
      expect(detectType("input.voltage", "221.0", false).role).toBe("value.voltage");
    });

    it("should assign value.temperature for temperature vars", () => {
      expect(detectType("ups.temperature", "32.5", false).role).toBe("value.temperature");
    });

    it("should assign text for ups.status", () => {
      expect(detectType("ups.status", "OL", false).role).toBe("text");
    });

    it("should assign value for read-only numbers", () => {
      expect(detectType("ups.load", "15", false).role).toBe("value");
    });

    it("should assign text for read-only strings", () => {
      expect(detectType("device.mfr", "EATON", false).role).toBe("text");
    });

    it("should assign value.current for current vars", () => {
      expect(detectType("output.current", "2.5", false).role).toBe("value.current");
    });

    it("B1: apparent power (VA) is the generic value — value.power requires W/kW", () => {
      // Role catalog: `value.power - energy power (unit=W or kW)`; value.power.apparent does not
      // exist. D08 was red on seven VA datapoints with value.power.
      for (const name of ["ups.power", "ups.power.nominal", "input.power", "output.L1.power", "outlet.1.power"]) {
        const r = detectType(name, "159", false);
        expect(r.role, name).toBe("value");
        expect(r.unit, name).toBe("VA");
      }
    });

    it("should assign value.power.active for realpower vars (real/active power)", () => {
      expect(detectType("ups.realpower", "147", false).role).toBe("value.power.active");
    });

    it("should assign value.voltage to input.transfer.high (voltage set-point without 'voltage' token)", () => {
      expect(detectType("input.transfer.high", "260", false).role).toBe("value.voltage");
    });

    it("should assign value.voltage to input.transfer.low", () => {
      expect(detectType("input.transfer.low", "180", false).role).toBe("value.voltage");
    });

    it("should assign value.interval for battery.runtime", () => {
      expect(detectType("battery.runtime", "2050", false).role).toBe("value.interval");
    });

    it("should assign value.frequency for frequency", () => {
      expect(detectType("input.frequency", "50.0", false).role).toBe("value.frequency");
    });

    it("should assign value.humidity for ambient humidity", () => {
      expect(detectType("ambient.humidity", "45", false).role).toBe("value.humidity");
    });

    it("should keep a frequency range (percentage band) as generic value, not value.frequency", () => {
      expect(detectType("input.transfer.frequency.bypass.range", "10", false).role).toBe("value");
    });

    it("should assign value.interval for ups.timer.*", () => {
      expect(detectType("ups.timer.shutdown", "-1", false).role).toBe("value.interval");
    });

    it("B5: a writable delay is a timer set-point (level.timer)", () => {
      expect(detectType("ups.delay.shutdown", "20", true).role).toBe("level.timer");
    });

    it("should assign text for writable strings", () => {
      expect(detectType("outlet.desc", "Main Outlet", true).role).toBe("text");
    });

    it("B4: a writable voltage is level.voltage", () => {
      expect(detectType("input.transfer.high", "285", true).role).toBe("level.voltage");
    });
  });

  // -----------------------------------------------------------------------
  // Write flag
  // -----------------------------------------------------------------------
  describe("write flag", () => {
    it("should be false for read-only variables", () => {
      expect(detectType("battery.charge", "100", false).write).toBe(false);
    });

    it("should be true for writable variables", () => {
      expect(detectType("ups.delay.shutdown", "20", true).write).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // read flag
  // -----------------------------------------------------------------------
  describe("read flag", () => {
    it("should always be true", () => {
      expect(detectType("battery.charge", "100", false).read).toBe(true);
      expect(detectType("ups.delay.shutdown", "20", true).read).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases from krobi's Eaton PRO 1600
  // -----------------------------------------------------------------------
  describe("krobi Eaton PRO 1600 edge cases", () => {
    it("should handle ups.productid as string (ffff)", () => {
      const r = detectType("ups.productid", "ffff", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("ffff");
    });

    it("should handle ups.productid preserving leading zeros (0001)", () => {
      const r = detectType("ups.productid", "0001", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("0001");
    });

    it("should handle ups.vendorid as string preserving leading zeros (0463)", () => {
      const r = detectType("ups.vendorid", "0463", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("0463");
    });

    it("should handle driver.version.usb as string", () => {
      const r = detectType("driver.version.usb", "libusb-1.0.26 (API: 0x1000109)", false);
      expect(r.type).toBe("string");
    });

    it("trims the padding NUT puts around a text value", () => {
      // Measured on an Eaton Ellipse PRO 1600: device.model comes back with a trailing space,
      // which would otherwise sit in every UI and break every comparison.
      const r = detectType("device.model", "Ellipse PRO 1600 ", false);
      expect(r.type).toBe("string");
      expect(r.parsedValue).toBe("Ellipse PRO 1600");
    });

    it("an idle countdown is empty, not minus one second (HID drivers)", () => {
      // Measured on an Eaton Ellipse PRO 1600: ups.timer.shutdown reads -1 while nothing runs.
      const r = detectType("ups.timer.shutdown", "-1", false);
      expect(r.type).toBe("number");
      expect(r.unit).toBe("s");
      expect(r.parsedValue).toBeNull();
    });

    it("an idle countdown in the apc_modbus wording is empty too — and not discarded", () => {
      // apc_modbus converts the same -1 into the word "NotActive" (drivers/apc_modbus.c). As a
      // plain string in a seconds field it used to be dropped with a warning on every poll.
      const r = detectType("ups.timer.start", "NotActive", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBeNull();
      expect(r.expectedNumeric).toBeUndefined();
    });

    it("an expired countdown is zero", () => {
      const r = detectType("outlet.1.timer.shutdown", "CountdownExpired", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(0);
    });

    it("a running countdown stays the number it is", () => {
      const r = detectType("ups.timer.reboot", "45", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(45);
      expect(r.unit).toBe("s");
    });

    it("should handle driver.parameter.pollfreq as number", () => {
      const r = detectType("driver.parameter.pollfreq", "30", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(30);
    });

    it("should handle driver.parameter.pollinterval as number", () => {
      const r = detectType("driver.parameter.pollinterval", "2", false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBe(2);
    });

    it("should handle input.voltage.extended as a boolean (yes/no)", () => {
      const r = detectType("input.voltage.extended", "no", false);
      expect(r.type).toBe("boolean");
    });

    it("should handle outlet.1.switchable as a boolean (yes/no)", () => {
      const r = detectType("outlet.1.switchable", "no", false);
      expect(r.type).toBe("boolean");
    });

    it("should handle outlet.1.status as string", () => {
      const r = detectType("outlet.1.status", "on", false);
      expect(r.type).toBe("string");
    });
  });

  // -----------------------------------------------------------------------
  // detectStates (enum values)
  // -----------------------------------------------------------------------
  it("a writable numeric variable gets the writable role, not a measurement role", () => {
    // level is what ioBroker uses for "a number the user may set"; value.* is a reading.
    expect(detectType("ups.realpower.nominal", "1500", true).role).toBe("level");
    expect(detectType("ups.realpower.nominal", "1500", false).role).toBe("value.power.active");
  });

  it("a writable countdown keeps one role whether it runs or idles", () => {
    // The role is written once per runtime; if idle and running disagreed, the value the first
    // poll happened to see would decide what the datapoint looks like.
    const running = detectType("ups.timer.shutdown", "30", true);
    const idle = detectType("ups.timer.shutdown", "-1", true);
    const expired = detectType("ups.timer.shutdown", "NotActive", true);
    expect(idle.role).toBe(running.role);
    expect(expired.role).toBe(running.role);
    expect(idle.unit).toBe(running.unit);
  });

  describe("detectStates", () => {
    it("should return enum states for battery.charger.status", () => {
      const s = detectStates("battery.charger.status");
      expect(s).toEqual({
        charging: "charging",
        discharging: "discharging",
        floating: "floating",
        resting: "resting",
      });
    });

    it("should return enum states for ups.beeper.status", () => {
      const s = detectStates("ups.beeper.status");
      expect(s).toEqual({ enabled: "enabled", disabled: "disabled", muted: "muted" });
    });

    it("should return on/off for outlet.status", () => {
      expect(detectStates("outlet.status")).toEqual({ on: "on", off: "off" });
    });

    it("should return on/off for outlet.1.status", () => {
      expect(detectStates("outlet.1.status")).toEqual({ on: "on", off: "off" });
    });

    it("should return on/off for outlet.2.switch", () => {
      expect(detectStates("outlet.2.switch")).toEqual({ on: "on", off: "off" });
    });

    it("should return enum states for device.type", () => {
      expect(detectStates("device.type")).toEqual({
        ups: "ups",
        pdu: "pdu",
        scd: "scd",
        psu: "psu",
        ats: "ats",
      });
    });

    it("should return threshold states for top-level voltage.status", () => {
      expect(detectStates("voltage.status")).toEqual({
        good: "good",
        "warning-low": "warning-low",
        "warning-high": "warning-high",
        "critical-low": "critical-low",
        "critical-high": "critical-high",
      });
    });

    it("should return threshold states for top-level current.status", () => {
      expect(detectStates("current.status")).toEqual({
        good: "good",
        "warning-low": "warning-low",
        "warning-high": "warning-high",
        "critical-low": "critical-low",
        "critical-high": "critical-high",
      });
    });

    it("should return undefined for unknown variables", () => {
      expect(detectStates("battery.charge")).toBeUndefined();
    });

    it("should return undefined for ups.status (not an enum)", () => {
      expect(detectStates("ups.status")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // J/K/L/M — type/role/unit edge fixes (v0.3.0)
  // -----------------------------------------------------------------------
  describe("string states: no unit (J) + no value.* role (K)", () => {
    it("battery.charger.status → string, no unit (not %), text role", () => {
      const r = detectType("battery.charger.status", "floating", false);
      expect(r.type).toBe("string");
      expect(r.unit).toBeUndefined();
      expect(r.role).toBe("text");
    });

    it("input.voltage.status → string, no unit (not V), text role (not value.voltage)", () => {
      const r = detectType("input.voltage.status", "good", false);
      expect(r.type).toBe("string");
      expect(r.unit).toBeUndefined();
      expect(r.role).toBe("text");
    });

    it("ups.beeper.status string has no unit", () => {
      expect(detectType("ups.beeper.status", "enabled", false).unit).toBeUndefined();
    });
  });

  describe("powerfactor is not value.power (L)", () => {
    it("output.powerfactor → value role, no VA unit", () => {
      const r = detectType("output.powerfactor", "0.98", false);
      expect(r.type).toBe("number");
      expect(r.role).toBe("value");
      expect(r.unit).toBeUndefined();
    });

    it("ups.realpower → value.power.active / W (real/active power)", () => {
      const r = detectType("ups.realpower", "147", false);
      expect(r.role).toBe("value.power.active");
      expect(r.unit).toBe("W");
    });
  });

  // -----------------------------------------------------------------------
  // Representative nut-2.8.5 variables map to their correct datapoint (type / unit /
  // common.states). Bare text is only correct for genuinely opaque fields. The WHOLE registry is
  // walked by catalog-completeness.test.ts (labels, explanations, units).
  // -----------------------------------------------------------------------
  describe("representative nut-2.8.5 variables: type, unit and value list", () => {
    const THR = ["good", "warning-low", "warning-high", "critical-low", "critical-high"];
    const FREQ = [...THR, "out-of-range"];
    const ONOFF = ["on", "off"];
    const ENDIS = ["enabled", "disabled"];
    const CONTACTS = ["open", "closed", "active", "inactive"];
    const CHARGER = ["charging", "discharging", "floating", "resting"];
    const BEEPER = ["enabled", "disabled", "muted"];
    const DEVTYPE = ["ups", "pdu", "scd", "psu", "ats"];

    interface Row {
      name: string;
      value: string;
      rw?: boolean;
      type: "number" | "string" | "boolean";
      unit?: string;
      states?: string[];
    }
    const CATALOG: Row[] = [
      // Numbers + units
      { name: "battery.charge", value: "100", type: "number", unit: "%" },
      { name: "battery.voltage", value: "24.8", type: "number", unit: "V" },
      { name: "battery.runtime", value: "1080", type: "number", unit: "s" },
      { name: "battery.capacity", value: "7.2", type: "number", unit: "Ah" },
      { name: "battery.temperature", value: "50", type: "number", unit: "°C" },
      { name: "battery.energysave.delay", value: "3", type: "number", unit: "min" },
      { name: "input.voltage", value: "121", type: "number", unit: "V" },
      { name: "input.frequency", value: "50", type: "number", unit: "Hz" },
      { name: "input.current", value: "4.25", type: "number", unit: "A" },
      { name: "input.transfer.low", value: "91", rw: true, type: "number", unit: "V" },
      { name: "input.transfer.high", value: "132", rw: true, type: "number", unit: "V" },
      { name: "input.transfer.boost.low", value: "190", type: "number", unit: "V" },
      { name: "input.transfer.low.min", value: "85", type: "number", unit: "V" },
      { name: "input.transfer.hysteresis", value: "10", type: "number", unit: "V" },
      { name: "input.transfer.frequency.bypass.range", value: "10", type: "number", unit: "%" },
      { name: "input.transfer.delay", value: "60", type: "number", unit: "s" },
      { name: "input.phase.shift", value: "181", type: "number", unit: "°" },
      { name: "output.inverter.latency", value: "0.01", type: "number", unit: "s" },
      { name: "ups.power", value: "500", type: "number", unit: "VA" },
      { name: "ups.realpower", value: "300", type: "number", unit: "W" },
      { name: "ups.load", value: "23", type: "number", unit: "%" },
      { name: "ups.load.high", value: "100", type: "number", unit: "%" },
      { name: "ups.temperature", value: "42", type: "number", unit: "°C" },
      { name: "ups.delay.shutdown", value: "20", rw: true, type: "number", unit: "s" },
      { name: "ups.test.interval", value: "1209600", type: "number", unit: "s" },
      { name: "ups.efficiency", value: "95", type: "number", unit: "%" },
      { name: "device.uptime", value: "1782", type: "number", unit: "s" },
      { name: "ambient.1.temperature", value: "25", type: "number", unit: "°C" },
      { name: "ambient.1.humidity", value: "38", type: "number", unit: "%" },
      { name: "outlet.1.current", value: "0.19", type: "number", unit: "A" },
      { name: "outlet.1.voltage", value: "247", type: "number", unit: "V" },
      { name: "outlet.1.realpower", value: "28", type: "number", unit: "W" },
      { name: "output.powerfactor", value: "0.85", type: "number" },
      // Booleans (yes/no)
      { name: "input.voltage.extended", value: "no", type: "boolean" },
      { name: "input.frequency.extended", value: "no", type: "boolean" },
      { name: "outlet.switchable", value: "yes", type: "boolean" },
      { name: "outlet.1.switchable", value: "yes", type: "boolean" },
      { name: "ambient.1.present", value: "yes", type: "boolean" },
      { name: "battery.protection", value: "yes", type: "boolean" },
      { name: "ups.start.auto", value: "yes", type: "boolean" },
      // driver.flag.* — NUT-core on/off flags, read as boolean (enabled/disabled or 0/1)
      { name: "driver.flag.ignorelb", value: "enabled", type: "boolean" },
      { name: "driver.flag.allow_killpower", value: "1", type: "boolean" },
      // Enums (string + common.states)
      { name: "input.voltage.status", value: "critical-low", type: "string", states: THR },
      { name: "input.current.status", value: "critical-high", type: "string", states: THR },
      { name: "input.frequency.status", value: "out-of-range", type: "string", states: FREQ },
      { name: "outlet.1.voltage.status", value: "good", type: "string", states: THR },
      { name: "ambient.1.temperature.status", value: "warning-low", type: "string", states: THR },
      { name: "ambient.1.humidity.status", value: "warning-low", type: "string", states: THR },
      { name: "outlet.1.status", value: "on", type: "string", states: ONOFF },
      { name: "outlet.1.switch", value: "on", rw: true, type: "string", states: ONOFF },
      { name: "outlet.group.1.status", value: "on", type: "string", states: ONOFF },
      { name: "battery.charger.status", value: "charging", type: "string", states: CHARGER },
      { name: "ups.beeper.status", value: "enabled", type: "string", states: BEEPER },
      { name: "ups.watchdog.status", value: "disabled", type: "string", states: ENDIS },
      { name: "ups.shutdown", value: "enabled", type: "string", states: ENDIS },
      { name: "ambient.1.temperature.alarm", value: "enabled", type: "string", states: ENDIS },
      { name: "input.transfer.bypass.forced", value: "enabled", type: "string", states: ENDIS },
      { name: "ambient.1.contacts.1.status", value: "open", type: "string", states: CONTACTS },
      { name: "device.type", value: "ups", type: "string", states: DEVTYPE },
      // Top-level status forms the NUT catalogue lists next to the input.*/output.* variants
      { name: "voltage.status", value: "good", type: "string", states: THR },
      { name: "current.status", value: "critical-low", type: "string", states: THR },
      // Opaque strings (correct as text, no states)
      { name: "device.model", value: "SMART-UPS 700", type: "string" },
      { name: "device.serial", value: "WS9643050926", type: "string" },
      { name: "device.part", value: "0123456789", type: "string" },
      { name: "ambient.1.address", value: "1", type: "string" },
      { name: "input.feed.color", value: "3831236", type: "string" },
      { name: "outlet.1.groupid", value: "1", type: "string" },
      { name: "ups.status", value: "OL", type: "string" },
      { name: "ups.alarm", value: "OVERHEAT", type: "string" },
      { name: "input.sensitivity", value: "H", type: "string" },
      { name: "input.transfer.reason", value: "T", type: "string" },
      { name: "ups.vendorid", value: "0463", type: "string" },
      { name: "battery.type", value: "PbAc", type: "string" },
    ];

    it.each(CATALOG)("$name ($value) → $type", ({ name, value, rw, type, unit, states }) => {
      const d = detectType(name, value, rw ?? false);
      expect(d.type).toBe(type);
      expect(d.unit).toBe(unit);
      const detected = detectStates(name);
      if (states) {
        expect(detected).toBeDefined();
        expect(Object.keys(detected as Record<string, string>)).toEqual(states);
      } else {
        expect(detected).toBeUndefined();
      }
    });
  });

  describe("voltage/frequency status enums (M)", () => {
    it("input.voltage.status → good/warning/critical enum", () => {
      expect(detectStates("input.voltage.status")).toEqual({
        good: "good",
        "warning-low": "warning-low",
        "warning-high": "warning-high",
        "critical-low": "critical-low",
        "critical-high": "critical-high",
      });
    });

    it("three-phase input.L1.voltage.status → same enum", () => {
      expect(detectStates("input.L1.voltage.status")?.good).toBe("good");
    });

    it("output.frequency.status → same enum", () => {
      expect(detectStates("output.frequency.status")?.["critical-low"]).toBe("critical-low");
    });
  });
});

// ---------------------------------------------------------------------------
// Audit 2026-09-25 — type detection (plan package B)
// ---------------------------------------------------------------------------

describe("B1 power and percent — role and unit agree with the role catalog", () => {
  it.each([
    ["power.percent", "%", "value"],
    ["power.maximum.percent", "%", "value"],
    ["output.L1.power.percent", "%", "value"],
    ["output.power.percent", "%", "value"],
    ["power.maximum", "VA", "value"],
    ["power.minimum", "VA", "value"],
    ["output.L2.power.maximum", "VA", "value"],
    ["input.power", "VA", "value"],
    ["ups.realpower", "W", "value.power.active"],
    ["output.realpower", "W", "value.power.active"],
    ["input.realpower.nominal", "W", "value.power.active"],
    ["battery.energysave.realpower", "W", "value.power.active"],
  ])("%s → %s, %s", (name, unit, role) => {
    const r = detectType(name, "42", false);
    expect(r.unit).toBe(unit);
    expect(r.role).toBe(role);
  });
});

describe("B2 opaque catalog values stay text whatever digits they carry", () => {
  it.each([
    ["ups.contacts", "00"],
    ["ups.contacts", "0F"],
    ["input.quality", "FF"],
    ["input.quality", "00"],
    ["ups.test.result", "NO"],
    ["ups.test.result", "OK"],
    ["ups.firmware.aux", "02.08"],
    ["ups.time", "12:34:56"],
    ["ups.display.language", "1"],
    ["device.macaddr", "00:c0:b7:12:34:56"],
    ["device.description", "12"],
    ["battery.date.maintenance", "2027"],
    ["outlet.1.designator", "1"],
    ["input.sensitivity", "2"],
    ["ambient.1.contacts.1.config", "0"],
    ["input.transfer.reason", "1"],
    ["ups.mode", "2"],
    ["experimental.ups.mode.buzzwords", "1"],
    ["driver.parameter.bus", "001"],
    ["driver.parameter.runtimecal", "8640,100,17280,50"],
    ["driver.parameter.productID", "0000"],
  ])("%s = %j", (name, value) => {
    const r = detectType(name, value, false);
    expect(r.type).toBe("string");
    expect(r.parsedValue).toBe(value);
  });

  it("keeps the two poll timings of the driver core numeric", () => {
    expect(detectType("driver.parameter.pollinterval", "2", false).type).toBe("number");
    expect(detectType("driver.parameter.pollfreq", "30", false).type).toBe("number");
  });

  it("does not turn numeric experimental.*.mode variables into text", () => {
    // bicker_ser.c:504 and meanwell_ntu.c:61-68 publish them as numbers.
    expect(detectType("experimental.ups.relay.mode", "3", false).type).toBe("number");
    expect(detectType("experimental.inverter.mode", "1", false).type).toBe("number");
  });
});

describe("B3 a word in a measurement is an empty number, not a lost or stale reading", () => {
  it.each(["LoadTooLow", "OnBattery", "NotAvailable", "BatteryCharging", "PoorACInput", "NA", "N/A", "none"])(
    "ups.efficiency = %j → number without value, a state word",
    word => {
      const r = detectType("ups.efficiency", word, false);
      expect(r.type).toBe("number");
      expect(r.unit).toBe("%");
      expect(r.parsedValue).toBeNull();
      expect(r.stateWord).toBe(true);
      expect(isNumericStateWord(word)).toBe(true);
    },
  );

  it("an empty value with a unit is an empty number — no reading, not garbage", () => {
    for (const raw of ["", "  "]) {
      const r = detectType("input.voltage", raw, false);
      expect(r.type).toBe("number");
      expect(r.parsedValue).toBeNull();
      expect(r.stateWord).toBe(true);
      expect(isNumericStateWord(raw)).toBe(true);
    }
  });

  it("a driver-private variable outside the catalog keeps its text", () => {
    // apcmicrolink: experimental.output.voltage.setting = "VAC230".
    const r = detectType("experimental.output.voltage.setting", "VAC230", false);
    expect(r.type).toBe("string");
    expect(r.parsedValue).toBe("VAC230");
    expect(r.expectedNumeric).toBeUndefined();
  });
});

describe("B4 writable set-points get the level role of their quantity", () => {
  it.each([
    ["ambient.1.temperature.high.warning", "level.temperature"],
    ["ambient.temperature.high", "level.temperature"],
    ["output.current.high", "level.current"],
    ["input.transfer.low", "level.voltage"],
    ["output.voltage.nominal", "level.voltage"],
    ["input.frequency.nominal", "level.frequency"],
    ["ambient.1.humidity.high", "level.humidity"],
    ["ups.power.nominal", "level"],
    ["battery.charge.low", "level"],
    ["power.percent", "level"],
  ])("%s → %s", (name, role) => {
    expect(detectType(name, "40", true).role).toBe(role);
  });

  it("never gives a writable number a value.* role", () => {
    for (const name of ["ambient.1.temperature.low", "outlet.1.current.high.warning", "ups.test.interval"]) {
      expect(detectType(name, "1", true).role.startsWith("value"), name).toBe(false);
    }
  });
});

describe("B5 durations are intervals", () => {
  it.each(["input.transfer.delay", "device.uptime", "ups.test.interval", "output.inverter.latency", "ups.delay.start"])(
    "%s → value.interval (read-only), level.timer (writable)",
    name => {
      expect(detectType(name, "10", false).role).toBe("value.interval");
      expect(detectType(name, "10", false).unit).toBe("s");
      expect(detectType(name, "10", true).role).toBe("level.timer");
    },
  );

  it("battery.energysave.delay is minutes, so the generic value", () => {
    const r = detectType("battery.energysave.delay", "5", false);
    expect(r.unit).toBe("min");
    expect(r.role).toBe("value");
  });
});

describe("B6 a countdown printed as -1.0 is idle too", () => {
  it.each(["-1", "-1.0", "-1.00"])("ups.timer.shutdown = %s → no value", raw => {
    const r = detectType("ups.timer.shutdown", raw, false);
    expect(r.type).toBe("number");
    expect(r.parsedValue).toBeNull();
  });
});
