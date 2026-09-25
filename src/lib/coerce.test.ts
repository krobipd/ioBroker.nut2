import {
  coerceCommandTimeoutMs,
  parseDecimal,
  coerceHost,
  coercePollIntervalSec,
  coercePort,
  computeReconnectDelay,
  errText,
  localAddressOf,
  parseNotifyTrigger,
} from "./coerce";

describe("coerce", () => {
  // -----------------------------------------------------------------------
  // errText
  // -----------------------------------------------------------------------
  describe("errText", () => {
    it("should extract message from Error", () => {
      expect(errText(new Error("boom"))).toBe("boom");
    });

    it("should return 'null' for null", () => {
      expect(errText(null)).toBe("null");
    });

    it("should return 'undefined' for undefined", () => {
      expect(errText(undefined)).toBe("undefined");
    });

    it("should return strings as-is", () => {
      expect(errText("something")).toBe("something");
    });

    it("should stringify numbers", () => {
      expect(errText(42)).toBe("42");
    });

    it("should stringify booleans", () => {
      expect(errText(true)).toBe("true");
      expect(errText(false)).toBe("false");
    });

    it("should stringify bigints", () => {
      expect(errText(BigInt(99))).toBe("99");
    });

    it("should JSON.stringify plain objects", () => {
      expect(errText({ code: "ECONNREFUSED" })).toBe('{"code":"ECONNREFUSED"}');
    });

    it("should handle circular objects gracefully", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(typeof errText(obj)).toBe("string");
    });

    it("always returns a string — Symbol, function and a toJSON that drops everything", () => {
      // JSON.stringify returns undefined for all three WITHOUT throwing, so the catch never
      // ran and the declared string return was a lie (fleet defect, fixed in beszel/parcelapp/
      // homewizard first). A log line must never read "undefined" for a real error value.
      const cases: unknown[] = [Symbol("boom"), function boom() {}, { toJSON: () => undefined }];
      for (const value of cases) {
        const text = errText(value);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
      }
      expect(errText(Symbol("boom"))).toContain("boom");
    });

    it("renders an Error with an empty message by its code (net.connect to localhost)", () => {
      expect(errText(Object.assign(new Error(""), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
    });

    it("adds the reason one level down in `cause` (fetch failed)", () => {
      const err = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND nut.local") });
      expect(errText(err)).toBe("fetch failed (getaddrinfo ENOTFOUND nut.local)");
    });

    it("never prints the source of a thrown function", () => {
      const thrown = function secretHandler(): string {
        return "internals";
      };
      expect(errText(thrown)).toBe("[object Function]");
    });
  });

  // -----------------------------------------------------------------------
  // coerceHost
  // -----------------------------------------------------------------------
  describe("parseDecimal", () => {
    it("accepts finite numbers and decimal strings", () => {
      expect(parseDecimal(42)).toBe(42);
      expect(parseDecimal(-1.5)).toBe(-1.5);
      expect(parseDecimal(" 12.5 ")).toBe(12.5);
    });

    it("rejects a non-finite number that is already typed as one", () => {
      // A NUT value can arrive pre-parsed (JSON payload, admin config). Passing
      // Infinity through would store a value ioBroker cannot render and that
      // every consumer of the datapoint has to special-case.
      expect(parseDecimal(Infinity)).toBeNaN();
      expect(parseDecimal(-Infinity)).toBeNaN();
      expect(parseDecimal(NaN)).toBeNaN();
    });

    it("rejects text that only starts like a number", () => {
      expect(parseDecimal("12abc")).toBeNaN();
      expect(parseDecimal("Infinity")).toBeNaN();
      expect(parseDecimal("")).toBeNaN();
      expect(parseDecimal(null)).toBeNaN();
    });
  });

  describe("coerceHost", () => {
    it("should return trimmed host string", () => {
      expect(coerceHost("  192.168.1.100  ")).toBe("192.168.1.100");
    });

    it("should return hostname as-is", () => {
      expect(coerceHost("nas.local")).toBe("nas.local");
    });

    it("should return null for empty string", () => {
      expect(coerceHost("")).toBeNull();
    });

    it("should return null for whitespace-only string", () => {
      expect(coerceHost("   ")).toBeNull();
    });

    it("should return null for non-string types", () => {
      expect(coerceHost(42)).toBeNull();
      expect(coerceHost(null)).toBeNull();
      expect(coerceHost(undefined)).toBeNull();
      expect(coerceHost(true)).toBeNull();
      expect(coerceHost({})).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // coercePort
  // -----------------------------------------------------------------------
  describe("coercePort", () => {
    it("should return valid port as-is", () => {
      expect(coercePort(3493)).toBe(3493);
      expect(coercePort(8080)).toBe(8080);
    });

    it("should return default 3493 for NaN", () => {
      expect(coercePort(NaN)).toBe(3493);
    });

    it("should return default 3493 for non-number types", () => {
      expect(coercePort(null)).toBe(3493);
      expect(coercePort(undefined)).toBe(3493);
      expect(coercePort("abc")).toBe(3493);
    });

    it("should parse numeric strings", () => {
      expect(coercePort("3493")).toBe(3493);
      expect(coercePort("9999")).toBe(9999);
    });

    it("rejects garbage-suffix and non-decimal strings (strict fleet line, v0.4.2)", () => {
      // parseFloat would have half-parsed "34abc" → port 34.
      expect(coercePort("34abc")).toBe(3493);
      expect(coercePort("0x1FBB")).toBe(3493);
      expect(coercePort("3e3")).toBe(3493);
    });

    it("should clamp to minimum 1", () => {
      expect(coercePort(0)).toBe(1);
      expect(coercePort(-5)).toBe(1);
    });

    it("should clamp to maximum 65535", () => {
      expect(coercePort(70000)).toBe(65535);
      expect(coercePort(99999)).toBe(65535);
    });

    it("should floor fractional values", () => {
      expect(coercePort(3493.7)).toBe(3493);
      expect(coercePort(1.9)).toBe(1);
    });

    it("should return default for Infinity", () => {
      expect(coercePort(Infinity)).toBe(3493);
      expect(coercePort(-Infinity)).toBe(3493);
    });
  });

  // -----------------------------------------------------------------------
  // coercePollIntervalSec
  // -----------------------------------------------------------------------
  describe("coercePollIntervalSec", () => {
    it("should return valid interval as-is", () => {
      expect(coercePollIntervalSec(15)).toBe(15);
      expect(coercePollIntervalSec(60)).toBe(60);
    });

    it("should return default 15 for NaN", () => {
      expect(coercePollIntervalSec(NaN)).toBe(15);
    });

    it("should return default 15 for non-number types", () => {
      expect(coercePollIntervalSec(null)).toBe(15);
      expect(coercePollIntervalSec(undefined)).toBe(15);
      expect(coercePollIntervalSec("abc")).toBe(15);
    });

    it("should parse numeric strings", () => {
      expect(coercePollIntervalSec("30")).toBe(30);
    });

    it("rejects garbage-suffix strings → default (strict fleet line, v0.4.2)", () => {
      expect(coercePollIntervalSec("30abc")).toBe(15);
      expect(coercePollIntervalSec("1e2")).toBe(15);
    });

    it("should clamp to minimum 2 (NUT driver pollinterval default)", () => {
      expect(coercePollIntervalSec(1)).toBe(2);
      expect(coercePollIntervalSec(0)).toBe(2);
      expect(coercePollIntervalSec(-10)).toBe(2);
    });

    it("accepts the new lower bound unchanged", () => {
      expect(coercePollIntervalSec(2)).toBe(2);
      expect(coercePollIntervalSec(3)).toBe(3);
    });

    it("should clamp to maximum 300", () => {
      expect(coercePollIntervalSec(500)).toBe(300);
      expect(coercePollIntervalSec(9999)).toBe(300);
    });

    it("should floor fractional values", () => {
      expect(coercePollIntervalSec(15.9)).toBe(15);
    });

    it("should return default for Infinity", () => {
      expect(coercePollIntervalSec(Infinity)).toBe(15);
    });
  });

  // -----------------------------------------------------------------------
  // coerceCommandTimeoutMs
  // -----------------------------------------------------------------------
  describe("coerceCommandTimeoutMs", () => {
    it("should convert seconds to milliseconds", () => {
      expect(coerceCommandTimeoutMs(5)).toBe(5000);
      expect(coerceCommandTimeoutMs(10)).toBe(10000);
    });

    it("should return default 5000ms for NaN", () => {
      expect(coerceCommandTimeoutMs(NaN)).toBe(5000);
    });

    it("should return default 5000ms for non-number types", () => {
      expect(coerceCommandTimeoutMs(null)).toBe(5000);
      expect(coerceCommandTimeoutMs(undefined)).toBe(5000);
      expect(coerceCommandTimeoutMs("abc")).toBe(5000);
    });

    it("should parse numeric strings", () => {
      expect(coerceCommandTimeoutMs("10")).toBe(10000);
    });

    it("rejects garbage-suffix strings → default (strict fleet line, v0.4.2)", () => {
      expect(coerceCommandTimeoutMs("10abc")).toBe(5000);
      expect(coerceCommandTimeoutMs("0x10")).toBe(5000);
    });

    it("should clamp to minimum 1s = 1000ms", () => {
      expect(coerceCommandTimeoutMs(0)).toBe(1000);
      expect(coerceCommandTimeoutMs(-5)).toBe(1000);
    });

    it("should clamp to maximum 30s = 30000ms", () => {
      expect(coerceCommandTimeoutMs(60)).toBe(30000);
      expect(coerceCommandTimeoutMs(999)).toBe(30000);
    });

    it("should floor fractional values before converting", () => {
      expect(coerceCommandTimeoutMs(5.9)).toBe(5000);
    });

    it("should return default for Infinity", () => {
      expect(coerceCommandTimeoutMs(Infinity)).toBe(5000);
    });
  });

  describe("computeReconnectDelay", () => {
    it("returns the base delay on the first attempt", () => {
      expect(computeReconnectDelay(1, 1000, 60000)).toBe(1000);
    });

    it("doubles each attempt", () => {
      expect(computeReconnectDelay(2, 1000, 60000)).toBe(2000);
      expect(computeReconnectDelay(3, 1000, 60000)).toBe(4000);
      expect(computeReconnectDelay(4, 1000, 60000)).toBe(8000);
    });

    it("caps at maxMs", () => {
      expect(computeReconnectDelay(20, 1000, 60000)).toBe(60000);
      expect(computeReconnectDelay(100, 1000, 60000)).toBe(60000);
    });

    it("treats attempts < 1 as the first attempt", () => {
      expect(computeReconnectDelay(0, 1000, 60000)).toBe(1000);
      expect(computeReconnectDelay(-5, 1000, 60000)).toBe(1000);
    });
  });

  describe("localAddressOf", () => {
    it("returns undefined for empty / whitespace / non-string", () => {
      expect(localAddressOf("")).toBeUndefined();
      expect(localAddressOf("   ")).toBeUndefined();
      expect(localAddressOf(undefined)).toBeUndefined();
    });

    it("treats the 0.0.0.0 'all interfaces' sentinel as no bind", () => {
      expect(localAddressOf("0.0.0.0")).toBeUndefined();
      expect(localAddressOf(" 0.0.0.0 ")).toBeUndefined();
    });

    it("returns a concrete interface address, trimmed", () => {
      expect(localAddressOf("10.0.0.2")).toBe("10.0.0.2");
      expect(localAddressOf("  192.168.1.5  ")).toBe("192.168.1.5");
    });
  });

  describe("parseNotifyTrigger", () => {
    it("takes the first token as the upsmon event type", () => {
      expect(parseNotifyTrigger("ONBATT")).toEqual({ type: "ONBATT", upsRef: "", text: "ONBATT" });
    });

    it("takes everything after the first whitespace run as the UPS reference", () => {
      expect(parseNotifyTrigger("ONBATT ups3")).toMatchObject({ type: "ONBATT", upsRef: "ups3" });
      // A NUT name may contain spaces — the reference is the REST, not the second token.
      expect(parseNotifyTrigger("LOWBATT my ups")).toMatchObject({ type: "LOWBATT", upsRef: "my ups" });
    });

    it("strips the @host[:port] part upsmon appends to $UPSNAME", () => {
      expect(parseNotifyTrigger("ONBATT ups3@nas.local")).toMatchObject({ type: "ONBATT", upsRef: "ups3" });
      expect(parseNotifyTrigger("ONBATT ups3@nas.local:3493")).toMatchObject({ type: "ONBATT", upsRef: "ups3" });
      expect(parseNotifyTrigger("SHUTDOWN @host")).toMatchObject({ type: "SHUTDOWN", upsRef: "" });
    });

    it("keeps the host part in the echoed text — only the UPS reference is stripped", () => {
      expect(parseNotifyTrigger("ONBATT ups3@nas.local").text).toBe("ONBATT ups3@nas.local");
    });

    it("collapses tabs and repeated spaces like a shell would", () => {
      expect(parseNotifyTrigger("ONBATT\t  ups0")).toMatchObject({ type: "ONBATT", upsRef: "ups0" });
      expect(parseNotifyTrigger("  ONLINE   ups0  ")).toEqual({
        type: "ONLINE",
        upsRef: "ups0",
        text: "ONLINE   ups0",
      });
    });

    it("treats empty and whitespace-only values as a bare manual refresh", () => {
      const bare = { type: "", upsRef: "", text: "" };
      expect(parseNotifyTrigger("")).toEqual(bare);
      expect(parseNotifyTrigger("   ")).toEqual(bare);
      expect(parseNotifyTrigger(null)).toEqual(bare);
      expect(parseNotifyTrigger(undefined)).toEqual(bare);
    });

    it("stringifies primitive non-string writes but rejects objects", () => {
      // A script may write a number/boolean; the REST API always sends strings.
      expect(parseNotifyTrigger(42)).toEqual({ type: "42", upsRef: "", text: "42" });
      expect(parseNotifyTrigger(true)).toEqual({ type: "true", upsRef: "", text: "true" });
      // "[object Object]" as an event type helps nobody — an object is no trigger value, and
      // nothing of it may be echoed back into the string state.
      expect(parseNotifyTrigger({ evil: 1 })).toEqual({ type: "", upsRef: "", text: "" });
    });

    it("caps an overlong value instead of storing arbitrary blobs", () => {
      const blob = `X${"A".repeat(500)}`;
      const parsed = parseNotifyTrigger(blob);
      expect(parsed.type.length).toBeLessThanOrEqual(200);
      expect(parsed.type.startsWith("XAA")).toBe(true);
      // The echo is the capped text, never the 501-character blob.
      expect(parsed.text).toHaveLength(200);
    });
  });
});

describe("C8 parseNotifyTrigger — control characters never reach the log", () => {
  it("turns a line break into a space instead of a second log line", () => {
    const t = parseNotifyTrigger("LOWBATT ups0\nWARN forged line");
    expect(t.text).toBe("LOWBATT ups0 WARN forged line");
    expect(t.upsRef).not.toMatch(/[\r\n]/);
  });
});
