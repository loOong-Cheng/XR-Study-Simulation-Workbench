import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  campaignSummary,
  campaignFiles,
  campaignStatus,
  freezeCampaign,
  rerunCampaign,
  verifyCampaign,
  validateSuite,
  type CampaignReceipt,
} from "../src/core/campaign.js";
import { syntheticCampaignSuite } from "../src/core/campaign-presets.js";
import {
  compareCampaignScores,
  type CampaignScorecard,
} from "../src/core/campaign-comparison.js";
import {
  assertNoSubjectiveInput,
  preflightSuite,
  type AssetBindings,
} from "../src/campaign-io.js";
import { hash } from "../src/core/planner.js";
const model = {
  provider: "test-transport",
  model: "model-before",
  reasoning: "high-adaptive",
};
const campaign = () => freezeCampaign(syntheticCampaignSuite(), model);
function receipt(
  c: ReturnType<typeof campaign>,
  condition = "A",
  rep = 1,
): CampaignReceipt {
  const job = c.jobs.find(
    (j) => j.conditionId === condition && j.repetition === rep,
  )!;
  return {
    campaignDigest: c.digest,
    jobId: job.id,
    attempt: 1,
    status: "completed",
    actualModel: c.model,
    sessionId: job.sessionKey,
    freshSession: true,
    freshPIE: true,
    freshScreenshots: true,
    assetHashes: Object.fromEntries(
      c.suite.assets.map((a) => [a.id, a.sha256]),
    ),
    output: {
      path: `results/${job.templateJobId}.json`,
      sha256: "a".repeat(64),
    },
    executionManifest: {
      path: "execution-manifest.json",
      sha256: "b".repeat(64),
    },
    usage: { inputTokens: null, outputTokens: null },
  };
}
test("complete suite enumerates 19 conditions and preserves every historical repetition schedule", () => {
  const c = campaign(),
    s = campaignSummary(c);
  assert.equal(s.llmSessions, 308);
  assert.equal(s.rulesChecks, 2);
  assert.equal(s.derivedProfiles, 40);
  assert.equal(s.conditions.length, 19);
  for (const id of [
    "A",
    "B",
    "C",
    "D",
    "F",
    "A-Dem",
    "B-Dem",
    "C-Dem",
    "D-Dem",
    "F-Dem",
  ])
    assert.equal(s.conditions.find((x) => x.id === id)?.jobs, 10);
  for (const id of ["U1", "UD", "UDO", "UDOT"])
    assert.equal(s.conditions.find((x) => x.id === id)?.jobs, 40);
  for (const id of ["UDOT-full", "UDOT-full-reason"])
    assert.equal(s.conditions.find((x) => x.id === id)?.jobs, 24);
});
test("model rerun preserves protocol bytes, changes all job identities and links its parent", () => {
  const old = campaign(),
    next = rerunCampaign(old, { ...model, model: "model-after" });
  assert.equal(next.parentDigest, old.digest);
  assert.equal(next.protocolDigest, old.protocolDigest);
  assert.deepEqual(next.suite, old.suite);
  assert.notEqual(next.digest, old.digest);
  assert.ok(
    next.jobs.every(
      (j) =>
        !old.jobs.some((o) => o.id === j.id || o.sessionKey === j.sessionKey),
    ),
  );
  const p = next.jobs.find((j) => j.conditionId === "U0")!;
  assert.ok(
    next.jobs.some((j) => j.id === p.sourceJobId && j.conditionId === "D"),
  );
  assert.equal(JSON.stringify(old.model), JSON.stringify(model));
});
test("full and full-reason preserve unlimited exploration and distinct investigation workflow", () => {
  const c = campaign(),
    get = (id: string) => c.suite.conditions.find((x) => x.id === id)!.recipe;
  assert.equal(get("F").pie, false);
  assert.equal(get("C").evidence, false);
  assert.equal(get("D").evidence, true);
  assert.deepEqual(get("U1").personalInformation, [
    "individual-design-order",
    "planned-trial-context",
  ]);
  assert.ok(get("UD").personalInformation.includes("demographics"));
  assert.ok(!get("UD").personalInformation.includes("measured-objective-data"));
  assert.ok(get("UDOT-full").personalInformation.includes("practice-feedback"));
  assert.equal(get("UDOT-full").limits.jobWallSeconds, null);
  assert.equal(get("UDOT-full-reason").limits.maxScreenshots, null);
  assert.equal(get("UDOT-full-reason").limits.challengeRounds, 1);
  assert.equal(get("UDOT-full-reason").limits.investigationRounds, 8);
});
test("tampered schedules and invalid derived-source links are rejected", () => {
  const c = campaign();
  c.jobs.pop();
  assert.throws(() => verifyCampaign(c), /integrity/);
  const suite = syntheticCampaignSuite();
  suite.conditions.find((c) => c.id === "U0")!.jobs[0].sourceJobId = "A-r1";
  assert.throws(() => validateSuite(suite), /matching model run/);
});
test("campaign export includes full queue and checksums without prediction bytes or API credentials", () => {
  const c = campaign(),
    files = campaignFiles(c);
  assert.equal(files["queue.jsonl"].trim().split("\n").length, 350);
  const manifest = JSON.parse(files["manifest.json"]);
  for (const [name, digest] of Object.entries(manifest.files))
    assert.equal(
      createHash("sha256").update(files[name]).digest("hex"),
      digest,
    );
  assert.ok(files["recipes/UDOT-full-reason.json"].includes("challenge"));
  assert.ok(
    !Object.keys(files).some(
      (f) => f.includes("predictions") || f.includes("human.json"),
    ),
  );
});
test("receipts from another model campaign cannot satisfy the new queue", () => {
  const c = campaign(),
    next = rerunCampaign(c, { ...model, model: "next" });
  assert.throws(() => campaignStatus(next, [receipt(c)]), /another campaign/);
  const wrong = receipt(next);
  wrong.actualModel = model;
  assert.equal(
    campaignStatus(next, [wrong]).jobs.find((j) => j.jobId === wrong.jobId)!
      .state,
    "audit-required",
  );
});
test("failed attempts remain visible and first completion cannot be replaced by favorable later outputs", () => {
  const c = campaign(),
    r = receipt(c);
  const failed = { ...r, status: "failed" as const, output: null };
  const completed = { ...r, attempt: 2, sessionId: r.sessionId + "-2" };
  const status = campaignStatus(c, [completed, failed]);
  assert.equal(
    status.jobs.find((j) => j.jobId === r.jobId)!.selectedAttempt,
    2,
  );
  const malformedFirst = { ...r, output: null };
  const held = campaignStatus(c, [malformedFirst, completed]);
  assert.equal(
    held.jobs.find((j) => j.jobId === r.jobId)!.state,
    "audit-required",
  );
  assert.ok(!held.runnable.includes(r.jobId));
  assert.throws(() => campaignStatus(c, [r, r]), /Duplicate/);
});
test("PIE receipts require fresh captures and repeated session identities trigger audit", () => {
  const c = campaign(),
    r = receipt(c, "C");
  r.freshScreenshots = false;
  assert.equal(
    campaignStatus(c, [r]).jobs.find((j) => j.jobId === r.jobId)!.state,
    "audit-required",
  );
  const a = receipt(c, "A"),
    b = receipt(c, "B");
  b.sessionId = a.sessionId;
  const status = campaignStatus(c, [a, b]);
  assert.equal(
    status.jobs.find((j) => j.jobId === a.jobId)!.state,
    "audit-required",
  );
  assert.equal(
    status.jobs.find((j) => j.jobId === b.jobId)!.state,
    "audit-required",
  );
});
test("U0 waits for the matching new-model D repetition and never requires fresh individual calls", () => {
  const c = campaign();
  assert.equal(
    campaignStatus(c, []).jobs.filter((j) => j.state === "waiting-for-source")
      .length,
    40,
  );
  const status = campaignStatus(c, [receipt(c, "D", 1)]);
  assert.equal(
    status.jobs.filter((j) => j.state === "derived-ready").length,
    24,
  );
  assert.equal(
    status.jobs.filter((j) => j.state === "waiting-for-source").length,
    16,
  );
});
test("subjective participant inputs remain forbidden even inside nested full-trajectory packets", () => {
  assert.doesNotThrow(() =>
    assertNoSubjectiveInput({
      context: { design_order: ["SP", "PP"] },
      practice_experience: [{ correct: 1 }],
    }),
  );
  assert.throws(
    () => assertNoSubjectiveInput({ practice: { pre_session_ssq: 0 } }),
    /forbidden/,
  );
  assert.throws(
    () => assertNoSubjectiveInput({ trials: [{ confidence: 5 }] }),
    /forbidden/,
  );
});
test("preflight verifies input bytes, rejects changed or escaping files and discloses external dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xr-campaign-test-"));
  try {
    const suite = syntheticCampaignSuite();
    await writeFile(join(dir, "protocol.txt"), "synthetic");
    suite.assets[0].sha256 = createHash("sha256")
      .update("synthetic")
      .digest("hex");
    const bindings: AssetBindings = {
      roots: { data: dir },
      files: { "synthetic-protocol": { root: "data", path: "protocol.txt" } },
      attestations: {},
    };
    assert.equal((await preflightSuite(suite, bindings)).ready, true);
    await writeFile(join(dir, "protocol.txt"), "changed");
    assert.equal((await preflightSuite(suite, bindings)).ready, false);
    // "junction" is used only on Windows, where directory symlinks need admin or Developer Mode.
    await symlink(join(dir, ".."), join(dir, "escape"), "junction");
    bindings.files["synthetic-protocol"].path = "escape";
    assert.equal((await preflightSuite(suite, bindings)).ready, false);
    suite.assets[0].verification = "worker-attestation";
    assert.equal((await preflightSuite(suite, bindings)).blocked.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
test("cross-model score comparison enforces human reference, coverage and scoring contract", () => {
  const old = campaign(),
    next = rerunCampaign(old, { ...model, model: "next" });
  const card = (c: typeof old): CampaignScorecard => ({
    schemaVersion: "xr-campaign-scores/1",
    campaignDigest: c.digest,
    scoringDigest: hash(c.suite.scoring),
    humanReferenceDigest: "a".repeat(64),
    coverageDigest: "b".repeat(64),
    rows: [
      {
        conditionId: "A",
        domain: "objective",
        agreement: 0.7,
        nHumans: 24,
        nRuns: 10,
      },
    ],
  });
  const after = card(next);
  after.rows[0].agreement = 0.75;
  const result = compareCampaignScores(old, card(old), next, after);
  assert.ok(Math.abs(result.rows[0].changePercentagePoints! - 5) < 1e-9);
  assert.equal(result.rows.find((r) => r.conditionId === "UD")!.after, null);
  after.coverageDigest = "c".repeat(64);
  assert.throws(
    () => compareCampaignScores(old, card(old), next, after),
    /coverage differs/,
  );
});
