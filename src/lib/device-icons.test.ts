import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deviceIcon, ICON_BY_TYPE, ICON_URI_PREFIX, normaliseLineEndings } from "./device-icons";

const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const fileOf = (name: string): string => normaliseLineEndings(readFileSync(join(ICON_DIR, name), "utf8"));
const decode = (uri: string): string => Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");

describe("deviceIcon (E12)", () => {
  it("the URI carries exactly the bytes of the file", () => {
    const uri = deviceIcon("ups");
    expect(uri?.startsWith(ICON_URI_PREFIX)).toBe(true);
    expect(decode(uri!)).toBe(fileOf("ups.svg"));
  });

  it("every documented device.type maps to its own file, never to a path", () => {
    // docs/nut-names.txt 2.8.5: "Device type (ups, pdu, scd, psu, ats)".
    expect(Object.keys(ICON_BY_TYPE).sort()).toEqual(["ats", "pdu", "psu", "scd", "ups"]);
    for (const [type, file] of Object.entries(ICON_BY_TYPE)) {
      const uri = deviceIcon(type);
      expect(uri, type).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(decode(uri!), type).toBe(fileOf(file));
    }
  });

  it("a CRLF checkout embeds the same bytes as an LF checkout", () => {
    const lf = readFileSync(join(ICON_DIR, "pdu.svg"), "utf8").replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(normaliseLineEndings(crlf)).toBe(lf);
    expect(decode(deviceIcon("pdu")!)).not.toContain("\r");
  });

  it("returns the same value on every call", () => {
    expect(deviceIcon("ats")).toBe(deviceIcon("ats"));
  });

  it("an unknown or absent type yields no icon", () => {
    // Real values outside the documented list: macosx-ups.c:126 "battery", adelsystem_cbi.h:34 "DC-UPS".
    expect(deviceIcon("battery")).toBeUndefined();
    expect(deviceIcon("DC-UPS")).toBeUndefined();
    expect(deviceIcon("UPS")).toBeUndefined();
    expect(deviceIcon("")).toBeUndefined();
    expect(deviceIcon(undefined)).toBeUndefined();
  });

  it("an inherited property is not a device type", () => {
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(deviceIcon(inherited), inherited).toBeUndefined();
    }
  });

  it("there is a file for every type and no file without a type", () => {
    const files = readdirSync(ICON_DIR)
      .filter(f => f.endsWith(".svg"))
      .sort();
    expect(files).toEqual(Object.values(ICON_BY_TYPE).sort());
  });

  it("the files paint with currentColor or none only", () => {
    // The admin inlines the markup, so currentColor follows the theme; a fixed colour is invisible
    // in one of the two theme families.
    for (const file of Object.values(ICON_BY_TYPE)) {
      const svg = fileOf(file);
      const paints = [...svg.matchAll(/\b(?:fill|stroke|color|stop-color)\s*[=:]\s*"?([^";\s>]+)/g)].map(m => m[1]);
      expect(paints.length, file).toBeGreaterThan(0);
      for (const paint of paints) {
        expect(["currentColor", "none"], `${file}: ${paint}`).toContain(paint);
      }
      expect(svg, file).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|\b(?:black|white)\b/i);
    }
  });

  it("the files draw with path and circle only below the root", () => {
    // The object browser's id cell sets `width: initial` on every inlined element; for rect, image,
    // use, a nested svg and foreignObject that is 0 — they would render invisible.
    for (const file of Object.values(ICON_BY_TYPE)) {
      const body = fileOf(file).replace(/^\s*<svg\b[^>]*>/, "");
      const tags = [...body.matchAll(/<([a-zA-Z][\w-]*)/g)].map(m => m[1]);
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(["path", "circle", "g"], `${file}: <${tag}>`).toContain(tag);
      }
    }
  });
});
