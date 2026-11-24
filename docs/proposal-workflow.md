# Planning from an existing research document

The workbench drafts a study from an existing protocol, methods section or manuscript. `study.json` remains the reproducible description; researchers do not need to write it by hand to start planning.

## In the website: Understand study

1. Open the study, go to **Study & variables** and press **Choose document** (`.pdf`, `.docx`, `.md`, `.markdown` or UTF-8 `.txt`). If you have it, also press **Choose participants file**: a CSV with the columns `participant,order` (each person's ID and the order in which they experienced the designs; no answers).
2. Press **Understand study**. The local server extracts the text without any provider call and sends it to the assistant set in **Settings → Assistant for workbench buttons**: headless Claude Code or Codex, without tools, in an empty folder. The `api` choice cannot answer this button. The card names the assistant and its model before you press.
3. The assistant drafts the facts with exact quotes, the designs, phases, measures (domain, unit, scale, aggregation, family) and participant information, and lists what the document leaves open. Every quote is checked against the extracted text; a draft with a quote that is not in the document is refused. Unknown facts stay empty. A matching quote supports review; it cannot establish that the draft is semantically correct.
4. Check the draft table and the open questions, then press **Use this draft for this study** (or **Discard draft**). The page's tables are then edited and saved like any other study, and the researcher approves on **Agent configurations** (**Approve study and configurations**).

The draft does not reproduce a full factorial trial schedule, questionnaire scoring manual, retained-item composite, randomization procedure or source-permission policy from prose. Check designs, measures, participants and orders against your records before approving: successful parsing does not mean the protocol is complete.

## With a coding agent or the command line

- `node dist/cli.js proposal <document> <new-directory>` extracts the text locally into `extracted-proposal.txt` and writes a first `reading.json` from labelled lines (the local helper; no model).
- The coding agent completes `reading.json`. It has eight facts, each `{"value": "…", "quote": "…"}`: `title`, `researchQuestion`, `design`, `participantCount`, `conditions`, `task`, `objectiveOutcomes` and `subjectiveOutcomes`. A fact the document does not state keeps an empty value and quote.
- `node dist/cli.js proposal-check <document> reading.json` lists every quote that is not copied exactly from the document, and every missing fact.
- The agent then drafts `study.json` (see [AGENTS.md](../AGENTS.md), step 2).

`proposal <document> <new-directory> --agent` also sends the text to a reader model set with the environment variables below.

## Reader model for `proposal --agent`

Only the command `proposal --agent` reads these variables; the website uses the Settings assistant instead. (The local API route `/api/proposal/read` reads them too, but the website does not call it.) Set them in the shell that runs the command:

| Variable              | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `XR_PLANNER_PROVIDER` | `openai-compatible` or `anthropic`                                               |
| `XR_PLANNER_MODEL`    | Exact reader model identifier                                                    |
| `XR_PLANNER_API_KEY`  | Credential; optional for an HTTP loopback model                                  |
| `XR_PLANNER_BASE_URL` | Optional base URL including `/v1`; default official OpenAI or Anthropic endpoint |

Remote endpoints require HTTPS. Redirects are rejected. OpenAI-compatible readers must accept Chat Completions with `messages`, `response_format: {type: "json_object"}` and `max_completion_tokens`; Anthropic readers use Messages with a system instruction and `max_tokens`. Provider-specific compatibility is not guaranteed. Unsupported models, provider failures and invalid source quotes return errors; there is no silent fallback to the local helper. Request timeout is 90 seconds, output budget 6,000 tokens. Provider-reported token usage is kept in `reading.json`.

Proposal reading and forecasting use independent model configurations. Do not paste credentials into any research field. Nothing loads `.env` files automatically; use your shell or process manager to set environment variables.

## Provenance and data boundaries

`reading.json` contains the document's SHA-256, its extracted text, the source excerpts, the reader's identity and usage, and the facts. It can contain private proposal text: archive it with the research materials rather than sharing it as an agent input. It is separate from the frozen campaign, so its existence is not evidence of prospective registration. **Understand study** keeps no separate record: the accepted draft becomes the study's tables.

The document is treated as source text, never executed as instructions or commands. Extracted text and quotes are rendered as escaped text. The reader has no shell, XR or file-access tools. Human reference measurements are supplied separately at analysis time. If the document contains preliminary results or subjective answers, omit them from the task brief and permitted forecasting sources. Source-quote checks do not detect every form of target leakage; researchers must review what is retained.

## Current extraction limits

Files up to 8 MB; extracted text up to 100,000 characters; PDFs up to 100 pages. Exceeding a limit returns an error without silent truncation. PDF extraction is text-only and does not OCR scanned pages or interpret figures. Legacy `.doc`, encrypted documents and arbitrary archive formats are unsupported. DOCX extraction uses raw text, with external file access disabled by the library. Extraction is intended for your local research documents; this prototype is not a hardened public upload service.

The local helper recognizes fields such as `Research question:`, `Conditions:` and `Subjective outcomes:`; it also recognizes basic within/between-subjects and participant-count phrases. Unlabelled prose needs a model reader, the Settings assistant or manual review. No reader infers human outcome values.

## Implementation references

The provider and extraction adapters follow the official [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Anthropic Messages reference](https://platform.claude.com/docs/en/api/messages), [Mammoth raw-text API](https://github.com/mwilliamson/mammoth.js#mammothextractrawtextinput) and [PDF.js Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs). All included examples and document fixtures are synthetic. Provider requests are validated with mocks; no live provider call or XR runtime was used to verify this release.
