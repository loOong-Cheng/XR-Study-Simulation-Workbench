# HCI methodological decisions

## Two questions, two interventions

Standardized exposure asks how agents predict after a defined set of experiences. Autonomous exploration asks how well a complete agent workflow chooses and uses evidence. Access to a tool, recorded exposure and effective use of its information are distinct. Do not interpret a bundled workflow comparison as the isolated contribution of stereoscopy, reasoning effort or demographics.

Required case ordering is explicit. Individual case packets follow the participant's assigned design order, with phases ordered within each design. Population packets describe the counterbalance rather than implying every design is first. Relative scoring removes common scale/offset differences but does not remove differential learning, fatigue or carryover.

The planner's defaults are design proposals, not HCI best-practice mandates. Researchers determine meaningful task coverage, predictor timing, interaction policies and measurement windows. An arbitrary minimum number of screenshots is not evidence of meaningful exploration.

## Reference reliability

The independent human sample size is the number of people, not the number of predicted values, design pairs or screenshots. Preserve participant-level measurements for uncertainty. Report informative counts for each outcome and assess human retest or split-half reliability separately where justified. This prototype does not create a universal score threshold or a human reliability ceiling.

Tie policy is numerical, not a claim about practical equivalence. The configured tolerance handles floating-point ties. A practically meaningful indifference region would need a separately justified and frozen measurement-specific rule. Human-tied pairs provide no direction and are excluded; forecast ties carry no directional information and receive half credit.

Individual agreement with common design preferences is not proof of correct individual matching. A future identity-permutation analysis can test that question; it is not implemented here. Population and individual scores are different estimands and must not be ranked together.

## Grouping and composites

Declare outcomes, groups and weights using the research question and measurement theory. Do not count a questionnaire total and each of its component items as independent evidence. Keep distinct preference questions identifiable, even when their family budget is shared. Group overlapping navigation or time-segment measures rather than giving repeated entries extra influence.

This framework uses predeclared families, not correlations selected for favorable simulator performance. If groups are derived from human GT, disclose that choice and its uncertainty, and keep it out of agent inputs. The reported bootstrap conditions on the chosen grouping.

For the example's modified workload measure, Performance is omitted explicitly and the five retained item means are recomputed for both humans and forecasts. Scaling a six-item total preserves its ordering but does not remove the Performance contribution. Ambiguous or reversed questionnaire responses require researcher evidence, not automatic score-driven correction.

## Timing, workload and sickness

Human completion time includes perception, action and decision processes that are not represented by a model's network latency. A simulator clock may also advance differently from wall time. Report predicted human time separately from measured agent/environment execution.

Head and hand motion can be informative, but raw motion during an experimenter's handling of an unworn headset is not participant task behavior. Preserve wear/phase markers and exclude invalid windows when preparing task summaries. Subjective exposure may include practice and earlier blocks; model those inputs and carryover explicitly without leaking the target rating. Sickness prediction is not validated merely by rendering stereo frames or matching a population sickness rank.

## Validity and reporting

Plan hashes bind content, not history. A plan frozen after looking at outcomes remains post hoc even if it has a digest. Use an independently timestamped archive or registration for prospective claims. Changes create a new version, and confirmatory interpretation must follow the actual order of events.

Report all assigned jobs and deviations. Completion-only and adherence-only subsets can select different workflows or participants; label those analyses as sensitivities. Technical failures and an incorrect forecast are different outcomes. Missing outputs are not automatically worse-than-chance predictions, but differential failure rates can invalidate a comparison.

Intervals and centered-bootstrap contrasts are exploratory approximations for a discrete ranking statistic. Small samples, near ties, singleton strata and deterministic forecasts can undermine them. There is no p-value for empirically degenerate variance. The Holm family is the set of contrasts in the frozen plan; do not choose that family after inspecting results. Nonsignificance does not establish equivalence, absence of benefit or demographic harm.

Real and simulated runs are never pooled. When a configuration has both, its simulated runs are left out of every score and figure, and stay listed in the audit ("1 real + 17 simulated; simulated left out"). A configuration with only simulated runs is scored on them and named in a note, because a comparison with a configuration scored on real runs then compares invented with real forecasts. Simulated runs are only scoreable in synthetic studies.

Runtime provenance comes from the runtime. Each app session's runtime reports its engine and version, backend, device profile, observation and capabilities in the trace; the audit compares that report with the frozen recipe. Before this, the execution record copied these fields from the study, so the check could not fail. Earlier real runs without such a report are now listed with the deviation "the runtime did not report itself". Their scores do not change, but they drop out of the adherence-only sensitivity analysis.

**Within- and between-subjects studies.** Which human design differences agents are judged on depends on the design.

- *Between-subjects:* each person experienced one design, so the designs are compared as independent groups. A difference counts only when a test supports it: Mann–Whitney U between the two groups for every pair of designs, Holm-adjusted within each measure, α = .05. Agents are scored on those pairs only; the others are listed with their p-values and not scored, and a measure without any such pair is excluded for every configuration. Small groups can therefore leave little or nothing to score (with two people per group, no pair can reach significance). Preference rankings are refused (nobody saw more than one design), and so are individual configurations (one design per person leaves nothing to order). The bootstrap resamples whole people within their group.
- *Within-subjects:* the main scores keep every difference of the design means, as before, so earlier analyses stay comparable. A second view scores the population configurations on significant paired differences only (Wilcoxon signed-rank on each person's difference, Holm within each measure, α = .05). Individual configurations have no such test, since one person's profile is a single observation per design.
- *Absolute values:* for every population configuration, measure and design, the analyzer reports whether the mean of the runs' predictions lies inside the human group's 95% t interval (geometric measures on the log scale), and the signed error. In a between-subjects study these group values (completion time, workload, aesthetics) are what the study compares.

**Comparing configurations without human data.** Run-to-run agreement and agreement between configurations use the same directional idea as the human comparison, but between forecasts: for every pair of designs, two forecasts that order them the same way score 1, opposite 0, and a tie on one side 0.5; this is averaged over design pairs and over the outcomes both cover, per domain. Population runs are compared pairwise; individual runs only with runs for the same person. Between configurations, each configuration's average forecast is used (individual ones averaged over people). These describe consistency and similarity, not accuracy, and carry no test.

An analysis made before every session has finished is interim. The analyzer says how many sessions finished, failed or were never run, does not count never-run sessions as lost runs, and marks saved figures as interim.

Select protocol variants on synthetic or development tasks, then freeze before held-out evaluation. An LLM can help propose methods and explain results; deterministic code calculates the reported scores. Do not optimize agent designs repeatedly against the same hidden human targets and call the resulting evaluation independent.

## Resources

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) — workflows and adaptive agents.
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) — separating tasks, trials, transcripts and actual outcomes.

These references motivate architectural choices; they do not validate XR human prediction by this prototype.
