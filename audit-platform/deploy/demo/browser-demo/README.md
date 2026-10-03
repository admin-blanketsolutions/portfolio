# Browser demo with the AI copilot

A single-page version of the demo for sales meetings. It has nothing to host and no API key. It uses the same synthetic firm, chart of accounts and sample trial balances as the [hosted demo](..).

- **What's in it:**
  - sign-in with four roles (partner, manager, senior, associate);
  - engagements, materiality and the risk register;
  - trial balance import (Excel or CSV in English, Arabic or both);
  - mapping, lock, adjustments with approval, draft IFRS statements with drill-down;
  - working-paper sign-offs, and a hash-chained audit trail with a tamper demo.
- **The AI copilot:**
  - **AI mapping** with a reason for each line;
  - **AI risk suggestions**;
  - an **AI analytical review** whose findings can become proposed adjustments;
  - **Ask AI**, a chat about the engagement.

  When the page is opened in claude.ai it calls Claude live, through the Artifact `sample` capability, on the viewer's own claude.ai account. Anywhere else the AI is unavailable. The review and risk suggestions then show prepared examples for the sample files, labelled "Recorded AI output", and mapping falls back to the built-in rules and keyword matcher.
- **What it is not:** the production platform. Data stays in the browser tab (`localStorage`), and nothing is sent anywhere except the AI prompts in claude.ai.

## Files

| File | Purpose |
|---|---|
| `DEMO-SCRIPT.md` | What to click and what to say, step by step, plus preparation and likely questions. |
| `demo.src.html` | The page source. `__COA__` and `__SAMPLES__` are filled in by the build. |
| `build.py` | Builds `audit-demo.html`, taking the chart from `../seed/demo.sql` and the trial balances from `../sample-tbs/make_samples.py`. Standard library only. |
| `audit-demo.html` | The built page, in the claude.ai Artifact page format (no `<html>` wrapper). |
| `check.mjs` | Headless end-to-end check, with the AI replaced by a stub. |
| `record-walkthrough.mjs` | Records the demo script as a captioned video, with prepared AI answers. |
| `harness.mjs` | Shared by `check.mjs` and `record-walkthrough.mjs`: the page wrapper and the AI stub. |

## Commands

```bash
python3 build.py                                  # after editing demo.src.html, the seed or the samples
node check.mjs                                    # needs web/node_modules (npm ci in web/); CHROMIUM_PATH=... to pick a browser
node record-walkthrough.mjs demo-walkthrough.webm # about 4.5 minutes, 1280×800
```

To publish or update the page, publish `audit-demo.html` as a claude.ai Artifact with the `sample` capability. Without that capability the AI features don't run.
