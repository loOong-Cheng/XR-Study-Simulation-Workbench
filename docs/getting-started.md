# Start your own study

This guide is for a researcher who has **finished** an XR user study and wants to know how well AI agents forecast its results.

You need:
- the protocol, documentation or manuscript (exact or not);
- the study data;
- the XR app.

**On a new machine:** copy the folder, open Claude Code in it and say "set this up on this machine". It installs and checks everything (`node scripts/setup.mjs`), connects your engine's MCP runtime and starts the website. You only review, run and analyze.

**The easy way:** open this repository in Claude Code or Codex and describe your study. The agent follows [AGENTS.md](../AGENTS.md) and does the steps below with you. This page explains what happens, so you can also do it yourself in the website (`npm start`, then http://127.0.0.1:4317).

**Try it first** with the three example suites under **Open study**. [Graphics quality](../examples/graphics-quality/README.md) is a complete, runnable WebXR study with invented data. [Synthetic Ecolar](../examples/ecolar/README.md) shows a larger Unreal study with population and individual configurations, measured inputs and movement data. [Selection](../examples/selection/README.md) is a Unity study with participant background, with its Unity app and study bridge included.

## Your research questions, in three kinds

| Kind of question | Example | Where it goes |
| --- | --- | --- |
| About your **XR designs** | "Does graphics quality change presence?" | Designs (independent variable) and measures (dependent variables) |
| About **what helps an agent predict** | "Does using the app beat reading its files?" | Agent configurations, compared in the analyzer |
| About **models** | "Is model B better than model A?" | Each configuration's model, or a model arm added later |

## 1 · Study and variables (planner)

1. Create the study under **Open study** (real data lives in `private/studies/`, which git ignores).
2. Choose your document and, if you have it, a participants file with IDs and design orders (`participant,order`).
3. Press **Understand study** (only needed for a new study; the example suites are already described). The assistant, set in Settings, drafts:
   - the designs (independent variable) and the participant information agents may get (covariates);
   - the measures (dependent variables), with domain, unit, scale and family;
   - the **study brief**, which every configuration reads: the task, the designs, the procedure and the measures as participants experienced them. It is told to leave out every result (values, statistics, findings), and the outcome-blind check (see Evidence & knowledge) runs on it.

   Every fact cites the document. You review the draft and the brief together and edit the brief in place; **Use this draft** takes both, and **Save study** writes the brief to `agent-brief.md` in the study folder (mapped in `workspace.json`). You fix and tune the tables, then save.

   The green button on each page is the next sensible step: choose a document, Understand study, use the draft, Save study, then **Evidence & knowledge →**.
4. Check the **design**. *Within-subjects*: everyone experienced every design. *Between-subjects*: each person experienced one; then preference rankings and individual-level configurations are not possible, and the analyzer compares the groups with independent-samples tests.
5. Choose **Forecast timing**:
   - **After the study** allows a configuration to receive some measured outcomes as inputs (for example measured performance to predict experience).
   - **Before** never does.
6. Check the **measures**: domain, unit, scale and mean (arithmetic or geometric) can be changed in the table, and **Remove** drops a measure (configurations stop predicting or receiving it; frozen campaigns keep it; its human data is no longer used).
7. Check **Agent observation**. *Single image (mono)* or *Left/right pair (stereo)*. The built-in WebXR runtime gives a single image: with stereo, configurations that use the app can be simulated but not run as agents (the Study page says so). For WebXR, the study's **Device** must be the runtime's `webxr-desktop-browser-1280x720`; a button sets it.

**Saving is all or nothing.** The study, the configurations and the comparisons are checked together before anything is written, so a refused save leaves every file as it was; a study change that no longer fits a saved configuration (for example removing a source it reads) names that configuration. If the saved files disagree anyway (edited outside the website), the study still opens and a banner says what to fix.

**Download study.json** saves the study; **Load study.json** loads one back. Loading keeps this study's ID (the folder's study), so its campaigns and human data still match; a message says when the loaded file had another ID.

Unsaved changes are kept only in the page: reloading or closing it, or opening another study, asks first. Nothing chosen for one study (document, participants file, drafts, figures) carries over to another.


Throughout planning, **reference answers stay withheld**: the website never shows human results.

## E · Evidence and knowledge (planner)

**Study brief** (the card at the top): what every configuration gets. Understand study drafts it; **Edit text** changes it, and a study without one shows **Write the brief**, so a study without a document can get one too. Without a brief no configuration can run as an agent. It has the same outcome-blind check as general knowledge.

Knowledge a configuration may get besides the study brief. It is optional: the workbench runs without any. Population and individual configurations can use every kind except movement recordings, which reach individual configurations only (population jobs get none); which configuration gets what is chosen on **Agent configurations** (for example two otherwise identical configurations with different knowledge, compared in the analyzer).

**General knowledge** (the same for everyone): findings from papers, computational models, expert heuristics. Each source shows a preview, its file, size and hash, which configurations use it, and an **outcome-blind check**: the number of participant IDs it names and of numbers that equal a human design mean to two decimals (only counts, so you do not see the results either).

**Participant-specific knowledge** (per person): background such as age band or XR experience, and movement recordings.

- **It must be complete:** every participant has exactly one entry, and no allowed field is empty (empty, NA, N/A, NaN, null and ? count as missing; "none" is an answer). An incomplete source blocks the configurations that get it, in the executor and on the freeze page. A file with a column name used twice, or a quote that is never closed (the line is named), is refused.
- **Only the allowed fields reach the agent:** the ID column and the declared fields, for background and movement recordings alike; other columns (for example an operator's notes) never do. A field, or for a new file any column, named like a measure is refused: results are never participant knowledge.
- **Only this study's participants count.** Rows for other people are ignored for what agents get and for completeness, and named ("rows for people not in this study are ignored: p99").
- **What agents get** is shown: a population configuration gets a summary of the cohort (mean and range for numbers, counts for categories, counted regardless of capitals and shown in the first spelling; a value with a comma is quoted); an individual configuration gets the person's own entry (not shown for between-subjects studies, which have no individual configurations). Movement recordings were measured during the study, so only their completeness is shown while planning; they go to individual configurations only.
- **Movement recordings as a folder:** one or more CSV files per person, named after the ID (`p03.csv`, `p03_low.csv`, `p03_high.csv`). Each person gets all of their files, sorted, each under its file name. A file that is empty or has only a header counts as missing.

**Edit any knowledge:** **Rename** (name and description), **Edit text** (general knowledge), **Fields** and **Replace file** (participant background), **Delete** (it is removed from the configurations that got it; the file stays in the study folder, and frozen campaigns keep what they froze). Each change is saved at once, together with other unsaved planner edits.

**Add knowledge** (below both sections): choose any file.

- A table (CSV; comma, semicolon or tab separated) with this study's participant IDs is participant-specific knowledge as it is, saved comma-separated. A file without a row for someone cannot be added; a column that is empty for anyone cannot become a field agents see, and columns named like a measure are left out. A table with an ID column but none of this study's participants is refused with the IDs it has.
- A new file never replaces another source's file, nor one kept from a deleted source: it gets a free name.
- Any other file, such as a paper (PDF, DOCX) or notes, is read by the assistant set in Settings. It decides whether it is general or participant-specific knowledge, drafts it (a Markdown note, or one row per participant), and leaves out this study's own results. The draft holds only what the document says, in its own words: the assistant is told to add no outside knowledge or conclusions of its own. You review and edit the draft, then add it; it is listed in its section. If the assistant cannot be reached, the extracted text is offered as the draft.

## 2 · Agent configurations (planner)

Each card is one configuration:

| Setting | Meaning |
| --- | --- |
| Level | **Population** predicts the group's averages per design. **Individual** predicts each person's experience. |
| Runs | Independent sessions. Individual: runs per person. Population: runs in total. Left empty, it follows **Runs per participant** on the Freeze page (default 1): individual configurations run that often per person; population configurations get participants × that, so both levels produce the same number of forecasts. Set fewer population runs to save usage. |
| Model | Defaults to your planned usage: headless Claude Code with the model from Settings. **Effort** is how much the model thinks before answering (Claude Code's `--effort`: default, low, medium, high, xhigh, max); another value is refused when saving, freezing or continuing. A model ID Claude Code does not know fails its first session with "Claude Code does not know the model …". |
| Runtime | How the agent experiences the app: none, or the study's own runtime (WebXR built in; Unreal, Unity or Apple Vision Pro configured in Settings). Runtime and "the running app" go together: choosing *none* unticks the app, choosing a runtime ticks it. |
| Token budget | All tokens a session may use: input (including cache) and output; at least 20,000 (the first turn alone, with instructions, brief and tools, uses several thousand, and every later turn re-reads it) and at most 50,000,000. When what is left is smaller than 10% of the budget, or than 1.5 × the last turn's input, the tools stop and the agent submits. A session above 150% is stopped, but never once its forecast was accepted: the tokens up to the forecast are recorded (`tokensAtSubmit` in the result and the execution manifest) and the closing turn separately. A session that ends over its budget is shown as "over budget: … of … tokens". Templates start at 100,000 (description only), 400,000 (files) and 2,000,000 (the app); empty means no limit. A tool-call limit remains under *Advanced* as a safety cap, with the fewest calls the protocol needs. |
| The agent gets | Tick the sources (the brief, project, each evidence source, participant information) and "the running app". The permissions follow from what is ticked. Movement recordings can be ticked for individual configurations only; switching a configuration to population removes them. The summary also lists measured inputs ("measured X of this person" or "as the cohort means"). |
| Predicts / inputs | Which measures it forecasts, and which measured ones it receives. A measure is never both. |

**Add from template** adds a ready-made configuration. A template whose requirements are missing is greyed out and says what it needs, for example the project files on this machine, a WebXR app declared in `workspace.json`, or complete participant-specific knowledge. **Add custom configuration** starts from the brief only, and **Duplicate** copies a configuration, for example to give the copy a second evidence source instead of the first. Save, then **Approve study and configurations**, then **Freeze →**. Approval records exactly what you checked.

## 3 · Freeze (planner)

**Freeze campaign** turns the study and configurations into a fixed list of sessions. Nothing frozen is ever edited. Changes become a continuation (step 7).

- Give a campaign a **label** (for example "pilot A×2" or "main run"). Labels can be changed later; they are stored beside the campaign, not in it.
- **Campaigns** lists every campaign as a tree: continuations under their parent, with sessions, done, failed, not run, real and simulated results, and cost. The numbers follow the sessions as they end (at most every 2 seconds) and match the executor's table: a session whose attempts all failed, simulated or real, counts as failed. **Show** picks the campaign the executor and analyzer use; both pages name it and have a switcher.
- A label typed for a freeze you then cancel (to open the existing campaign instead) is not kept for the next freeze.
- Freezing exactly the same configurations, models and sessions again asks first and offers to open the existing campaign.
- **Compare two campaigns** (below the list, needs human data) sets each configuration's agreement with humans in one campaign beside another, with the model and effort and the kind of runs (real or simulated) on each side. A change is shown only where the setup is the same and both sides rest on the same kind of runs; real runs are never set against simulated ones.
- **A campaign keeps the knowledge it froze.** Its sessions get the frozen study's sources and fields, whatever the workspace says later. The sha256 of each source file or folder (brief, evidence, background, movement recordings) is recorded beside the campaign (`campaigns/<id>/sources.json`); if one changes afterwards, real sessions of the configurations that read it are refused: "… changed after this campaign was frozen. Freeze a new campaign, or Continue / rerun to use the new version." Project folders are read live and not fingerprinted (an engine rewrites its project when opened). Campaigns frozen before this check behave as before.
- **Delete** removes a campaign you no longer need (a summary asks first). Its campaign file and runs move to the study's `deleted/` folder, so nothing is lost by mistake; remove that folder to free the space. A campaign that another one continues from cannot be deleted (its runs are reused there): delete the continuation first.

## 4 · Run agents (executor)

- **Next step:** a line says what to do next: start, rerun failed, continue after a configuration changed, or analyze; the matching button is the green one.
- **Runtimes:** cards show the runtimes this campaign uses and whether they are ready (**Show all runtimes** lists the others). WebXR needs Chrome and an app that exposes `window.xrStudy`. Unreal, Unity and Apple Vision Pro need a study bridge (a stdio MCP server that drives the engine; see [runtime adapters](runtime-adapters.md#study-bridge-contract)) set as the runtime's command in **Settings → Runtimes**, on the machine that runs the engine. Suite 2 includes one for its Unity app.
- **Starting:** the executor tells you which configurations cannot run here and lets you run the rest. A configuration that reads a source without a file on this machine (`workspace.json` → `sources`) cannot run as an agent; the freeze page warns about it too. The same holds for a source that leaves the study folder or reaches human results: the study folder itself, `human.json`, `campaigns/`, `runs/`. Only a project folder elsewhere on the machine is allowed, given as an absolute path.
- **A pilot or small test:** open **Choose sessions to run**, check configurations and select the first *k* sessions of each, or tick sessions in the table. Only those start; the others stay *not started* and can run later in the same campaign. Start shows the exact number of sessions and, from earlier real runs, an estimate of the cost.
- **Mode** is a choice of two: **Run agents** or **Simulate**. A research study starts in Run agents and a synthetic one in Simulate; nothing starts until you press **Start all not run yet (n)** (or **Start selected (n)**).
- **Run agents** starts fresh, locked-down Claude Code sessions with your login, and asks before using your Claude usage.
- **Simulate** produces invented runs for trying the pipeline, also in a research study. They are labelled simulated and never presented as real runs. In a research study they are never scored against the human data: the analysis leaves them out and says so in its notes, and Compare agents names configurations described by simulated runs. In a synthetic study they are never pooled with real runs of the same configuration: the real ones are scored, the simulated ones left out. Invented values lie on each measure's range, taken from its unit or scale (for example 0–100, 1–7, a proportion).
- **What the agents get:** links to the brief, project and evidence of the campaign shown, as it was frozen. A source deleted from the study later is still listed, marked as deleted.
- **Watching:** the table shows each session live: status, tool calls (what the agent does before forecasting; submitting the forecast is not counted, here and in the attempts), and tokens in / out while it runs (input includes cache; each message's final count, so they match Claude Code's totals within the message in progress); the cost appears when the session ends. A session stopped or killed before the end keeps its tokens and shows "cost unknown (stopped before the end)". Simulated sessions show no tokens, since no model was called. A reused session shows the tokens and cost of the run it reuses; that cost was paid in the earlier campaign and is listed apart in the sum row. Each configuration has a sum row. The header says **paused** while sessions wait in the queue and **idle** when nothing waits or runs.
- **Previews:** click a session to preview its latest screenshot and messages; Ctrl/⌘-click (or Shift-click) adds more, shown side by side; **Preview all running sessions** follows every running one; **Close previews** shows none.
- **Attempts:** selecting a session lists every attempt (also stopped ones), its tool calls and cost, and which one counts (the first completed).
- **Rerun configurations:** check configurations under **Choose sessions to run, or configurations to rerun** and press **Rerun the checked configurations**. Finished runs are never overwritten, so this makes a new campaign that continues the current one: the checked configurations get fresh sessions, all others reuse their finished runs. The executor switches to it; nothing starts until you press Start.
- **Controls:** Pause, Resume, Stop and **Rerun failed** work at any time. **Stop** ends running sessions at once, real and simulated: they stay *stopped* and can run again right away. **Start** while sessions run adds the chosen ones to the queue (in the same mode: real and simulated sessions do not share a queue). The cost estimate before Start counts only the sessions that will run and uses earlier sessions with the same provider, model and effort. **Save runs as zip** exports what exists so far; **Load runs zip** brings runs from another machine (for example the PC that runs Unreal). Runs load only into the study they were made for (the same study ID, i.e. the same study.json). Every file is checked before anything is written, and loading the same zip twice adds nothing. A newer zip of the same campaign adds the sessions finished since. If the same session attempt has different records here and in the zip, the zip is refused rather than mixed in. Zips over 2 GB unpacked (or 500 MB for one file) are not loaded.

## 5 · Compare agents (analyzer)

Needs no human data, so it is useful while piloting. For each configuration: real and simulated runs (described by the real ones when both exist), protocol deviations, **run-to-run agreement** (how consistently repeated runs order the designs), tool calls, minutes and cost. Runs a continuation reuses count with their tool calls, minutes and cost. A matrix shows how far configurations agree with each other on the design pattern.

## 6 · Compare with humans (analyzer)

**Human data alone:** choose a measure and **Show human data**: each design's participant values, mean or geometric mean with 95% CI, and the test between every pair of designs (Wilcoxon signed-rank within subjects, Mann–Whitney U between subjects, Holm). No configuration or agent run is needed, only a frozen campaign, so human results stay hidden while you plan.

**Agents against humans:**

1. Press **Analyze campaign**. Human values are shown only on this page (`human.json` is also read for declared inputs and the outcome-blind evidence check, without showing values).
2. Select the configurations to compare, then a view:

| View | Shows |
| --- | --- |
| Agreement | How often each run or participant got the direction of the human design differences right (50% = chance). Box + violin + dots, Holm-adjusted rank-test brackets. |
| Agent vs human | For one measure: participants' values beside each configuration's predictions per design, plus a discrepancy table. |
| Correlation | Agent vs human pattern across designs, with Pearson r and Spearman ρ. |
| Population vs individual | Repeated population runs vs individual forecasts averaged to the group. |
| Participants | One line per participant across individual configurations, with a Spearman heatmap. Not offered for between-subjects studies. |

When nothing can be scored for the selected configurations (for example a between-subjects study in which no group difference is significant), the Agreement and Population vs individual views say so and why, instead of drawing empty or zero values. Opening another study, showing another campaign or analyzing again clears earlier figures and explanations.

   Figures follow the scores: an individual configuration is left out until every participant has a forecast (it is not scored before), and a configuration is left out of a measure or domain it does not predict (for example a measured input). A note under the figure names what was left out and why. A failed session in the list of sessions that ran says why it failed.
3. Below the scores: the **human design differences** with their test (only significant ones are scored in between-subjects studies; within-subjects studies can switch to a significant-only view), and the **absolute values**: whether each configuration's mean prediction lies inside the human 95% CI.
4. **Save SVG** or **Save PNG**.
5. Optionally, **Explain with assistant** sends only the scores (never raw human data) to the configured assistant, with each configuration's name, level, model, effort and what it gets; the answer refers to configurations by name.
6. Comparisons between configurations are chosen here, saved in `comparisons.json`, and marked as chosen at analysis.

## 7 · Continue or rerun (planner)

- **Continue from** is the campaign shown in the executor and analyzer (marked "shown"), unless you pick another one on this page; the list names campaigns by their labels.
- **Per configuration:** add **Runs**; **Add model** (append a model: the configuration and its finished runs stay, and a copy with the added model joins it, to compare both); **Rerun** (fresh sessions, same setup); **Drop** (a dropped configuration is not reported as missing from the new campaign). To change a configuration's model, change it on **Agent configurations**; Continue lists the change and runs that configuration again with the new model. **Preview** shows new vs reused sessions; **Create continuation** freezes it and opens the executor.
- **What is reused:** only sessions with an accepted forecast. Failed, stopped and never-started sessions run again.
- **Keep simulated runs:** off by default, so sessions that were only simulated run again like sessions that never ran; leave it off before running real agents. Turn it on to reuse simulated runs while trying the pipeline. The preview says how many reused runs are simulated. (**Rerun the checked configurations** in the executor keeps simulated runs only while its mode is *Simulate*.)
- **Names of added models:** a copy is named after its model and effort, for example "Text only — claude-sonnet-5-5, effort high", and gets "(2)" if that name is taken. When a later continuation changes the model of such a copy, its name follows; a name you typed stays.

## What you still build yourself

- **A converter from your raw data to `human.json`:** one record per participant × design × measure. See `examples/graphics-quality/data/convert_to_human.py`. Your coding agent can write it.
- **An MCP runtime, if your engine has none.** For WebXR, expose `window.xrStudy` in the app. See [runtime adapters](runtime-adapters.md).
