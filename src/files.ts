// Files written by other programs and systems: text in the encodings Windows tools save (a BOM
// from PowerShell 5.1 or Notepad, UTF-16 from Excel's "Unicode text", Windows-1252 from Excel's
// CSV), paths pasted with quotes, and names Windows reserves for devices.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

/** Windows-1252 bytes 0x80–0x9F (the rest equals Latin-1). Node's own decoder reads them as Latin-1. */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
function windows1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192), (b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b)));
  return out;
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
const swapBytes = (bytes: Uint8Array) => {
  const out = Buffer.alloc(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) (out[i] = bytes[i + 1]), (out[i + 1] = bytes[i]);
  return out;
};

/**
 * Text of a file, whatever a Windows or macOS program saved: a byte-order mark is removed and
 * names the encoding (UTF-8, UTF-16 LE or BE); UTF-16 without one is recognized by its zero bytes
 * in plain-ASCII text; bytes that are not valid UTF-8 are read as Windows-1252 (Excel's "CSV" on
 * Western Windows) instead of becoming "�".
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  const b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: Buffer.from(b.buffer, b.byteOffset + 3, b.length - 3).toString("utf8"), encoding: "utf-8" };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: Buffer.from(b.buffer, b.byteOffset + 2, b.length - 2).toString("utf16le"), encoding: "utf-16le" };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: swapBytes(b.subarray(2)).toString("utf16le"), encoding: "utf-16be" };
  if (b.length >= 4 && b[0] !== 0 && b[1] === 0 && b[2] !== 0 && b[3] === 0) return { text: Buffer.from(b.buffer, b.byteOffset, b.length).toString("utf16le"), encoding: "utf-16le" };
  if (b.length >= 4 && b[0] === 0 && b[1] !== 0 && b[2] === 0 && b[3] !== 0) return { text: swapBytes(b).toString("utf16le"), encoding: "utf-16be" };
  try {
    return { text: utf8.decode(b), encoding: "utf-8" };
  } catch {
    return { text: windows1252(b), encoding: "windows-1252" };
  }
}
/** A text file's content (see decodeText). */
export const readText = async (path: string) => decodeText(await readFile(path)).text;
export const readTextSync = (path: string) => decodeText(readFileSync(path)).text;
/** What to tell the researcher about how one or more files (`names`) were read, or "" for plain UTF-8. */
export function encodingNote(names: string, encoding: TextEncoding): string {
  if (encoding === "windows-1252") return `Read as Windows-1252, since it is not UTF-8 (as Excel saves "CSV" on Windows): ${names}. Check that accented letters look right.`;
  if (encoding !== "utf-8") return `Read as ${encoding.toUpperCase()} (as Excel saves "Unicode text"): ${names}.`;
  return "";
}

/** A JSON file, also when a Windows program saved it with a byte-order mark or as UTF-16. */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

/**
 * A path as pasted: surrounding spaces and one pair of surrounding quotes removed ("Copy as path"
 * in Windows Explorer adds double quotes; documents add typographic ones).
 */
export function unquotePath(value: string): string {
  const s = value.trim();
  const pairs = ['""', "''", "“”", "‘’", "„“"];
  return s.length >= 2 && pairs.some((p) => s[0] === p[0] && s[s.length - 1] === p[1]) ? s.slice(1, -1).trim() : s;
}

/**
 * A file or folder name that Windows cannot create or open as a file: CON, PRN, AUX, NUL, COM0–9
 * and LPT0–9 (also with an extension, any letter case, and the superscript digits ¹²³), or a name
 * ending in a dot or space (Windows drops those, so it would name another file).
 */
export function windowsUnusableName(name: string): boolean {
  return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(name.replace(/[. ]+$/, "")) || /[. ]$/.test(name);
}
