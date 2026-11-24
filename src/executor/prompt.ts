// The text a forecasting session gets: the system prompt and the prompt. Built from the frozen
// study and configuration plus what the executor read for this job, so configurations that are
// compared differ only in what they get (docs/methodology.md, "Prompts and fairness"):
// - the study is named neutrally (agentTitle), and only the human study's question is given
//   (never agentQuestions, the study's own title or the purpose of a run);
// - designs are listed (and played) in the session's design order (designOrder);
// - every configuration that can read files gets the same one line about them;
// - the level of the forecast (one person, or the mean of all) is said once at the top and once
//   at the end, in the same words for every configuration of that level.
import { agentLevel, agentTargets, agentTitle } from "../core/planner.js";
import { answerNeeds } from "../core/forecast-format.js";
import type { AgentProtocol, Job, Study } from "../core/types.js";

/** The one line every configuration that can read project files gets with the file list. */
export const READ_FILES_LINE = "These files show what participants saw. Inspect what you need before forecasting.";

/** A section of the prompt from a source: its title, an optional line before it, and its content (what is hashed for the audit). */
export interface PromptSection {
  sourceId: string;
  title: string;
  content: string;
  note?: string;
}
export interface PromptInput {
  study: Study;
  agent: AgentProtocol;
  job: Pick<Job, "participantId">;
  /** The designs in this session's order (fairness.ts → designOrder). */
  designs: { id: string; label: string }[];
  /** The participant (individual) or the cohort's orders and size (population), as jobPacket gives them. */
  orderContext: unknown;
  /** How to play the app (runner.ts → playInstructions) for configurations that use it, else null. */
  play: string | null;
  sections: PromptSection[];
  /** Measured outcomes given as predictors (a configuration's inputs), as text; null without inputs. */
  inputs: string | null;
}

/**
 * What the forecast is of, said before the task: one person's expected values, or the mean of all
 * participants. The brief describes the whole study (often "the participants", "18 adults"), so an
 * individual session is told plainly that it predicts one person.
 */
export function levelLine(study: Study, agent: AgentProtocol, job: Pick<Job, "participantId">, designs: number): string {
  const ranks = study.outcomes.some((o) => o.scale === "rank" && agentTargets(study, agent).includes(o.id));
  if (agentLevel(study, agent) === "individual")
    return [
      `You forecast one person: participant ${job.participantId}. The study brief describes the whole study and all its participants; predict only this person's results in each design.`,
      "Give this person's expected value for every rating, time and count (decimals allowed).",
      ...(ranks ? [`For a ranking, give this person's expected rank of each design (1 = best … ${designs}; decimals allowed as expected ranks).`] : []),
    ].join(" ");
  return [
    "You forecast the mean of all participants in each design.",
    "Give the mean over all participants for every rating, time and count.",
    ...(ranks ? [`For a ranking, give each design's mean rank (1 = best … ${designs}).`] : []),
  ].join(" ");
}

/** The system prompt and the prompt of one session. */
export function buildPrompt(x: PromptInput): { system: string; prompt: string } {
  const { study, agent: a, job } = x;
  const level = agentLevel(study, a);
  const targets = agentTargets(study, a);
  const system = [
    // Measured inputs are participants' data: the line says so instead of claiming none were seen.
    `You are an AI agent forecasting the results of a completed XR user study. You have not seen any participant's answers${x.inputs ? ", apart from the measured data given below," : ""} and must not try to obtain them.`,
    "Use only the tools provided. Your elapsed time, clicks and errors are not the participants' times or errors; predict what the participants did and reported.",
    'Finish by calling submit_forecast exactly once with one row per design × outcome listed, each as its "answer" says (the named items for measures with items, not a value), plus your uncertainty and a short reasoning. Then stop.',
    ...(x.play ? [x.play] : []),
  ].join("\n");
  const prompt = [
    levelLine(study, a, job, x.designs.length),
    `# Task\n${JSON.stringify(
      {
        study: agentTitle(study),
        researchQuestion: study.researchQuestion,
        level,
        ...(job.participantId ? { participant: x.orderContext } : { cohort: x.orderContext }),
        designs: x.designs,
        phases: study.phases,
        // "answer" says exactly what submit_forecast needs per row (the item IDs of measures with
        // items, the declared range); range is left out of the JSON when the measure declares none.
        predict: study.outcomes
          .filter((o) => targets.includes(o.id))
          .map((o) => ({ outcome: o.id, label: o.label, domain: o.domain, unit: o.unit, scale: o.scale, range: o.range, items: o.components, answer: `give ${answerNeeds(o, x.designs.length)}`, description: o.description })),
      },
      null,
      2,
    )}`,
    ...x.sections.map((s) => `# ${s.title}\n${s.note ? `${s.note}\n` : ""}${s.content}`),
    ...(x.inputs ? [`# Measured data you may use as predictors\n${x.inputs}`] : []),
    `# What to return\n${a.forecastInstruction}\n${level === "individual" ? `Predict for participant ${job.participantId} only.` : "Predict the mean of all participants."}`,
  ].join("\n\n");
  return { system, prompt };
}
