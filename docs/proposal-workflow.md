# Planning from an existing research document

The document-first workflow accepts an existing proposal or methods section. The internal `Study` contract remains the reproducible interchange representation; researchers do not need to write it to start planning.

1. Upload `.pdf`, `.docx`, `.md`, `.markdown` or UTF-8 `.txt`, or paste text. Extraction runs on the local server, without a provider call. Inspect the extracted text, particularly PDF tables and reading order.
2. Choose **Read proposal with agent** to send the displayed text to the configured reader. Its provider, model and endpoint are shown before the action. Alternatively choose **Use local text helper** for offline, labelled-text extraction.
3. Review suggested facts and exact source excerpts. Unknown facts remain empty. An excerpt can support review, but substring validation cannot establish semantic correctness.
4. Complete the ordinary review form: condition names, task, human sample size, actual order per participant, separate outcome definitions and execution setting. Choose scale, unit, family, aggregation and measurement window for each outcome. Keep each preference question separate.
5. Review the displayed defaults and confirm. The optional cyclic schedule is explicitly proposed, never inferred from a document or assumed to be a fully counterbalanced design. Each order line maps to P01, P02, and so on; map those identifiers to your own anonymized records before analysis.
6. Create the draft. Inspect generated agent protocols, refine cases and registered contrasts, then freeze. Optional JSON remains available for advanced scientific details and study-adapter integration.

The first review form intentionally covers a compact study scaffold. It does not automatically reproduce a full factorial trial schedule, questionnaire scoring manual, retained-item composite, randomization procedure or source-permission policy from prose. Generic `complete-task` actions must be replaced or mapped to meaningful adapter actions before real execution. Researchers should review those details rather than assume successful parsing implies a complete protocol.

## Configuration

Set these in the process environment before starting the local server:

| Variable              | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `XR_PLANNER_PROVIDER` | `openai-compatible` or `anthropic`                                               |
| `XR_PLANNER_MODEL`    | Exact reader model identifier                                                    |
| `XR_PLANNER_API_KEY`  | Server-only credential; optional for an HTTP loopback model                      |
| `XR_PLANNER_BASE_URL` | Optional base URL including `/v1`; default official OpenAI or Anthropic endpoint |

Remote endpoints require HTTPS. Redirects are rejected. OpenAI-compatible readers must accept Chat Completions with `messages`, `response_format: {type: "json_object"}` and `max_completion_tokens`; Anthropic readers use Messages with a system instruction and `max_tokens`. Provider-specific compatibility is not guaranteed. Unsupported models, provider failures and invalid source quotes return errors; there is no silent fallback to the local helper. Request timeout is 90 seconds, output budget 6,000 tokens. Provider-reported token usage is retained in the downloadable reading record.

The application sends no forecasting jobs from this server. Proposal interpretation and forecasting use independent model configurations. Do not paste credentials into any research field. The server does not load `.env` files automatically; use your shell or process manager to set environment variables.

## Provenance and data boundaries

The optional planning record contains the uploaded file's SHA-256 (if unchanged), extracted text, text SHA-256, source excerpts, reader identity/usage and reviewed fields. Editing extracted text creates a new text identity; reread it before creating a study. The record can contain private proposal text: archive it with the research materials rather than sharing it as an agent input. It is separate from the frozen execution package, so its existence is not evidence of prospective registration.

The proposal is treated as source text, never executed as instructions or commands. Extracted text and quotes are rendered as escaped text. The reader has no shell, XR or file-access tools. Human reference measurements are supplied separately at analysis time. If the proposal contains preliminary results or subjective answers, omit them from the task brief and permitted forecasting sources. Source-quote checks do not detect every form of target leakage; researchers must review what is retained.

## Current extraction limits

Files up to 8 MB; extracted text up to 100,000 characters; PDFs up to 100 pages. Exceeding a limit returns an error without silent truncation. PDF extraction is text-only and does not OCR scanned pages or interpret figures. Legacy `.doc`, encrypted documents and arbitrary archive formats are unsupported. DOCX extraction uses raw text, with external file access disabled by the library. Extraction is intended for your local research documents; this prototype is not a hardened public upload service.

The local helper recognizes fields such as `Research question:`, `Conditions:` and `Subjective outcomes:`; it also recognizes basic within/between-subjects and participant-count phrases. Unlabelled prose needs the configured LLM reader or manual review. Neither reader infers human outcome values.

## Tooltips

Question-mark buttons explain fields, cards, permissions and analysis metrics in HCI terms. They support pointer hover, keyboard focus and tap. Escape, moving focus elsewhere or clicking outside dismisses the explanation. Labels remain associated with their inputs; help buttons do not activate or modify the fields. Tooltips explain interpretation rather than introducing scientific defaults.

## Implementation references

The provider and extraction adapters follow the official [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Anthropic Messages reference](https://platform.claude.com/docs/en/api/messages), [Mammoth raw-text API](https://github.com/mwilliamson/mammoth.js#mammothextractrawtextinput) and [PDF.js Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs). All included examples and document fixtures are synthetic. Provider requests are validated with mocks; no live provider call or XR runtime was used to verify this release.
