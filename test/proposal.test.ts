import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  extractProposal,
  textDocument,
  localReading,
  agentReading,
  compileProposal,
  readerConfig,
  type ProposalReview,
} from "../src/core/proposal.js";
import {
  proposeAgents,
  freezePlan,
  handoffFiles,
} from "../src/core/planner.js";

const source =
  "# XR selection\nResearch question: Which selection method works better?\nParticipants: 4\nDesign: within-subjects\nConditions: Ray; Touch\nTask: Place a target.\nObjective outcomes: Time\nSubjective outcomes: Workload; Interaction preference";
function review(): ProposalReview {
  return {
    title: "XR selection",
    researchQuestion: "Which selection method works better?",
    design: "within-subjects",
    predictionLevel: "population",
    predictionTiming: "before-experience",
    participantCount: 4,
    conditions: ["Ray", "Touch"],
    task: "Place a target.",
    practice: true,
    orders: "1,2\n2,1\n1,2\n2,1",
    confirmed: true,
    runtime: {
      engine: "unity",
      backend: "editor",
      observation: "mono",
      deviceProfile: "Target HMD",
      requiredCapabilities: [],
    },
    outcomes: [
      {
        label: "Time",
        domain: "objective",
        unit: "seconds",
        family: "performance",
        scale: "continuous",
        aggregation: "geometric",
        phase: "main",
      },
      {
        label: "Workload",
        domain: "subjective",
        unit: "1–7",
        family: "workload",
        scale: "ordinal",
        aggregation: "arithmetic",
        phase: "questionnaire",
      },
    ],
  };
}
test("local reader keeps explicit facts, quotes and unresolved fields separate", () => {
  const reading = localReading(textDocument("proposal.md", source));
  assert.equal(reading.reader.mode, "local");
  assert.equal(reading.facts.participantCount.value, "4");
  assert.equal(reading.facts.conditions.value, "Ray; Touch");
  assert.equal(
    reading.document.sha256,
    createHash("sha256").update(source).digest("hex"),
  );
  const sparse = localReading(
    textDocument("sparse.txt", "A study about pointing."),
  );
  assert.equal(sparse.facts.participantCount.value, "");
  assert.equal(sparse.facts.conditions.value, "");
  assert.ok(sparse.missing.includes("participantCount"));
});
test("TXT, Markdown, DOCX and text PDF extract locally with original file hashes", async () => {
  for (const extension of ["txt", "md", "docx", "pdf"]) {
    const data = ["txt", "md"].includes(extension)
      ? Buffer.from(source)
      : await readFile(`test/fixtures/proposal.${extension}`);
    const doc = await extractProposal(`proposal.${extension}`, data);
    assert.ok(doc.text.includes("Participants:"));
    assert.equal(doc.sha256, createHash("sha256").update(data).digest("hex"));
    if (extension === "pdf") assert.ok(doc.warnings.length);
  }
});
test("document reader rejects unsupported, empty, malformed and oversized inputs", async () => {
  await assert.rejects(
    extractProposal("proposal.doc", Buffer.from(source)),
    /Use PDF/,
  );
  await assert.rejects(
    extractProposal("proposal.txt", Buffer.alloc(0)),
    /No readable text/,
  );
  await assert.rejects(
    extractProposal("proposal.txt", Buffer.alloc(8 * 1024 * 1024 + 1)),
    /8 MB/,
  );
  await assert.rejects(extractProposal("proposal.docx", Buffer.from("broken")));
  assert.throws(() => textDocument("large.txt", "a".repeat(100001)), /100,000/);
});
test("review compiles a valid study and independently preserves participant sequences", async () => {
  const study = compileProposal(review());
  assert.equal(study.synthetic, false);
  assert.deepEqual(study.participants[1].conditionOrder, ["c2", "c1"]);
  assert.equal(study.outcomes[0].aggregation, "geometric");
  assert.ok(study.cases.some((c) => c.phaseId === "practice"));
  assert.deepEqual(study.analysis.familyWeights, {
    performance: 1,
    workload: 1,
  });
  const agents = await proposeAgents(study);
  assert.throws(() => freezePlan(study, agents), /placeholder model/);
  agents.forEach(
    (a) =>
      (a.model = { provider: "test", model: "snapshot", reasoning: "none" }),
  );
  const plan = freezePlan(study, agents, 1);
  const pack = JSON.stringify(handoffFiles(plan));
  assert.ok(!pack.includes("source-excerpts"));
  assert.ok(!pack.includes("raw-proposal"));
  assert.equal(plan.jobs.length, agents.length);
});
test("review cannot silently invent or replace missing human schedules or outcome definitions", () => {
  assert.throws(
    () => compileProposal({ ...review(), confirmed: false }),
    /Review the extracted/,
  );
  assert.throws(
    () => compileProposal({ ...review(), orders: "" }),
    /one condition-order line/,
  );
  assert.throws(
    () => compileProposal({ ...review(), orders: "1,1\n2,1\n1,2\n2,1" }),
    /must list known designs .* each at most once/,
  );
  assert.throws(
    () => compileProposal({ ...review(), conditions: ["Ray", "ray"] }),
    /distinct/,
  );
  const r = review();
  r.outcomes[0].unit = "";
  assert.throws(() => compileProposal(r), /unit and family/);
  assert.throws(
    () =>
      compileProposal({
        ...review(),
        design: "between-subjects",
        predictionLevel: "individual",
      }),
    /within-subjects/,
  );
});
test("between-subjects population assignment remains valid without practice", () => {
  const study = compileProposal({
    ...review(),
    design: "between-subjects",
    practice: false,
    orders: "1\n2\n1\n2",
  });
  assert.ok(study.participants.every((p) => p.conditionOrder.length === 1));
  assert.ok(!study.phases.some((p) => p.kind === "practice"));
});
test("provider configuration keeps credentials server-side and rejects remote HTTP", () => {
  assert.equal(readerConfig({}), undefined);
  assert.throws(
    () =>
      readerConfig({
        XR_PLANNER_PROVIDER: "openai-compatible",
        XR_PLANNER_MODEL: "test",
        XR_PLANNER_BASE_URL: "http://example.com",
      }),
    /HTTPS/,
  );
  assert.equal(
    readerConfig({
      XR_PLANNER_PROVIDER: "openai-compatible",
      XR_PLANNER_MODEL: "local",
      XR_PLANNER_BASE_URL: "http://127.0.0.1:8000/v1",
    })?.apiKey,
    "",
  );
});
test("OpenAI-compatible agent reader sends a bounded document request and validates source quotes", async () => {
  const document = textDocument("proposal.md", source);
  const facts = localReading(document).facts;
  const config = {
    provider: "openai-compatible" as const,
    model: "reader-test",
    baseURL: "https://example.test/v1",
    apiKey: "secret-test",
  };
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, "https://example.test/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[1].content, source);
    assert.equal(body.tools, undefined);
    assert.equal(init?.redirect, "error");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ facts }) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
    );
  };
  const reading = await agentReading(document, config, request);
  assert.equal(reading.reader.mode, "agent");
  assert.deepEqual(reading.reader.usage, {
    prompt_tokens: 200,
    completion_tokens: 100,
  });
  assert.ok(!JSON.stringify(reading).includes("secret-test"));
  const unsupported = structuredClone(facts);
  unsupported.title.quote = "Invented supporting sentence";
  await assert.rejects(
    agentReading(
      document,
      config,
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ facts: unsupported }) } },
            ],
          }),
        ),
    ),
    /Unsupported source excerpt/,
  );
  await assert.rejects(
    agentReading(
      document,
      config,
      async () => new Response("", { status: 401 }),
    ),
    /no local fallback/,
  );
});
test("Anthropic reader parses text blocks and rejects invalid model JSON", async () => {
  const document = textDocument("proposal.txt", source),
    facts = localReading(document).facts;
  const config = {
    provider: "anthropic" as const,
    model: "reader-test",
    baseURL: "https://example.test/v1",
    apiKey: "secret-test",
  };
  const reading = await agentReading(document, config, async (url, init) => {
    assert.equal(url, "https://example.test/v1/messages");
    assert.equal(
      (init?.headers as Record<string, string>)["x-api-key"],
      "secret-test",
    );
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ facts }) }],
      }),
    );
  });
  assert.equal(reading.reader.provider, "anthropic");
  await assert.rejects(
    agentReading(
      document,
      config,
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "not JSON" }] }),
        ),
    ),
  );
});
