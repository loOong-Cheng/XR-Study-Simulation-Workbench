// Review state for an agent-drafted study: which files are under review and
// whether the researcher approved exactly their current contents.
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./core/planner.js";
import { validateAgents, validateStudy } from "./core/validation.js";
import type { AgentProtocol, Study } from "./core/types.js";
import { readJsonFile } from "./files.js";

export interface Approval {
  schemaVersion: "xr-study-approval/1";
  studyDigest: string;
  agentsDigest: string | null;
  approvedAt: string;
  note: string;
}
export const approvalPath = (studyPath: string) =>
  resolve(studyPath).replace(/\.json$/i, "") + ".approval.json";

export async function readReviewFiles(studyPath: string, agentsPath?: string) {
  const study = validateStudy(await readJsonFile(studyPath));
  const agents = agentsPath && existsSync(agentsPath)
    ? validateAgents(study, await readJsonFile<AgentProtocol[]>(agentsPath))
    : undefined;
  return { study, agents };
}
export async function approvalState(studyPath: string, study: Study, agents?: AgentProtocol[]) {
  const path = approvalPath(studyPath);
  if (!existsSync(path)) return { approved: false, current: false, approval: null as Approval | null };
  const approval = await readJsonFile<Approval>(path);
  const current =
    approval.studyDigest === hash(study) &&
    approval.agentsDigest === (agents ? hash(agents) : null);
  return { approved: true, current, approval };
}
export async function approve(studyPath: string, study: Study, agents: AgentProtocol[] | undefined, note = "") {
  const approval: Approval = {
    schemaVersion: "xr-study-approval/1",
    studyDigest: hash(study),
    agentsDigest: agents ? hash(agents) : null,
    approvedAt: new Date().toISOString(),
    note,
  };
  await writeFile(approvalPath(studyPath), JSON.stringify(approval, null, 2) + "\n");
  return approval;
}
