import { randomUUID, createHash } from "node:crypto";
import { agentLevel, hash, jobPacket, verifyPlan } from "./planner.js";
import {
  requireThat,
  validateAgents,
  validateStudy,
} from "./validation.js";
import type { AgentProtocol, Job, Plan, Study } from "./types.js";

export interface CampaignModel {
  provider: string;
  model: string;
  reasoning: string;
}
export interface CampaignAsset {
  id: string;
  label: string;
  sha256: string;
  verification: "file" | "worker-attestation";
  pathHint: string;
  access: "controller" | "permitted-input";
}
export interface CampaignRecipe {
  files: boolean;
  pie: boolean;
  evidence: boolean;
  personalInformation: string[];
  workflow: string;
  limits: Record<string, number | null>;
  instructions: string[];
  /** Generic planner-derived suites keep the complete agent protocol (model excluded). */
  protocol?: Omit<AgentProtocol, "model">;
}
export interface CampaignTemplateJob {
  id: string;
  repetition: number;
  participantId?: string;
  assetIds: string[];
  sourceJobId?: string;
}
export interface CampaignCondition {
  id: string;
  label: string;
  stage: "population" | "individual";
  kind: "llm" | "rules" | "derived";
  recipe: CampaignRecipe;
  jobs: CampaignTemplateJob[];
  sourceConditionId?: string;
}
export interface CampaignSuite {
  schemaVersion: "xr-campaign-suite/1";
  id: string;
  title: string;
  synthetic: boolean;
  conditions: CampaignCondition[];
  assets: CampaignAsset[];
  scoring: { adapter: string; assetIds: string[]; notes: string[] };
  notes: string[];
  /** Present when the suite was frozen from a workbench Study/Plan; enables built-in analysis. */
  study?: Study;
}
/** Where an unchanged job was actually executed. Always the original campaign, never an intermediate. */
export interface CampaignOrigin {
  campaignDigest: string;
  campaignId: string;
  createdAt: string;
  jobId: string;
}
export interface CampaignJob extends CampaignTemplateJob {
  id: string;
  templateJobId: string;
  conditionId: string;
  kind: CampaignCondition["kind"];
  sessionKey: string;
  sourceJobId?: string;
  /** Carried forward from an earlier campaign: identical setup, so its output is reused, not re-executed. */
  inheritedFrom?: CampaignOrigin;
}
/** Change set that derives a new campaign from a previous one. */
export interface CampaignContinuation {
  /** New default forecasting model for every LLM condition without an explicit override. */
  model?: CampaignModel;
  /** Per-condition model overrides; null removes an override. */
  conditionModels?: Record<string, CampaignModel | null>;
  /** Copy an existing LLM condition under a new ID, typically to add another model as a new arm. */
  cloneConditions?: {
    from: string;
    id: string;
    label?: string;
    model?: CampaignModel;
  }[];
  /** Entirely new conditions (new setups). */
  addConditions?: CampaignCondition[];
  /** Ensure at least N repetitions per condition (per participant for individual conditions). */
  repetitions?: Record<string, number>;
  dropConditions?: string[];
  /** Force fresh sessions even where the setup is unchanged. */
  rerunConditions?: string[];
  /** Extra planned contrasts (planner-derived suites only). */
  addContrasts?: Study["analysis"]["contrasts"];
  /** Parent template job IDs to execute again because they never completed (see continueFromStatus). */
  retryJobs?: string[];
  /**
   * New names for conditions. Filled in automatically when a model change updates a label that was
   * generated from the old model ("Text only — model-a" → "Text only — model-b, effort high").
   */
  labels?: Record<string, string>;
  note?: string;
}
export interface Campaign {
  schemaVersion: "xr-campaign/1";
  id: string;
  createdAt: string;
  parentDigest: string | null;
  suite: CampaignSuite;
  protocolDigest: string;
  model: CampaignModel;
  /** Optional per-condition model overrides; absent in single-model campaigns. */
  conditionModels?: Record<string, CampaignModel>;
  /** Digests of every ancestor campaign, oldest first; present for continuations. */
  lineage?: string[];
  continuation?: CampaignContinuation;
  jobs: CampaignJob[];
  digest: string;
}
export interface CampaignReceipt {
  campaignDigest: string;
  jobId: string;
  attempt: number;
  status: "completed" | "failed";
  actualModel: CampaignModel | null;
  sessionId: string;
  freshSession: boolean;
  freshPIE: boolean;
  freshScreenshots: boolean;
  assetHashes: Record<string, string>;
  output: { path: string; sha256: string } | null;
  executionManifest: { path: string; sha256: string } | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  error?: string;
}
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const shaPattern = /^[a-f0-9]{64}$/;
export function validateSuite(value: unknown): CampaignSuite {
  const s = value as CampaignSuite;
  requireThat(
    s && s.schemaVersion === "xr-campaign-suite/1" && idPattern.test(s.id),
    "Invalid campaign suite.",
  );
  requireThat(
    typeof s.title === "string" && typeof s.synthetic === "boolean",
    "Declare campaign title and synthetic status.",
  );
  requireThat(
    Array.isArray(s.assets) &&
      Array.isArray(s.conditions) &&
      s.conditions.length > 0,
    "A suite needs assets and conditions.",
  );
  const assets = new Set(s.assets.map((a) => a.id));
  requireThat(assets.size === s.assets.length, "Duplicate campaign asset ID.");
  s.assets.forEach((a) =>
    requireThat(
      idPattern.test(a.id) &&
        shaPattern.test(a.sha256) &&
        ["file", "worker-attestation"].includes(a.verification) &&
        ["controller", "permitted-input"].includes(a.access),
      `Invalid campaign asset ${a.id}.`,
    ),
  );
  const conditions = new Set(s.conditions.map((c) => c.id));
  requireThat(
    conditions.size === s.conditions.length,
    "Duplicate campaign condition.",
  );
  const jobs = new Map<
    string,
    { condition: CampaignCondition; job: CampaignTemplateJob }
  >();
  for (const c of s.conditions) {
    requireThat(
      idPattern.test(c.id) &&
        ["llm", "rules", "derived"].includes(c.kind) &&
        ["population", "individual"].includes(c.stage),
      "Invalid campaign condition.",
    );
    requireThat(
      c.recipe &&
        [c.recipe.files, c.recipe.pie, c.recipe.evidence].every(
          (v) => typeof v === "boolean",
        ) &&
        Array.isArray(c.recipe.personalInformation) &&
        Array.isArray(c.recipe.instructions),
      `Invalid recipe ${c.id}.`,
    );
    requireThat(
      Object.values(c.recipe.limits).every(
        (v) => v === null || (Number.isFinite(v) && v >= 0),
      ),
      `Invalid limits for ${c.id}.`,
    );
    requireThat(
      Array.isArray(c.jobs) && c.jobs.length > 0,
      `Condition ${c.id} has no jobs.`,
    );
    for (const j of c.jobs) {
      requireThat(
        idPattern.test(j.id) &&
          !jobs.has(j.id) &&
          Number.isInteger(j.repetition) &&
          j.repetition > 0,
        "Invalid or duplicate campaign job.",
      );
      requireThat(
        !j.participantId || idPattern.test(j.participantId),
        "Invalid participant ID.",
      );
      requireThat(
        c.stage !== "individual" || !!j.participantId,
        "Individual jobs need a participant ID.",
      );
      requireThat(
        Array.isArray(j.assetIds) && j.assetIds.every((id) => assets.has(id)),
        `Unknown input asset for ${j.id}.`,
      );
      jobs.set(j.id, { condition: c, job: j });
    }
  }
  for (const c of s.conditions.filter((c) => c.kind === "derived")) {
    requireThat(
      conditions.has(c.sourceConditionId ?? ""),
      `Unknown source for ${c.id}.`,
    );
    for (const j of c.jobs) {
      const src = jobs.get(j.sourceJobId ?? "");
      requireThat(
        src &&
          src.condition.id === c.sourceConditionId &&
          src.condition.kind === "llm" &&
          src.job.repetition === j.repetition,
        `Derived job ${j.id} must point to a matching model run in this suite.`,
      );
      requireThat(
        j.assetIds.length === 0,
        "Derived references do not receive participant evidence.",
      );
    }
  }
  requireThat(
    s.scoring &&
      Array.isArray(s.scoring.assetIds) &&
      s.scoring.assetIds.every((id) => assets.has(id)) &&
      typeof s.scoring.adapter === "string",
    "Declare a scoring adapter and known scoring assets.",
  );
  requireThat(
    s.conditions.flatMap((c) => c.jobs).length <= 20_000,
    "Campaign too large for this workbench.",
  );
  if (s.study !== undefined) validateStudyBinding(s);
  return s;
}
const placeholderModel = {
  provider: "campaign",
  model: "campaign",
  reasoning: "campaign",
};
/** A planner-derived suite must remain analyzable: every LLM arm carries a valid protocol for the embedded study. */
function validateStudyBinding(s: CampaignSuite): void {
  const study = validateStudy(s.study);
  const llm = s.conditions.filter((c) => c.kind === "llm");
  requireThat(
    s.conditions.every((c) => c.kind === "llm"),
    "Planner-derived suites currently support model-run conditions only.",
  );
  const people = new Set(study.participants.map((p) => p.id));
  for (const c of llm) {
    requireThat(
      c.recipe.protocol?.id === c.id,
      `Condition ${c.id} needs its agent protocol with the same ID.`,
    );
    const level = c.recipe.protocol!.level ?? study.predictionLevel;
    requireThat(
      c.stage === level,
      `Condition ${c.id} stage differs from its prediction level.`,
    );
    requireThat(
      c.jobs.every((j) =>
        level === "population"
          ? !j.participantId
          : people.has(j.participantId ?? ""),
      ),
      `Condition ${c.id} schedules an unknown participant.`,
    );
  }
  validateAgents(
    study,
    llm.map((c) => ({ ...c.recipe.protocol!, model: placeholderModel })),
  );
}
export function validModel(model: CampaignModel, label = "model"): void {
  requireThat(
    [model?.provider, model?.model, model?.reasoning].every(
      (v) => typeof v === "string" && v.trim().length > 0 && v.length < 200,
    ),
    `Enter provider/transport, exact model ID and reasoning settings (${label}).`,
  );
}
/** Effective requested model for a condition (override or campaign default). */
export function conditionModel(c: Campaign, conditionId: string): CampaignModel {
  return c.conditionModels?.[conditionId] ?? c.model;
}
const effortLevels = /^(?:effort\s*[=:]\s*)?(low|medium|high|xhigh|max)$/i;
/**
 * The effort in a reasoning setting: "high" for "effort=high" or "high", "default" for an empty
 * or default setting, otherwise the setting as written (other providers' reasoning labels).
 */
export function effortOf(reasoning: string): string {
  const r = String(reasoning ?? "").trim();
  if (!r || r.toLowerCase() === "default") return "default";
  const m = effortLevels.exec(r);
  return m ? m[1].toLowerCase() : r;
}
/** A model for people: "claude-sonnet-5-5, effort high"; a default effort is left out. */
export function describeModel(m: CampaignModel): string {
  const effort = effortOf(m.reasoning);
  if (effort === "default") return m.model;
  return effortLevels.test(effort) ? `${m.model}, effort ${effort}` : `${m.model}, ${effort}`;
}
/** Which parts of two model settings differ (effort compared by meaning: "high" = "effort=high"). */
export function modelDifferences(
  a: CampaignModel,
  b: CampaignModel,
): ("provider" | "model" | "effort")[] {
  const out: ("provider" | "model" | "effort")[] = [];
  if (a.provider !== b.provider) out.push("provider");
  if (a.model !== b.model) out.push("model");
  if (effortOf(a.reasoning) !== effortOf(b.reasoning)) out.push("effort");
  return out;
}
/** Where a job's output comes from: this campaign's session, or the one it was reused from. */
export function executedKey(c: Campaign, j: CampaignJob): string {
  return j.inheritedFrom
    ? `${j.inheritedFrom.campaignDigest}/${j.inheritedFrom.jobId}`
    : `${c.digest}/${j.id}`;
}
/**
 * Receipts and results carry the job ID of the campaign that executed them. This maps
 * "campaignDigest/jobId" of every session the campaign uses (its own and reused ones) to the
 * campaign's own job ID. Records of superseded ancestor sessions are not in the map.
 */
export function lineageJobIndex(c: Campaign): Map<string, string> {
  return new Map(c.jobs.map((j) => [executedKey(c, j), j.id]));
}
interface BuildOptions {
  parentDigest: string | null;
  id: string;
  createdAt: string;
  conditionModels?: Record<string, CampaignModel>;
  inherited?: Record<string, CampaignOrigin>;
  lineage?: string[];
  continuation?: CampaignContinuation;
}
function buildCampaign(
  suite: unknown,
  model: CampaignModel,
  o: BuildOptions,
): Campaign {
  const s = structuredClone(validateSuite(suite));
  validModel(model);
  const { id, createdAt, parentDigest } = o;
  requireThat(
    idPattern.test(id) && Number.isFinite(Date.parse(createdAt)),
    "Invalid campaign identity.",
  );
  requireThat(
    parentDigest === null || shaPattern.test(parentDigest),
    "Invalid parent campaign digest.",
  );
  const conditions = new Map(s.conditions.map((c) => [c.id, c]));
  const overrides = Object.entries(o.conditionModels ?? {});
  overrides.forEach(([cid, m]) => {
    requireThat(
      conditions.get(cid)?.kind === "llm",
      `Model override for unknown or non-model condition ${cid}.`,
    );
    validModel(m, cid);
  });
  if (o.lineage) {
    requireThat(
      o.lineage.length > 0 &&
        o.lineage.every((d) => shaPattern.test(d)) &&
        o.lineage[o.lineage.length - 1] === parentDigest,
      "Campaign lineage must end with the parent digest.",
    );
  }
  const templates = new Map(
    s.conditions.flatMap((c) => c.jobs.map((j) => [j.id, j] as const)),
  );
  const inherited = o.inherited ?? {};
  for (const [tpl, origin] of Object.entries(inherited)) {
    requireThat(templates.has(tpl), `Inherited job ${tpl} is not scheduled.`);
    requireThat(
      shaPattern.test(origin?.campaignDigest) &&
        idPattern.test(origin.campaignId) &&
        Number.isFinite(Date.parse(origin.createdAt)) &&
        typeof origin.jobId === "string" &&
        origin.jobId.startsWith(origin.campaignId + "--") &&
        (o.lineage ?? []).includes(origin.campaignDigest),
      `Invalid inheritance record for ${tpl}.`,
    );
    const source = templates.get(tpl)!.sourceJobId;
    if (source)
      requireThat(
        !!inherited[source],
        `Derived job ${tpl} can only be reused together with its source run.`,
      );
  }
  for (const [tpl, job] of templates)
    if (job.sourceJobId && inherited[job.sourceJobId] && !inherited[tpl])
      requireThat(false, `Derived job ${tpl} must follow its reused source.`);
  const map = new Map([...templates.keys()].map((t) => [t, `${id}--${t}`]));
  const jobs: CampaignJob[] = s.conditions.flatMap((c) =>
    c.jobs.map((j) => ({
      ...j,
      id: map.get(j.id)!,
      templateJobId: j.id,
      conditionId: c.id,
      kind: c.kind,
      sessionKey: `${id}--${j.id}`,
      ...(j.sourceJobId ? { sourceJobId: map.get(j.sourceJobId)! } : {}),
      ...(inherited[j.id] ? { inheritedFrom: { ...inherited[j.id] } } : {}),
    })),
  );
  const body = {
    schemaVersion: "xr-campaign/1" as const,
    id,
    createdAt,
    parentDigest,
    suite: s,
    protocolDigest: hash(s),
    model: { ...model },
    ...(overrides.length
      ? { conditionModels: Object.fromEntries(overrides) }
      : {}),
    ...(o.lineage ? { lineage: [...o.lineage] } : {}),
    ...(o.continuation ? { continuation: structuredClone(o.continuation) } : {}),
    jobs,
  };
  return { ...body, digest: hash(body) };
}
export function freezeCampaign(
  suite: unknown,
  model: CampaignModel,
  parentDigest: string | null = null,
  id = "campaign-" + randomUUID(),
  createdAt = new Date().toISOString(),
  conditionModels?: Record<string, CampaignModel>,
): Campaign {
  return buildCampaign(suite, model, {
    parentDigest,
    id,
    createdAt,
    conditionModels,
  });
}
export function verifyCampaign(c: Campaign): void {
  requireThat(c?.schemaVersion === "xr-campaign/1", "Unsupported campaign.");
  const { digest, ...body } = c;
  requireThat(hash(body) === digest, "Campaign integrity check failed.");
  const inherited = Object.fromEntries(
    (c.jobs ?? [])
      .filter((j) => j.inheritedFrom)
      .map((j) => [j.templateJobId, j.inheritedFrom!]),
  );
  const rebuilt = buildCampaign(c.suite, c.model, {
    parentDigest: c.parentDigest,
    id: c.id,
    createdAt: c.createdAt,
    conditionModels: c.conditionModels,
    inherited,
    lineage: c.lineage,
    continuation: c.continuation,
  });
  requireThat(
    rebuilt.digest === digest,
    "Campaign job schedule or protocol digest is inconsistent.",
  );
}
export function rerunCampaign(
  previous: Campaign,
  model: CampaignModel,
): Campaign {
  verifyCampaign(previous);
  return freezeCampaign(previous.suite, model, previous.digest);
}
const continuationKeys = [
  "model",
  "conditionModels",
  "cloneConditions",
  "addConditions",
  "repetitions",
  "dropConditions",
  "rerunConditions",
  "addContrasts",
  "retryJobs",
  "labels",
  "note",
];
const labelKey = (label: string) => label.trim().toLowerCase();
/** The label a model arm gets when none is typed: "Text only — claude-sonnet-5-5, effort high". */
export function modelArmLabel(base: string, model: CampaignModel): string {
  return `${base} — ${describeModel(model)}`;
}
/** Labels generated by earlier versions named only the model ID; kept so older continuations still verify. */
const legacyArmLabel = (base: string, model?: CampaignModel) =>
  `${base}${model ? ` — ${model.model}` : " (copy)"}`;
/** The part before " — <model>" when a label was generated from this model (any style), else null. */
function generatedLabelBase(label: string, model: CampaignModel): string | null {
  for (const tail of [describeModel(model), model.model]) {
    const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^(.+) — ${escaped}(?: \\(\\d+\\))?$`).exec(label);
    if (m) return m[1];
  }
  return null;
}
/** `label`, or `label (2)`, `label (3)`… so that it differs from every label in `taken`. */
function uniqueLabel(label: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(labelKey));
  if (!used.has(labelKey(label))) return label;
  for (let n = 2; ; n++)
    if (!used.has(labelKey(`${label} (${n})`))) return `${label} (${n})`;
}
function validLabel(label: unknown, cid: string): string {
  requireThat(
    typeof label === "string" && label.trim().length > 0 && label.length <= 200,
    `Give ${cid} a label of 1–200 characters.`,
  );
  return (label as string).trim();
}
function nextJobId(base: string, repetition: number): string {
  return /-r\d+$/.test(base)
    ? base.replace(/-r\d+$/, `-r${repetition}`)
    : `${base}-r${repetition}`;
}
function renameJobId(jobId: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|-)${escaped}(?=-)`);
  return pattern.test(jobId) ? jobId.replace(pattern, `$1${to}`) : `${to}-${jobId}`;
}
/**
 * Derive a new campaign from a previous one with new models and/or setups.
 *
 * Jobs whose complete setup is unchanged (condition recipe, job template,
 * input asset bytes, effective model and, for planner suites, the study
 * outcomes) are carried forward: they point at the campaign that actually
 * executed them, so their first valid output is reused instead of paying for
 * a new session. Everything else receives a fresh campaign-qualified job.
 */
export function continueCampaign(
  previous: Campaign,
  changes: CampaignContinuation,
  id = "campaign-" + randomUUID(),
  createdAt = new Date().toISOString(),
): Campaign {
  return deriveCampaign(previous, changes, id, createdAt, "create");
}
/**
 * "create" makes a new continuation: it generates labels (model arms, labels that follow a model
 * change), checks that labels are unique, and records every label in the change set. "verify"
 * replays a recorded change set exactly as it was made, so earlier continuations still verify.
 */
function deriveCampaign(
  previous: Campaign,
  changes: CampaignContinuation,
  id: string,
  createdAt: string,
  mode: "create" | "verify",
): Campaign {
  verifyCampaign(previous);
  requireThat(
    changes &&
      typeof changes === "object" &&
      Object.keys(changes).every((k) => continuationKeys.includes(k)) &&
      Object.keys(changes).some((k) => k !== "note"),
    changes && typeof changes === "object" && Object.keys(changes).some((k) => !continuationKeys.includes(k))
      ? `Unknown change "${Object.keys(changes).find((k) => !continuationKeys.includes(k))}"; allowed: ${continuationKeys.join(", ")}.`
      : `A continuation needs at least one change (${continuationKeys.filter((k) => k !== "note").join(", ")}); a note alone changes nothing.`,
  );
  const ch = structuredClone(changes);
  const suite = structuredClone(previous.suite);
  const has = (cid: string) => suite.conditions.some((c) => c.id === cid);
  const find = (cid: string) => {
    const c = suite.conditions.find((x) => x.id === cid);
    requireThat(c, `Unknown condition ${cid}.`);
    return c!;
  };
  const models: Record<string, CampaignModel> = {
    ...(previous.conditionModels ?? {}),
  };
  // 1. Drop conditions (and planned contrasts that refer to them).
  for (const cid of ch.dropConditions ?? []) {
    find(cid);
    const dependents = suite.conditions.filter(
      (c) => c.sourceConditionId === cid && !ch.dropConditions!.includes(c.id),
    );
    requireThat(
      dependents.length === 0,
      `Drop ${dependents.map((d) => d.id).join(", ")} together with ${cid}.`,
    );
    suite.conditions = suite.conditions.filter((c) => c.id !== cid);
    delete models[cid];
    if (suite.study)
      suite.study.analysis.contrasts = suite.study.analysis.contrasts.filter(
        (x) => x.baseline !== cid && x.candidate !== cid,
      );
  }
  // 2. Clone conditions as new arms (e.g. the same method with another model).
  /** A label the researcher typed must not repeat another configuration's label. */
  const typedLabel = (label: unknown, cid: string) => {
    const clean = validLabel(label, cid);
    const other = suite.conditions.find(
      (c) => c.id !== cid && labelKey(c.label) === labelKey(clean),
    );
    requireThat(
      !other,
      `The label "${clean}" is already used by ${other?.id}. Give ${cid} another label.`,
    );
    return clean;
  };
  for (const clone of ch.cloneConditions ?? []) {
    const from = find(clone.from);
    requireThat(
      from.kind === "llm",
      `Only model-run conditions can be cloned (${clone.from}).`,
    );
    requireThat(
      idPattern.test(clone?.id) && !has(clone.id),
      `Clone ID ${clone?.id} is invalid or already used.`,
    );
    if (clone.model) validModel(clone.model, clone.id);
    const copy = structuredClone(from);
    copy.id = clone.id;
    if (mode === "verify") copy.label = clone.label ?? legacyArmLabel(from.label, clone.model);
    else {
      // Generated labels name the model and effort and are made unique; typed ones must be unique.
      copy.label =
        clone.label !== undefined
          ? typedLabel(clone.label, clone.id)
          : uniqueLabel(
              clone.model ? modelArmLabel(from.label, clone.model) : `${from.label} (copy)`,
              suite.conditions.map((c) => c.label),
            );
      clone.label = copy.label;
    }
    copy.jobs = copy.jobs.map((j) => ({
      ...j,
      id: renameJobId(j.id, from.id, clone.id),
    }));
    if (copy.recipe.protocol)
      copy.recipe.protocol = {
        ...copy.recipe.protocol,
        id: clone.id,
        label: copy.label,
      };
    suite.conditions.push(copy);
    if (clone.model) models[clone.id] = { ...clone.model };
    else if (models[from.id]) models[clone.id] = { ...models[from.id] };
  }
  // 3. New setups.
  for (const condition of ch.addConditions ?? []) {
    requireThat(
      condition && !has(condition.id),
      `Condition ${condition?.id} already exists.`,
    );
    if (mode === "create") typedLabel(condition.label, condition.id);
    suite.conditions.push(structuredClone(condition));
  }
  // 4. Extra repetitions: model-run/rules conditions first, then derived references.
  const reps = Object.entries(ch.repetitions ?? {});
  const ordered = [
    ...reps.filter(([cid]) => find(cid).kind !== "derived"),
    ...reps.filter(([cid]) => find(cid).kind === "derived"),
  ];
  for (const [cid, target] of ordered) {
    const c = find(cid);
    requireThat(
      Number.isInteger(target) && target >= 1 && target <= 50,
      `Use 1–50 repetitions for ${cid}.`,
    );
    const groups = new Map<string, CampaignTemplateJob[]>();
    c.jobs.forEach((j) => {
      const k = j.participantId ?? "";
      groups.set(k, [...(groups.get(k) ?? []), j]);
    });
    for (const group of groups.values()) {
      const max = Math.max(...group.map((j) => j.repetition));
      requireThat(
        target >= max,
        `${cid} already has ${max} repetitions; frozen repetitions cannot be removed. Drop the condition or start a new suite instead.`,
      );
      const base = [...group].sort((a, b) => a.repetition - b.repetition)[0];
      for (let r = max + 1; r <= target; r++) {
        const job: CampaignTemplateJob = {
          id: nextJobId(base.id, r),
          repetition: r,
          assetIds: [...base.assetIds],
          ...(base.participantId ? { participantId: base.participantId } : {}),
        };
        if (c.kind === "derived") {
          const source = find(c.sourceConditionId!).jobs.find(
            (j) =>
              j.repetition === r &&
              (!j.participantId || j.participantId === base.participantId),
          );
          requireThat(
            source,
            `Extend ${c.sourceConditionId} to ${r} repetitions before ${cid}.`,
          );
          job.sourceJobId = source!.id;
        }
        c.jobs.push(job);
      }
    }
  }
  // 5. Analysis additions for planner-derived suites.
  if (ch.addContrasts?.length) {
    requireThat(
      suite.study,
      "Contrasts can only be added to planner-derived suites.",
    );
    suite.study!.analysis.contrasts.push(...structuredClone(ch.addContrasts));
  }
  // 6. Models.
  const model = ch.model ?? previous.model;
  validModel(model);
  for (const [cid, m] of Object.entries(ch.conditionModels ?? {})) {
    find(cid);
    if (m === null) delete models[cid];
    else {
      validModel(m, cid);
      models[cid] = { ...m };
    }
  }
  for (const [cid, m] of Object.entries(models))
    if (!has(cid) || hash(m) === hash(model)) delete models[cid];
  const effective = (cid: string) => models[cid] ?? model;
  // 6b. Labels. Typed ones as given; a label generated from a model follows that model's change,
  // and a generated label that repeats another configuration's label is made unique.
  const relabel: Record<string, string> = {};
  requireThat(
    ch.labels === undefined || (typeof ch.labels === "object" && ch.labels !== null),
    "labels must map configuration IDs to labels.",
  );
  for (const [cid, label] of Object.entries(ch.labels ?? {})) {
    find(cid);
    relabel[cid] = mode === "create" ? typedLabel(label, cid) : label;
  }
  if (mode === "create") {
    const earlier = new Set(previous.suite.conditions.map((c) => c.id));
    const labelNow = (x: CampaignCondition) => relabel[x.id] ?? x.label;
    for (const c of suite.conditions) {
      if (c.kind !== "llm" || relabel[c.id] !== undefined || !earlier.has(c.id)) continue;
      const old = conditionModel(previous, c.id);
      const base = generatedLabelBase(c.label, old);
      if (base === null) continue;
      const others = suite.conditions.filter((x) => x.id !== c.id);
      const changed = modelDifferences(old, effective(c.id)).length > 0;
      const repeated = others.some((x) => labelKey(x.label) === labelKey(c.label));
      if (!changed && !repeated) continue;
      const next = uniqueLabel(modelArmLabel(base, effective(c.id)), others.map(labelNow));
      if (next !== c.label) relabel[c.id] = next;
    }
    if (Object.keys(relabel).length) ch.labels = relabel;
  }
  for (const [cid, label] of Object.entries(relabel)) {
    const c = find(cid);
    c.label = label;
    if (c.recipe.protocol) c.recipe.protocol = { ...c.recipe.protocol, label };
  }
  // 7. Reuse every job whose complete setup is unchanged.
  for (const cid of ch.rerunConditions ?? []) find(cid);
  const force = new Set(ch.rerunConditions ?? []);
  const retry = new Set(ch.retryJobs ?? []);
  retry.forEach((t) =>
    requireThat(
      previous.jobs.some((j) => j.templateJobId === t),
      `Retry job ${t} is not part of the previous campaign.`,
    ),
  );
  const before = new Map(previous.suite.conditions.map((c) => [c.id, c]));
  const beforeJobs = new Map(previous.jobs.map((j) => [j.templateJobId, j]));
  const beforeTemplates = new Map(
    previous.suite.conditions.flatMap((c) => c.jobs.map((j) => [j.id, j])),
  );
  const assetSha = (x: CampaignSuite) =>
    new Map(x.assets.map((a) => [a.id, a.sha256]));
  const oldSha = assetSha(previous.suite),
    newSha = assetSha(suite);
  const studyKey = (x: CampaignSuite) =>
    x.study
      ? hash({ ...x.study, analysis: { ...x.study.analysis, contrasts: [] } })
      : null;
  // A label is a name, not part of the setup: renaming a configuration keeps its runs.
  const conditionKey = (c: CampaignCondition) =>
    hash({
      stage: c.stage,
      kind: c.kind,
      recipe: c.recipe.protocol
        ? { ...c.recipe, protocol: { ...c.recipe.protocol, label: null } }
        : c.recipe,
      sourceConditionId: c.sourceConditionId ?? null,
    });
  const studySame = studyKey(previous.suite) === studyKey(suite);
  const inherited: Record<string, CampaignOrigin> = {};
  const reusable = (c: CampaignCondition, j: CampaignTemplateJob) => {
    const pc = before.get(c.id),
      pj = beforeJobs.get(j.id),
      pt = beforeTemplates.get(j.id);
    return (
      studySame &&
      !force.has(c.id) &&
      !retry.has(j.id) &&
      !!pc &&
      !!pj &&
      !!pt &&
      pj.conditionId === c.id &&
      conditionKey(pc) === conditionKey(c) &&
      hash(pt) === hash(j) &&
      j.assetIds.every((a) => oldSha.get(a) === newSha.get(a)) &&
      (c.kind !== "llm" ||
        hash(conditionModel(previous, c.id)) === hash(effective(c.id)))
    );
  };
  const origin = (tpl: string): CampaignOrigin => {
    const pj = beforeJobs.get(tpl)!;
    return (
      pj.inheritedFrom ?? {
        campaignDigest: previous.digest,
        campaignId: previous.id,
        createdAt: previous.createdAt,
        jobId: pj.id,
      }
    );
  };
  for (const kind of ["llm", "rules", "derived"] as const)
    for (const c of suite.conditions.filter((x) => x.kind === kind))
      for (const j of c.jobs)
        if (
          reusable(c, j) &&
          (kind !== "derived" || !!inherited[j.sourceJobId ?? ""])
        )
          inherited[j.id] = origin(j.id);
  return buildCampaign(suite, model, {
    parentDigest: previous.digest,
    id,
    createdAt,
    conditionModels: models,
    inherited,
    lineage: [...(previous.lineage ?? []), previous.digest],
    continuation: ch,
  });
}
export interface StatusContinuationOptions {
  /**
   * Jobs of the previous campaign whose selected output is a simulated (invented) run. They are
   * treated like jobs that never ran, so the continuation runs them again, unless keepSimulated.
   */
  simulatedJobIds?: Iterable<string>;
  /** Reuse simulated runs like real ones (for trying the pipeline). */
  keepSimulated?: boolean;
  /**
   * The receipts of the whole lineage are given (the workbench reads them itself), so a reused job
   * without a receipt never ran: it is run again instead of refusing the continuation.
   */
  receiptsComplete?: boolean;
}
/**
 * Continue from the parent's receipts: failed and never-started jobs are
 * executed again; completed jobs (including audit-held ones, which are never
 * retried automatically) are reused when their setup is unchanged.
 */
export function continueFromStatus(
  previous: Campaign,
  receipts: CampaignReceipt[],
  changes: CampaignContinuation = {},
  id?: string,
  createdAt?: string,
  options: StatusContinuationOptions = {},
): Campaign {
  const status = campaignStatus(previous, receipts);
  const missing = status.jobs.filter(
    (j) => j.state === "inherited-missing-receipt",
  );
  requireThat(
    options.receiptsComplete || missing.length === 0,
    `Supply the receipts of every campaign in the lineage (${missing.length} reused job(s) have no receipt).`,
  );
  const template = new Map(previous.jobs.map((j) => [j.id, j.templateJobId]));
  const notRun = [
    "pending",
    "failed",
    "inherited-failed",
    ...(options.receiptsComplete ? ["inherited-missing-receipt"] : []),
  ];
  const simulated = new Set(options.keepSimulated ? [] : options.simulatedJobIds ?? []);
  const retry = status.jobs
    .filter((j) => notRun.includes(j.state) || simulated.has(j.jobId))
    .map((j) => template.get(j.jobId)!);
  return continueCampaign(
    previous,
    {
      ...changes,
      ...(retry.length || changes.retryJobs
        ? { retryJobs: [...new Set([...(changes.retryJobs ?? []), ...retry])] }
        : {}),
    },
    id,
    createdAt,
  );
}
/** Recompute a continuation from its recorded change set and parent. */
export function verifyContinuation(parent: Campaign, child: Campaign): void {
  verifyCampaign(child);
  requireThat(
    child.parentDigest === parent.digest && child.continuation,
    "This campaign is not a recorded continuation of the given parent: it names another parent or records no change set (campaign-rerun output records none; campaign-verify checks it as a rerun).",
  );
  requireThat(
    deriveCampaign(parent, child.continuation!, child.id, child.createdAt, "verify")
      .digest === child.digest,
    "The continuation does not follow from its parent and recorded change set.",
  );
}
export function campaignSummary(c: Campaign) {
  verifyCampaign(c);
  const fresh = c.jobs.filter((j) => !j.inheritedFrom);
  return {
    llmSessions: c.jobs.filter((j) => j.kind === "llm").length,
    rulesChecks: c.jobs.filter((j) => j.kind === "rules").length,
    derivedProfiles: c.jobs.filter((j) => j.kind === "derived").length,
    reusedJobs: c.jobs.length - fresh.length,
    newLlmSessions: fresh.filter((j) => j.kind === "llm").length,
    defaultModel: c.model,
    ...(c.conditionModels ? { conditionModels: c.conditionModels } : {}),
    ...(c.parentDigest ? { parentDigest: c.parentDigest } : {}),
    conditions: c.suite.conditions.map((a) => ({
      id: a.id,
      kind: a.kind,
      stage: a.stage,
      jobs: a.jobs.length,
      reused: c.jobs.filter((j) => j.conditionId === a.id && j.inheritedFrom)
        .length,
      ...(a.kind === "llm" ? { model: conditionModel(c, a.id).model } : {}),
    })),
  };
}
export function campaignFiles(c: Campaign): Record<string, string> {
  verifyCampaign(c);
  const pretty = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
  const files: Record<string, string> = {
    "campaign.json": pretty(c),
    "summary.json": pretty(campaignSummary(c)),
    "queue.jsonl": c.jobs.map((j) => JSON.stringify(j)).join("\n") + "\n",
    // Work that needs a worker: everything not carried forward from an earlier campaign.
    "run-queue.jsonl":
      c.jobs
        .filter((j) => !j.inheritedFrom)
        .map((j) =>
          JSON.stringify({ ...j, model: j.kind === "llm" ? conditionModel(c, j.conditionId) : null }),
        )
        .join("\n") + "\n",
    "worker/README.md": `# External campaign execution\n\nCampaign ${c.id}\nModel: ${c.model.provider} / ${c.model.model}; ${c.model.reasoning}\n\nThis is a controller package, not a prediction-agent workspace. It does not contain private input bytes, API credentials, human answers or old predictions. Resolve asset IDs through a local bindings file; verify every hash and external-runtime dependency before starting paid runs. Give each forecast session only its allowlisted inputs and recipe; keep the campaign registry, other people, earlier results and scoring materials out of agent access.\n\nEach LLM job needs a fresh context, plus independent PIE state and captures when its recipe requires PIE. Do not alter exploration limits, prompts, targets, participant order or scoring because the model changed. Record effective model identity from the provider, not merely the requested model name. A provider or reasoning-setting change is recorded and may limit causal interpretation. Unlimited full-trajectory protocols must retain null limits.\n\nRules jobs verify/recompute unchanged deterministic references; they are not LLM calls. Derived jobs bind to the indicated source output in THIS campaign. Never substitute the previous model's output.\n\nReturn append-only receipts using the documented CampaignReceipt contract and hash actual result files. Keep failed attempts and unknown token usage; choose the first valid completed output, never the most favorable prediction. A receipt with a completed but noncompliant execution is held for audit, not automatically retried until its score improves. The built-in status checker validates receipt declarations, not the truth of self-reported exposure.\n\nThe local workbench does not launch models or XR. An execution adapter must translate queue entries into your existing worker and return its original output format for the frozen scoring adapter.\n`,
  };
  c.suite.conditions.forEach((condition) => {
    files[`recipes/${condition.id}.json`] = pretty(condition);
  });
  if (c.parentDigest || c.conditionModels)
    files["worker/CONTINUATION.md"] = `# Models and reused jobs\n\nDefault model: ${c.model.provider} / ${c.model.model}; ${c.model.reasoning}\n${Object.entries(
      c.conditionModels ?? {},
    )
      .map(([id, m]) => `- ${id}: ${m.provider} / ${m.model}; ${m.reasoning}`)
      .join("\n")}\n\nUse the per-condition model in run-queue.jsonl for every session and verify it in the receipt.\n\n${
      c.parentDigest
        ? `Parent campaign: ${c.parentDigest}\nReused jobs: ${c.jobs.filter((j) => j.inheritedFrom).length} of ${c.jobs.length}. Jobs with inheritedFrom are NOT executed again: their unchanged setup already ran in the named campaign. Keep the original receipts and outputs; concatenate the receipts of every campaign in the lineage when checking status or analysing results. Execute only run-queue.jsonl.\n`
        : ""
    }`;
  if (c.suite.study) {
    const plan = campaignPlan(c);
    plan.jobs
      .filter((j) => !c.jobs.find((x) => x.id === j.id)!.inheritedFrom)
      .forEach((j) => {
        files[`jobs/${j.id}.json`] = pretty(jobPacket(plan, j));
      });
  }
  files["manifest.json"] = pretty({
    campaignDigest: c.digest,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        createHash("sha256").update(text).digest("hex"),
      ]),
    ),
  });
  return files;
}

export function campaignStatus(c: Campaign, receipts: CampaignReceipt[]) {
  verifyCampaign(c);
  requireThat(Array.isArray(receipts), "Receipts must be an array.");
  const ownJobs = new Set(c.jobs.map((j) => j.id));
  // Inherited jobs are satisfied by receipts of the campaign that executed them.
  const originOf = new Map<string, string>();
  c.jobs.forEach((j) => {
    if (j.inheritedFrom)
      originOf.set(`${j.inheritedFrom.campaignDigest}/${j.inheritedFrom.jobId}`, j.id);
  });
  const lineage = new Set(c.lineage ?? []);
  const seen = new Set<string>();
  const relevant: (CampaignReceipt & { scheduledJobId: string })[] = [];
  let ignoredAncestorReceipts = 0;
  receipts.forEach((r) => {
    const own = r?.campaignDigest === c.digest && ownJobs.has(r.jobId);
    const inheritedJob = originOf.get(`${r?.campaignDigest}/${r?.jobId}`);
    const ancestor = lineage.has(r?.campaignDigest);
    requireThat(
      own || inheritedJob || ancestor,
      "Receipt belongs to another campaign or an unknown job.",
    );
    requireThat(
      Number.isInteger(r.attempt) &&
        r.attempt >= 1 &&
        !seen.has(`${r.campaignDigest}/${r.jobId}/${r.attempt}`),
      "Duplicate or invalid receipt attempt.",
    );
    requireThat(
      ["completed", "failed"].includes(r.status),
      "Unknown receipt status.",
    );
    seen.add(`${r.campaignDigest}/${r.jobId}/${r.attempt}`);
    if (own) relevant.push({ ...r, scheduledJobId: r.jobId });
    else if (inheritedJob) relevant.push({ ...r, scheduledJobId: inheritedJob });
    else ignoredAncestorReceipts++;
  });
  const sessions = new Map<string, string>();
  const reused = new Set<string>();
  relevant.forEach((r) => {
    if (r.sessionId) {
      const key = `${r.campaignDigest}/${r.jobId}/${r.attempt}`;
      if (sessions.has(r.sessionId) && sessions.get(r.sessionId) !== key)
        reused.add(r.sessionId);
      sessions.set(r.sessionId, key);
    }
  });
  const assets = new Map(c.suite.assets.map((a) => [a.id, a]));
  const states = c.jobs
    .filter((j) => j.kind !== "derived")
    .map((job) => {
      const attempts = relevant
        .filter((r) => r.scheduledJobId === job.id)
        .sort((a, b) => a.attempt - b.attempt);
      const done = attempts.find((r) => r.status === "completed");
      const recipe = c.suite.conditions.find(
        (a) => a.id === job.conditionId,
      )!.recipe;
      const expectedModel = conditionModel(c, job.conditionId);
      const issues: string[] = [];
      if (done) {
        if (
          job.kind === "llm" &&
          (!done.actualModel || hash(done.actualModel) !== hash(expectedModel))
        )
          issues.push("Effective model/settings differ from the campaign.");
        if (
          job.kind === "llm" &&
          (!done.sessionId || !done.freshSession || reused.has(done.sessionId))
        )
          issues.push("Missing fresh independent session.");
        if (recipe.pie && (!done.freshPIE || !done.freshScreenshots))
          issues.push("Fresh PIE and independent captures were not recorded.");
        job.assetIds.forEach((id) => {
          if (done.assetHashes?.[id] !== assets.get(id)!.sha256)
            issues.push(`Missing or changed asset: ${id}.`);
        });
        if (
          !done.output ||
          !shaPattern.test(done.output.sha256) ||
          !done.output.path
        )
          issues.push("Missing result artifact hash/path.");
        if (
          !done.executionManifest ||
          !shaPattern.test(done.executionManifest.sha256) ||
          !done.executionManifest.path
        )
          issues.push(
            "Missing execution manifest with actual worker/runtime versions and amendments.",
          );
        if (
          !done.usage ||
          ![done.usage.inputTokens, done.usage.outputTokens].every(
            (n) => n === null || (Number.isFinite(n) && n >= 0),
          )
        )
          issues.push("Invalid token usage; use null for unknown.");
      }
      return {
        jobId: job.id,
        conditionId: job.conditionId,
        state: done
          ? issues.length
            ? "audit-required"
            : "completed"
          : job.inheritedFrom
          ? attempts.length
            ? "inherited-failed"
            : "inherited-missing-receipt"
          : attempts.length
          ? "failed"
          : "pending",
        attempts: attempts.length,
        selectedAttempt: done?.attempt ?? null,
        ...(job.inheritedFrom ? { inheritedFrom: job.inheritedFrom } : {}),
        issues: [
          ...issues,
          ...(job.inheritedFrom && !done
            ? [
                `Reused setup: supply the receipts of ${job.inheritedFrom.campaignId}, or force a rerun of ${job.conditionId} in a new continuation.`,
              ]
            : []),
        ],
      };
    });
  c.jobs
    .filter((j) => j.kind === "derived")
    .forEach((j) => {
      const source = states.find((s) => s.jobId === j.sourceJobId);
      const condition = c.suite.conditions.find((x) => x.id === j.conditionId)!;
      states.push({
        jobId: j.id,
        conditionId: j.conditionId,
        state:
          source?.state === "completed"
            ? "derived-ready"
            : "waiting-for-source",
        attempts: 0,
        selectedAttempt: source?.selectedAttempt ?? null,
        ...(j.inheritedFrom ? { inheritedFrom: j.inheritedFrom } : {}),
        issues:
          source?.state === "completed"
            ? []
            : [
                `Needs the matching ${condition.sourceConditionId} output from this campaign lineage.`,
              ],
      });
    });
  return {
    campaignDigest: c.digest,
    counts: Object.fromEntries(
      [...new Set(states.map((s) => s.state))].map((k) => [
        k,
        states.filter((s) => s.state === k).length,
      ]),
    ),
    ignoredAncestorReceipts,
    jobs: states,
    // Only new work: reused jobs are never re-queued automatically.
    runnable: states
      .filter((s) => s.state === "pending" || s.state === "failed")
      .map((s) => s.jobId),
  };
}

/**
 * Plan view of a planner-derived campaign for the built-in analyzer and the
 * scoped job packets. Its digest is the campaign digest.
 */
export function campaignPlan(c: Campaign): Plan {
  verifyCampaign(c);
  requireThat(
    c.suite.study,
    "The built-in analyzer needs a planner-derived suite. Registry suites are scored by their frozen external adapter (xr-campaign-scores/1).",
  );
  const study = c.suite.study!;
  const agents = validateAgents(
    study,
    c.suite.conditions.map((cond) => ({
      ...cond.recipe.protocol!,
      model: { ...conditionModel(c, cond.id) },
    })),
  );
  const jobs: Job[] = c.jobs.map((j) => ({
    id: j.id,
    agentId: j.conditionId,
    repetition: j.repetition,
    ...(j.participantId ? { participantId: j.participantId } : {}),
  }));
  const frozenAt = [
    c.createdAt,
    ...c.jobs.flatMap((j) => (j.inheritedFrom ? [j.inheritedFrom.createdAt] : [])),
  ].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    schemaVersion: "1.0",
    study,
    agents,
    repetitions: Math.max(...jobs.map((j) => j.repetition)),
    jobs,
    frozenAt,
    jobFrozenAt: Object.fromEntries(
      c.jobs.map((j) => [j.id, j.inheritedFrom?.createdAt ?? c.createdAt]),
    ),
    digest: c.digest,
  };
}
const participantKinds: Record<string, string> = {
  demographics: "demographics",
  "objective-records": "measured-objective-data",
  trajectory: "trajectory",
};
/** Convert a frozen workbench Plan into a campaign suite, keeping every protocol and job. */
export function suiteFromPlan(plan: Plan): CampaignSuite {
  verifyPlan(plan);
  const study = plan.study;
  return validateSuite({
    schemaVersion: "xr-campaign-suite/1",
    id: `study-${study.id}`,
    title: study.title,
    synthetic: study.synthetic,
    study,
    assets: [],
    conditions: plan.agents.map((a) => {
      const { model: _model, ...protocol } = a;
      const sources = study.sources.filter((x) => a.sourceIds.includes(x.id));
      return {
        id: a.id,
        label: a.label,
        stage: agentLevel(study, a),
        kind: "llm" as const,
        recipe: {
          files: a.tools.includes("read-files"),
          pie: a.tools.includes("xr-interact"),
          evidence: a.tools.includes("read-evidence"),
          personalInformation: [
            ...new Set(
              sources.flatMap((x) =>
                participantKinds[x.kind] ? [participantKinds[x.kind]] : [],
              ),
            ),
          ],
          workflow: `${a.autonomy}/${a.caseOrder}`,
          limits: {
            maxToolCalls: a.maxToolCalls,
            maxOutputTokens: a.maxOutputTokens,
            ...(a.maxTokens ? { maxTokens: a.maxTokens } : {}),
          },
          instructions: [a.forecastInstruction],
          protocol,
        },
        jobs: plan.jobs
          .filter((j) => j.agentId === a.id)
          .map((j) => ({
            id: j.id,
            repetition: j.repetition,
            ...(j.participantId ? { participantId: j.participantId } : {}),
            assetIds: [],
          })),
      };
    }),
    scoring: {
      adapter: "xr-study-sim-analyzer/1",
      assetIds: [],
      notes: [
        "Built-in deterministic analyzer using the embedded study outcomes, family weights, tie tolerance, bootstrap draws and seed.",
        "Contrasts may be added by later continuations; they do not change the scoring definition of existing outcomes.",
      ],
    },
    notes: [
      `Frozen from workbench plan ${plan.digest}.`,
      "Each condition is one agent protocol. Continuations may add models, protocols and repetitions; unchanged jobs are reused.",
    ],
  });
}
/** Freeze a campaign from a Plan. Without an explicit model, each agent keeps its planned model. */
export function campaignFromPlan(
  plan: Plan,
  model?: CampaignModel,
  id?: string,
  createdAt?: string,
): Campaign {
  const suite = suiteFromPlan(plan);
  const base = model ?? plan.agents[0].model;
  const overrides = model
    ? {}
    : Object.fromEntries(
        plan.agents
          .filter((a) => hash(a.model) !== hash(base))
          .map((a) => [a.id, { ...a.model }]),
      );
  return freezeCampaign(suite, base, null, id, createdAt, overrides);
}
/** Digest of everything that defines scoring (contrasts excluded: they only add tests). */
export function scoringDigest(suite: CampaignSuite): string {
  return suite.study
    ? hash({
        scoring: suite.scoring,
        outcomes: suite.study.outcomes,
        conditions: suite.study.conditions,
        analysis: { ...suite.study.analysis, contrasts: [] },
      })
    : hash(suite.scoring);
}
