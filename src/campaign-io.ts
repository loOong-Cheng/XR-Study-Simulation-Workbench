import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  validateSuite,
  type CampaignSuite,
} from "./core/campaign.js";
import { requireThat } from "./core/validation.js";

export interface AssetBindings {
  roots: Record<string, string>;
  files: Record<string, { root: string; path: string }>;
  attestations: Record<string, { sha256: string; evidence: string }>;
}
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
export function assertNoSubjectiveInput(value: unknown): void {
  const forbidden =
    /^(pre_session_ssq|ssq|tlx|beauvis|confidence|rankings|preferences|subjective_responses)$/i;
  if (Array.isArray(value)) value.forEach(assertNoSubjectiveInput);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      requireThat(
        !forbidden.test(key),
        `Measured subjective input field is forbidden: ${key}.`,
      );
      assertNoSubjectiveInput(child);
    }
}
export async function preflightSuite(
  suite: CampaignSuite,
  bindings: AssetBindings,
) {
  validateSuite(suite);
  const checks = await Promise.all(
    suite.assets.map(async (a) => {
      try {
        if (a.verification === "worker-attestation") {
          const att = bindings.attestations[a.id];
          requireThat(
            att?.sha256 === a.sha256 && att.evidence?.trim(),
            "Needs worker verification evidence for the original asset digest.",
          );
          return { id: a.id, status: "attested", message: att.evidence };
        }
        const binding = bindings.files[a.id];
        requireThat(
          binding && bindings.roots[binding.root],
          "Missing local asset binding.",
        );
        const root = await realpath(bindings.roots[binding.root]);
        const path = await realpath(resolve(root, binding.path));
        requireThat(
          path.startsWith(root + sep),
          "Asset escapes its configured root.",
        );
        requireThat(
          sha(await readFile(path)) === a.sha256,
          "File hash differs from the frozen suite.",
        );
        return {
          id: a.id,
          status: "verified",
          message: "File SHA-256 matches.",
        };
      } catch (e) {
        return { id: a.id, status: "blocked", message: (e as Error).message };
      }
    }),
  );
  return {
    ready: checks.every((c) => c.status !== "blocked"),
    verifiedFiles: checks.filter((c) => c.status === "verified").length,
    attestedAssets: checks.filter((c) => c.status === "attested").length,
    blocked: checks.filter((c) => c.status === "blocked"),
    checks,
    scope:
      "Asset integrity only. Runtime capabilities, provider availability, v3 compatibility and scoring adapter readiness still need external-worker checks.",
  };
}
