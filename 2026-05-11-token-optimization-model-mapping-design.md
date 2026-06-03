# Token Optimization & Model-Mapping Policy
**Date:** 2026-05-11
**Project:** Bedekli — Home Inspection AI Analyzer
**Status:** APPROVED — enforce without re-evaluation

---

## Context

Large files (server.js 1249 lines, report.html 1164 lines, index.html 935 lines, viewer.html 665 lines) with an 8-step LLM pipeline and Hebrew text throughout. The dominant token waste pattern is context re-loading caused by unplanned model switching mid-session. This policy eliminates that waste by mapping task categories to models once, up front.

---

## 1. Task Category Map

| Category | Task Type | Trigger Examples | Model |
|---|---|---|---|
| **A** | Large-scale refactoring & logic auditing | Reading >500 contiguous lines of `server.js`; cross-step pipeline fixes (step1↔step2↔step3 interactions); provider cascade + cooldown logic end-to-end | **Opus 4.7** |
| **B** | UI/UX & frontend iterations | DOM logic, CSS, display state, filter behavior in `report.html`, `index.html`, `viewer.html` | **Sonnet 4.6** |
| **C** | Rapid bug fixes & boilerplate | Isolated single-function changes: fix a regex, tweak a constant, add a CSS badge, remove a div, add an `esc()` call | **Haiku 4.5** |
| **D** | Documentation & summarization | CLAUDE.md updates, `research.md`, commit messages, spec docs, comments | **Haiku 4.5** |

### Category A examples (Opus triggers)
- Bug #1: `step1_llm` returns 1 section for 73-page PDFs — requires reading step1 + pipeline orchestrator together (~500+ lines)
- Bug #2: `step3_extract` chunk splitting — requires reading step3 + step2b + concurrency logic together
- Any full pipeline trace from `step0` through `step4`

### Category C examples (Haiku triggers)
- Bug #5: remove "עלות מינ׳" div from `report.html` hero
- Bug #6: add `costSource` badge near cost display
- Bug #7: reduce sessionStorage thumbnail scale/quality constants
- Bug #3: `action === desc` fallback — single conditional in `step4_schema`

---

## 2. Fixed Primary Model

**Sonnet 4.6** (`claude-sonnet-4-6`)

**Rationale:** The dominant daily workload is P1/P2 bug fixes spanning 200–400 line *sections* of `server.js` — well within Sonnet's effective range. It also handles all Category B work natively. Most sessions stay in a single tier.

**Default rule:** When a task is ambiguous or doesn't clearly map to a category, use Sonnet 4.6.

---

## 3. The Single Exception Rule

**Scenario:** Any task that requires reading AND reasoning across more than **500 contiguous lines** of `server.js` in a single chain.

**Trigger is line-scope, not topic complexity.** A "hard" problem that fits in 300 lines stays on Sonnet. A "simple" problem that requires holding 600+ lines in context switches to Opus.

**Target model:** Opus 4.7 (`claude-opus-4-7`)

**Cost-benefit:** One correct Opus session solving Bug #1 or Bug #2 outperforms 3–4 partial Sonnet iterations that each require re-loading the file. Break-even is approximately 3 failed Sonnet attempts.

---

## 4. Execution Policy

- **No re-evaluating.** The map above is the answer for this project. Do not suggest a different model during active development.
- **No "it depends."** Ambiguous tasks default to Sonnet (Primary).
- **Switch trigger is line-scope, not topic.** See Section 3.
- **No comparison tables.** Do not generate verbose model options or pros/cons during sessions.
- **Minimum verbosity.** Keep reasoning internal. Output only the work product.

---

## Switch Protocol

| Direction | When | Action |
|---|---|---|
| Sonnet → Opus | Task scope grows past 500 contiguous lines | Switch before starting; do not partial-start on Sonnet |
| Sonnet → Haiku | Task is clearly Category C or D | Switch before starting |
| Opus → Sonnet | Task complete; returning to normal iteration | Switch back immediately |
| Any → Any | Mid-task | Never switch mid-task; complete or abort first |

---

## File Reference

| File | Lines | Category mapping |
|---|---|---|
| `server.js` | 1249 | A (>500 lines span) or B/C (localized sections) |
| `public/report.html` | 1164 | B (large changes) or C (isolated elements) |
| `public/index.html` | 935 | B or C |
| `public/viewer.html` | 665 | B or C |
| `api/analyze-simple.js` | ~38 | C always |
