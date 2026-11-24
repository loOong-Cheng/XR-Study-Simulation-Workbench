// Fairness of what forecasting agents get: configurations that are compared should differ only in
// the ingredient a comparison is about, and nothing an agent gets may hint at the human results.
// Here: the neutral title agents see, the design order each session is given (counterbalanced like
// the humans), and the warnings shown on study-check, the Freeze page, Evidence & knowledge and in
// the analysis notes. docs/methodology.md ("Prompts and fairness") gives the reasons.
import { describeModel, modelDifferences } from "./campaign.js";
import { agentLevel, agentTargets } from "./planner.js";
import type { AgentProtocol, Comparison, Job, Study } from "./types.js";
export { agentTitle, NEUTRAL_TITLE } from "./planner.js";

// ---------- design order ----------
/**
 * The order of designs a session is given: the play order in the app and the order designs are
 * listed in (task, answer list, submit_forecast). Individual sessions get that person's own order.
 * Population sessions rotate through the human participants' orders over repetitions (repetition
 * r gets the order of participant ((r − 1) mod n) + 1, in the study's list), so the runs of a
 * configuration are counterbalanced like the humans, and every configuration gets the same order
 * in the same repetition. Between subjects, a person's order holds the one design they saw: it
 * comes first and the other designs follow in the study's cyclic order.
 */
export function designOrder(study: Pick<Study, "conditions" | "participants">, job: Pick<Job, "participantId" | "repetition">): string[] {
  const all = study.conditions.map((c) => c.id);
  const people = study.participants;
  const person = job.participantId
    ? people.find((p) => p.id === job.participantId)
    : people.length
    ? people[(((Math.max(1, job.repetition) - 1) % people.length) + people.length) % people.length]
    : undefined;
  const start = (person?.conditionOrder ?? []).filter((id) => all.includes(id));
  if (!start.length) return all;
  const last = all.indexOf(start[start.length - 1]);
  const rest = all.map((_, i) => all[(last + 1 + i) % all.length]).filter((id) => !start.includes(id));
  return [...start, ...rest];
}
/** Task IDs sorted by a design order (then by the study's phase order); tasks of other designs keep their place at the end. */
export function casesInOrder(study: Pick<Study, "cases" | "phases">, caseIds: string[], order: string[]): string[] {
  const rank = (id: string) => {
    const c = study.cases.find((x) => x.id === id);
    const d = c ? order.indexOf(c.conditionId) : -1;
    return [d < 0 ? order.length : d, c ? study.phases.findIndex((p) => p.id === c.phaseId) : 0];
  };
  return [...caseIds].sort((a, b) => {
    const [da, pa] = rank(a),
      [db, pb] = rank(b);
    return da - db || pa - pb;
  });
}
/** Whether an order is a usable design order for these tasks: every design once, all known, covering the tasks' designs. */
export function validOrder(study: Pick<Study, "conditions" | "cases">, order: unknown, caseIds: string[]): order is string[] {
  if (!Array.isArray(order) || !order.every((x) => typeof x === "string")) return false;
  const known = new Set(study.conditions.map((c) => c.id));
  const needed = new Set(caseIds.map((id) => study.cases.find((c) => c.id === id)?.conditionId).filter((x): x is string => !!x));
  return new Set(order).size === order.length && order.every((x) => known.has(x)) && [...needed].every((d) => order.includes(d));
}

// ---------- the research question ----------
/** Words that ask about the agents, not about the human study (longer phrases first). */
const AGENT_WORDS =
  /\b((?:agent|forecasting|prediction) (?:methods?|workflows?|configurations?)|agents?|agentic|LLMs?|large language models?|language models?|AI|artificial intelligence|GPT|Claude|configurations?|forecast(?:s|ers?|ing)?|reproduce[sd]?|text[- ]only|project files|(?:using|uses) the app)\b/gi;
/** The agent-related words a research question uses (lower case, each once). */
export function agentWords(text: string): string[] {
  return [...new Set((String(text ?? "").match(AGENT_WORDS) ?? []).map((w) => w.toLowerCase()))];
}
/** A warning when the research question (sent to every agent) asks about agents or methods. */
export function researchQuestionWarning(study: Pick<Study, "researchQuestion">): string | null {
  const words = agentWords(study.researchQuestion);
  return words.length
    ? `The research question mentions ${words.map((w) => `"${w}"`).join(", ")}. Every agent gets the research question, so it should ask only about the human study: move questions about the agents, methods or configurations to "Questions about the agents" (agentQuestions in study.json), which agents never see.`
    : null;
}

// ---------- recordings that stand in for measures ----------
const TIME_FIELD = /(duration|time|elapsed|seconds|(^|_)(s|sec|ms|min)$)/i;
const COUNT_FIELD = /(count|(^|_)n(_|$)|num_|number|teleport|error|click|selection|attempt|tries|trial|hits?$|miss)/i;
const TIME_OUTCOME = /(second|\bs\b|\bms\b|minute|\btime|duration)/i;
const COUNT_OUTCOME = /(count|number of|per (main |scored )?(task|trial)|errors?\b|teleports?\b|selections?\b|clicks?\b|attempts?\b)/i;
/** "time", "count" or null: what kind of measure an outcome is (objective measures only). */
function outcomeKind(o: Study["outcomes"][number]): "time" | "count" | null {
  if (o.domain !== "objective" || o.scale === "proportion" || o.scale === "rank") return null;
  const text = `${o.id.replace(/-/g, " ")} ${o.label} ${o.unit}`;
  return TIME_OUTCOME.test(text) ? "time" : COUNT_OUTCOME.test(text) ? "count" : null;
}
const fieldKind = (f: string): "time" | "count" | null => (TIME_FIELD.test(f) ? "time" : COUNT_FIELD.test(f) ? "count" : null);
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * Movement recordings that hand an agent a stand-in for a measure it predicts: a source with
 * duration-, time- or count-like fields whose rows cover a phase in which a time or count measure is
 * scored, given to a configuration that predicts that measure. One warning per source and measure
 * kind, naming the fields, phases, measures and configurations.
 */
export function standInWarnings(study: Study, agents: AgentProtocol[], sourceId?: string): string[] {
  const out: string[] = [];
  for (const src of study.sources.filter((s) => s.kind === "trajectory" && (!sourceId || s.id === sourceId))) {
    const delivered = src.phases ?? study.phases.map((p) => p.id);
    const users = agents.filter((a) => a.sourceIds.includes(src.id));
    for (const kind of ["time", "count"] as const) {
      const fields = (src.fields ?? []).filter((f) => fieldKind(f) === kind);
      if (!fields.length) continue;
      const measures = study.outcomes.filter((o) => outcomeKind(o) === kind && o.phaseIds.some((p) => delivered.includes(p)));
      const predicting = users.filter((a) => measures.some((o) => agentTargets(study, a).includes(o.id)));
      if (!predicting.length) continue;
      const predicted = measures.filter((o) => predicting.some((a) => agentTargets(study, a).includes(o.id)));
      const phases = [...new Set(predicted.flatMap((o) => o.phaseIds.filter((p) => delivered.includes(p))))].map((p) => study.phases.find((x) => x.id === p)?.label ?? p);
      out.push(
        `${src.label} gives ${listText(fields)} for the ${listText(phases)} phase${phases.length === 1 ? "" : "s"}, where ${listText(predicted.map((o) => `${o.label} (${o.unit})`))} ${predicted.length === 1 ? "is" : "are"} measured, and ${listText(predicting.map((a) => a.label))} ${predicting.length === 1 ? "predicts" : "predict"} ${predicted.length === 1 ? "it" : "them"}: the recorded ${kind === "time" ? "durations" : "counts"} can stand in for the measured outcome. Limit the source to other phases ("phases": ["practice"] on the source in study.json), leave out ${fields.length === 1 ? "that field" : "those fields"}, or give the measure as an input instead of a target.`,
      );
    }
  }
  return out;
}

// ---------- model and effort across compared configurations ----------
type ModelOf = (a: AgentProtocol) => AgentProtocol["model"];
/** What a configuration gets and how it predicts, apart from its model: sources, tools, inputs, level and targets. */
function setupKey(study: Study, a: AgentProtocol): string {
  const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort().join(",");
  return [sorted(a.sourceIds), sorted(a.tools), sorted(a.inputs), agentLevel(study, a), sorted(agentTargets(study, a))].join("|");
}
/**
 * Compared configurations that differ in what they get and also in model or effort: a difference
 * between them mixes the method with the model. Compared = the saved comparisons (comparisons.json),
 * or, without any, every configuration (Compare agents lists them side by side). Configurations that
 * differ only in model are model arms, a comparison of models, and are not named.
 */
export function modelConfoundWarnings(study: Study, agents: AgentProtocol[], comparisons?: Comparison[] | null, modelOf: ModelOf = (a) => a.model): string[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const confounded = (a: AgentProtocol, b: AgentProtocol) => setupKey(study, a) !== setupKey(study, b) && modelDifferences(modelOf(a), modelOf(b)).length > 0;
  const saved = (comparisons ?? []).filter((c) => byId.has(c.candidate) && byId.has(c.baseline));
  if (saved.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of saved) {
      const [x, y] = [byId.get(c.candidate)!, byId.get(c.baseline)!];
      const key = [x.id, y.id].sort().join("|");
      if (seen.has(key) || !confounded(x, y)) continue;
      seen.add(key);
      out.push(
        `${x.label} and ${y.label} are compared, but they differ in what they get and also in ${listText(modelDifferences(modelOf(x), modelOf(y)))} (${describeModel(modelOf(x))} vs ${describeModel(modelOf(y))}): a difference between them mixes the method with the model. Give both the same model and effort; compare models with model arms (the same configuration on another model).`,
      );
    }
    return out;
  }
  const pairs = agents.flatMap((a, i) => agents.slice(i + 1).filter((b) => confounded(a, b)));
  if (!pairs.length) return [];
  const groups = new Map<string, string[]>();
  for (const a of agents) groups.set(describeModel(modelOf(a)), [...(groups.get(describeModel(modelOf(a))) ?? []), a.label]);
  return [
    `Configurations that are compared side by side use different models or effort (${[...groups].map(([m, labels]) => `${listText(labels)}: ${m}`).join("; ")}). Where two of them also differ in what they get, a difference between them mixes the method with the model. Use one model and effort for every configuration of a method comparison, and compare models with model arms (the same configuration on another model).`,
  ];
}

/** Every fairness warning of a study and its configurations (study-check, the Freeze page). */
export function fairnessWarnings(study: Study, agents: AgentProtocol[] | null | undefined, comparisons?: Comparison[] | null): string[] {
  return [
    researchQuestionWarning(study),
    ...(agents ? standInWarnings(study, agents) : []),
    ...(agents ? modelConfoundWarnings(study, agents, comparisons) : []),
  ].filter((x): x is string => !!x);
}

// ---------- knowledge that states predictions ----------
const COMPARATIVE = /\b(more|less|fewer|higher|lower|shorter|longer|faster|slower|quicker|better|worse|greater|smaller|larger|increas\w*|decreas\w*|reduc\w*|improv\w*|outperform\w*|exceed\w*|slow|speed (?:up|s up))\b/i;
const PREDICTS = /\b(expect\w*|predict\w*|likely|anticipat\w*|hypothes\w*|probabl\w*|will|should|tend\w* to)\b|\d+(?:\.\d+)?\s?%|\bpercent\b/i;
const GENERIC_MEASURES = /\b(times?|durations?|seconds|errors?|accuracy|ratings?|scores?|workload|presence|preferen\w+|rank(?:s|ed|ing|ings)?|sickness)\b/i;
const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Sentences of a knowledge text that state a prediction about a measured outcome: a measure (its
 * ID, label or a generic measure word such as times, errors or ratings), a comparative word, and a
 * design or a prediction (expect, likely, will, a percentage). A heuristic for the researcher to
 * confirm the text was written without the results; at most 10, each at most 240 characters.
 */
export function predictionSentences(study: Pick<Study, "outcomes" | "conditions">, text: string): string[] {
  const words = (xs: string[]) => xs.filter((x) => x.trim().length >= 2).map((x) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(x.trim())}($|[^\\p{L}\\p{N}])`, "iu"));
  const measures = words(study.outcomes.flatMap((o) => [o.id, o.id.replace(/-/g, " "), o.label.replace(/\s*\(.*\)\s*$/, "")]));
  const designs = words(study.conditions.flatMap((c) => [c.id, c.label.replace(/\s*\(.*\)\s*$/, "")]));
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\n+|(?<=[.!?])\s+/)) {
    const s = raw.replace(/^[\s>*#|-]+/, "").trim();
    if (s.length < 12) continue;
    const measure = GENERIC_MEASURES.test(s) || measures.some((r) => r.test(s));
    if (!measure || !COMPARATIVE.test(s)) continue;
    if (!PREDICTS.test(s) && !designs.some((r) => r.test(s))) continue;
    out.push(s.length > 240 ? `${s.slice(0, 237)}…` : s);
    if (out.length >= 10) break;
  }
  return out;
}
