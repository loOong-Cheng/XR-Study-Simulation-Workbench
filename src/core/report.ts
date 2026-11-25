import type { AnalysisReport } from "./types.js";
export const escapeHTML = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const percent = (n: number | null) =>
  n === null ? "Unavailable" : (n * 100).toFixed(1) + "%";
export function reportCSV(report: AnalysisReport): string {
  const rows: unknown[][] = [
    [
      "synthetic",
      "prediction_level",
      "agent",
      "domain",
      "agreement_percent",
      "ci95_low_percent",
      "ci95_high_percent",
      "assigned_primary",
      "returned_primary",
      "scoreable_primary",
      "compliant_primary",
    ],
  ];
  for (const r of report.summaries)
    rows.push([
      report.synthetic,
      report.predictionLevel,
      r.agentId,
      r.domain,
      r.agreement === null ? "" : r.agreement * 100,
      r.ci95 ? r.ci95.low * 100 : "",
      r.ci95 ? r.ci95.high * 100 : "",
      r.assigned,
      r.returned,
      r.scoreable,
      r.compliant,
    ]);
  // Keep imported labels from becoming spreadsheet formulas.
  const cell = (x: unknown) =>
    '"' +
    (typeof x === "string"
      ? x.replace(/^[=+\-@\t\r]/, "'$&")
      : String(x)
    ).replace(/"/g, '""') +
    '"';
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
export function reportHTML(r: AnalysisReport): string {
  const table = (headers: string[], rows: unknown[][]) =>
    '<div class="scroll"><table><thead><tr>' +
    headers.map((h) => "<th>" + escapeHTML(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row.map((c) => "<td>" + escapeHTML(c) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>";
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XR Study Sim report</title><style>body{font:16px/1.6 system-ui;color:#203135;background:#f7f8f5;max-width:1100px;margin:40px auto;padding:0 24px}h1{line-height:1.2}table{border-collapse:collapse;min-width:700px;width:100%;background:white}th,td{padding:10px 13px;border-bottom:1px solid #dde4e1;text-align:left}th{background:#e6eeeb}.scroll{overflow:auto;margin:18px 0 32px}.notice{background:#fff0c9;padding:14px 18px;border-left:4px solid #aa7c20}.hash{overflow-wrap:anywhere;color:#60716c;font-size:13px}li{margin-bottom:8px}@media print{body{margin:0;background:white}table{min-width:0;font-size:11px}.scroll{overflow:visible}}</style><body><p>XR STUDY SIM · HCI RESEARCH REPORT</p><h1>' +
    escapeHTML(r.title) +
    "</h1>" +
    (r.synthetic
      ? '<p class="notice"><strong>Synthetic demonstration.</strong> These scores are not findings about real users or XR runtimes.</p>'
      : "") +
    "<p>" +
    escapeHTML(r.predictionLevel) +
    " predictions · " +
    r.bootstrapDraws +
    " participant-cluster bootstrap draws · seed " +
    r.seed +
    '</p><p class="hash">Frozen plan: ' +
    escapeHTML(r.planDigest) +
    "</p><h2>Objective and subjective agreement</h2>" +
    table(
      [
        "Agent",
        "Domain",
        "Agreement",
        "95% interval",
        "Assigned / scoreable / compliant",
        "Adherence-only sensitivity",
      ],
      r.summaries.map((x) => [
        x.agentId,
        x.domain,
        percent(x.agreement),
        x.ci95
          ? percent(x.ci95.low) + " – " + percent(x.ci95.high)
          : "Unavailable",
        `${x.assigned} / ${x.scoreable} / ${x.compliant}`,
        percent(x.completeAdherenceSensitivity),
      ]),
    ) +
    "<h2>Comparisons between agent methods</h2>" +
    table(
      [
        "Comparison",
        "Declared",
        "Domain",
        "Change (points)",
        "95% interval (points)",
        "Holm p",
      ],
      r.contrasts.map((x) => [
        `${x.candidate} − ${x.baseline}`,
        x.declared ?? "in plan",
        x.domain,
        x.difference === null ? "Unavailable" : (x.difference * 100).toFixed(2),
        x.ci95
          ? `${(x.ci95.low * 100).toFixed(2)} to ${(x.ci95.high * 100).toFixed(
              2,
            )}`
          : "Unavailable",
        x.holmP === null ? x.status : x.holmP.toFixed(4),
      ]),
    ) +
    "<h2>Every outcome</h2>" +
    table(
      [
        "Agent",
        "Outcome",
        "Domain",
        "Directional agreement",
        "Native-unit MAE",
        "Informative people",
      ],
      r.metrics.map((x) => [
        x.agentId,
        x.outcomeId,
        x.domain,
        percent(x.agreement),
        x.absoluteMAE === null
          ? "Not requested / unavailable"
          : x.absoluteMAE.toFixed(3),
        x.informativeUnits,
      ]),
    ) +
    "<h2>Execution deviations</h2>" +
    table(
      ["Job", "Scoreable", "Compliant", "Recorded issues"],
      r.audits.map((a) => [
        a.jobId,
        a.scoreable,
        a.compliant,
        a.issues.join(" ") || "No recorded deviation",
      ]),
    ) +
    "<h2>Coverage and interpretation</h2><ul>" +
    [...r.exclusions, ...r.notes]
      .map((n) => "<li>" + escapeHTML(n) + "</li>")
      .join("") +
    "</ul></body></html>"
  );
}
