// stream.jsonl keeps Claude Code's stream for each session. Claude Code repeats every image the agent
// sees as base64 there, while the runtime already saves it under screenshots/: one Unreal session
// reached 16 MB after 51 calls (test-PC finding F8). Images are replaced by their hash, size and the
// saved screenshot file with the same bytes, so the log stays small and still points at the image.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface ImageRef {
  holder: { [k: string]: Json };
  key: "data";
  sha256: string;
  bytes: number;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Every base64 image payload in a stream message: Anthropic blocks (source.data) and MCP content (data). */
function images(node: Json, out: ImageRef[] = []): ImageRef[] {
  if (Array.isArray(node)) node.forEach((n) => images(n, out));
  else if (node && typeof node === "object") {
    const isImage = node.type === "image";
    const src = node.source as { [k: string]: Json } | undefined;
    const holder = isImage && src && typeof src === "object" && typeof src.data === "string" ? src : isImage && typeof node.data === "string" ? node : null;
    if (holder) {
      const buf = Buffer.from(holder.data as string, "base64");
      out.push({ holder, key: "data", sha256: sha(buf), bytes: buf.length });
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") images(v, out);
  }
  return out;
}

/** sha256 → file name for the screenshots a runtime saved in this job folder (refreshed on demand). */
export class ScreenshotIndex {
  private map = new Map<string, string>();
  private seen = new Set<string>();
  constructor(private readonly dir: string) {}
  async find(hash: string): Promise<string | null> {
    if (!this.map.has(hash) && existsSync(this.dir))
      for (const f of await readdir(this.dir)) {
        if (this.seen.has(f)) continue;
        this.seen.add(f);
        this.map.set(sha(await readFile(join(this.dir, f))), `screenshots/${f}`);
      }
    return this.map.get(hash) ?? null;
  }
}

/** The stream line with image data replaced by { omitted, sha256, bytes, file }. Other lines unchanged. */
export async function compactStreamLine(line: string, index: ScreenshotIndex): Promise<string> {
  if (!line.includes('"image"')) return line;
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }
  const found = images(msg);
  if (!found.length) return line;
  for (const img of found) {
    delete img.holder[img.key];
    img.holder.omitted = "image data removed from the log";
    img.holder.sha256 = img.sha256;
    img.holder.bytes = img.bytes;
    img.holder.file = await index.find(img.sha256);
  }
  return JSON.stringify(msg);
}
