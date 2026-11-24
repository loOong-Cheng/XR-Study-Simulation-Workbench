// Typed fields of a request body for the workbench API. A wrong type gets a plain message instead
// of a JavaScript error or a silent conversion ("false" is not true, ["x"] is not "x", an object is
// not a label), and texts and lists are bounded.
export type Body = Record<string, unknown>;
const invalid = (key: string, what: string) => new Error(`Invalid request: "${key}" must be ${what}.`);
const absent = (v: unknown) => v === undefined || v === null;

/** A text of at most `max` characters; "" when optional and absent. */
export function text(body: Body, key: string, opts: { max?: number; optional?: boolean } = {}): string {
  const v = body[key];
  const max = opts.max ?? 200;
  if (absent(v) && opts.optional) return "";
  if (typeof v !== "string") throw invalid(key, "a text");
  if (v.length > max) throw invalid(key, `at most ${max.toLocaleString("en")} characters long`);
  return v;
}
/** true or false; false when absent. */
export function flag(body: Body, key: string): boolean {
  const v = body[key];
  if (absent(v)) return false;
  if (typeof v !== "boolean") throw invalid(key, "true or false");
  return v;
}
/** A whole number in [min, max]; `fallback` when absent. */
export function int(body: Body, key: string, opts: { min: number; max: number; fallback: number }): number {
  const v = body[key];
  if (absent(v)) return opts.fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < opts.min || v > opts.max) throw invalid(key, `a whole number from ${opts.min} to ${opts.max}`);
  return v;
}
/** A list of texts; undefined when optional and absent. */
export function texts(body: Body, key: string, opts: { optional: true; maxItems?: number; max?: number }): string[] | undefined;
export function texts(body: Body, key: string, opts?: { optional?: false; maxItems?: number; max?: number }): string[];
export function texts(body: Body, key: string, opts: { optional?: boolean; maxItems?: number; max?: number } = {}): string[] | undefined {
  const v = body[key];
  if (absent(v) && opts.optional) return undefined;
  const maxItems = opts.maxItems ?? 10_000,
    max = opts.max ?? 200;
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === "string" && x.length <= max))
    throw invalid(key, `a list of texts (at most ${maxItems.toLocaleString("en")}, each at most ${max} characters)`);
  return v as string[];
}
/** A JSON object (not a list); undefined when optional and absent. */
export function object(body: Body, key: string, opts: { optional: true }): Body | undefined;
export function object(body: Body, key: string, opts?: { optional?: false }): Body;
export function object(body: Body, key: string, opts: { optional?: boolean } = {}): Body | undefined {
  const v = body[key];
  if (absent(v) && opts.optional) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid(key, "an object");
  return v as Body;
}
/** A list of JSON objects; undefined when optional and absent. */
export function objects(body: Body, key: string, opts: { optional: true; maxItems?: number }): Body[] | undefined;
export function objects(body: Body, key: string, opts?: { optional?: false; maxItems?: number }): Body[];
export function objects(body: Body, key: string, opts: { optional?: boolean; maxItems?: number } = {}): Body[] | undefined {
  const v = body[key];
  if (absent(v) && opts.optional) return undefined;
  const maxItems = opts.maxItems ?? 10_000;
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => x && typeof x === "object" && !Array.isArray(x)))
    throw invalid(key, `a list of objects (at most ${maxItems.toLocaleString("en")})`);
  return v as Body[];
}
/** One of the given words; `fallback` when absent. */
export function choice<T extends string>(body: Body, key: string, options: readonly T[], fallback: T): T {
  const v = body[key];
  if (absent(v)) return fallback;
  if (typeof v !== "string" || !options.includes(v as T)) throw invalid(key, `one of ${options.join(", ")}`);
  return v as T;
}
