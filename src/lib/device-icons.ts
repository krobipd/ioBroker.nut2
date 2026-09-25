import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One pictogram per `device.type` value NUT documents (docs/nut-names.txt 2.8.5: "ups, pdu, scd,
 * psu, ats"; drivers/main.c sets "ups" before any driver runs). A type outside this list — the
 * macOS battery driver's "battery", adelsystem_cbi's "DC-UPS" — leaves the device icon untouched.
 */
export const ICON_BY_TYPE: Readonly<Record<string, string>> = {
  ups: "ups.svg",
  pdu: "pdu.svg",
  scd: "scd.svg",
  psu: "psu.svg",
  ats: "ats.svg",
};

/**
 * The admin inlines a `data:image/svg+xml` icon into the DOM, where `currentColor` follows the
 * theme; any other value (a path included) ends up in a bare `<img>` with a fixed colour.
 */
export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

// build/lib and src/lib both sit two levels below the adapter root.
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const cache = new Map<string, string | undefined>();

/**
 * Convert CRLF to LF. A Windows checkout would otherwise embed different bytes for the same file,
 * and the icon URI — the value compared against the stored object — would differ per platform.
 *
 * @param svg SVG markup as read from disk
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * Inline data URI for a NUT `device.type`; undefined for an unknown type or an unreadable file.
 *
 * @param type Value of the `device.type` variable (boundary: may be absent)
 */
export function deviceIcon(type: string | undefined): string | undefined {
  // API boundary: "constructor" and friends are inherited, not entries of the map.
  if (type === undefined || !Object.hasOwn(ICON_BY_TYPE, type)) {
    return undefined;
  }
  if (cache.has(type)) {
    return cache.get(type);
  }
  let uri: string | undefined;
  try {
    const svg = readFileSync(join(ICON_DIR, ICON_BY_TYPE[type]), "utf8");
    uri = `${ICON_URI_PREFIX}${Buffer.from(normaliseLineEndings(svg)).toString("base64")}`;
  } catch {
    // Unreadable: the field stays as it is, it is never emptied.
    uri = undefined;
  }
  cache.set(type, uri);
  return uri;
}
