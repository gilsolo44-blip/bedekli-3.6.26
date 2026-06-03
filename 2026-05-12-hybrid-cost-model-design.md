# Hybrid Cascading Cost Model — Bedekli Sprint 5

**Date:** 2026-05-12
**Scope:** `server.js` (step3c enhanced + step3d new) + `public/report.html` (banner condition)
**Goal:** Improve per-defect cost accuracy using PDF-extracted costs first, section-budget distribution second, LLM-calibrated inference third.

---

## Problem

- `step3b` matches 0/66 defects because the PDF cost table has section totals, not per-defect prices
- `step3c` distributes section budgets by severity weight but never checks the defect's own quote for inline costs
- Most defects fall through to flat `COST_TABLE` ranges (e.g., ריצוף: ₪800–₪9,000) — too coarse
- `estimateBanner` fires only when 100% of defects are estimates — too strict, rarely shows

---

## Design

### Fix 1 — step3c: Inline Cost Extraction Before Section Distribution

**Where:** `step3c_sectionBudget` in `server.js`, before the section-name loop

**What:** For each defect without a real cost (`d.c < 200`), run a regex over `d.q` (quote) and `d.ds` (description) to find an explicit price.

```javascript
const inlineCostRe = /(?:₪|ש['"״""]ח)\s*([\d,]+)|עלות[^:\n]{0,20}:\s*([\d,]+)/i;
```

If matched → parse amount, validate `>= 200`, set `d.c = amount`, `d._cs = 'report'`.
Only defects still without cost continue to the section-budget distribution loop.
Section-distributed defects keep `d._cs = 'section'`.

### Fix 2 — step3d: LLM Cost Refinement (new step)

**Where:** New function `step3d_llmCostRefine`, called after step3c, before step4.

**Trigger condition:** Defect has no cost (`d._cs` undefined) **and** its COST_TABLE category is high-variance:

```javascript
function isHighVariance(costKey) {
  const e = COST_TABLE[costKey] || COST_TABLE['כללי'];
  return (e.max - e.min) > 4000;
}
```

High-variance categories (currently): ריצוף (8200), שפכטל (8000), חלונות (8200), אינסטלציה (9000), חיפוי קרמי (4700).
Low-variance (skip LLM): כללי (1500).

**Mechanism:** Batch all qualifying defects into **one** LLM call via `tryProviders(PROVIDERS_FAST)`:

Prompt sends:
```json
[{"id":0,"t":"כותרת","s":"high","cat":"CAT-03"},...]
```

Asks for:
```json
[{"id":0,"est":3500},...]
```

On parse success → `d.c = est` (clamped to category min/max), `d._cs` left undefined → step4 reads as `'estimate'`.
On any failure (parse error, all providers exhausted) → silent fallback, `d._cs` stays undefined → step4 uses COST_TABLE as before.

**No new API keys required.** Uses existing PROVIDERS_FAST cascade.

### Fix 3 — estimateBanner: Loosen Condition

**Where:** `public/report.html`, init block after `render()`

**Change:**
```javascript
// Before:
if (RT > 0 && D.length > 0 && D.every(d => d.costSource === 'estimate')) {

// After:
const estCount = D.filter(d => d.costSource === 'estimate').length;
if (RT > 0 && D.length > 0 && estCount / D.length >= 0.7) {
```

Banner shows when ≥70% of defects have estimated costs.

---

## Pipeline After Changes

```
step3b_matchCosts    ← LLM: per-defect cost from cost table (0 matches expected for this PDF)
     ↓
step3c_sectionBudget ← JS:
                        1. Inline regex on d.q / d.ds → costSource='report'
                        2. Section-budget distribution → costSource='section'
     ↓
step3d_llmCostRefine ← LLM (batched, 1 call): calibrated estimate for high-variance remainder
                        → costSource='estimate' (LLM-calibrated)
     ↓
step4_schema         ← JS: reads d._cs → final costSource field
```

---

## costSource Semantics (unchanged labels)

| Value | Source | Badge | Confidence |
|-------|--------|-------|-----------|
| `'report'` | Regex match in defect quote/desc | green "מדוח" | Highest |
| `'section'` | Section-budget distribution | blue "לפי סקשן" | Medium |
| `'estimate'` | LLM-calibrated or COST_TABLE | gray "הערכה" | Lowest |

---

## Constraints

- CJS only — no `import`
- No new files — all changes in `server.js` and `public/report.html`
- No pipeline order changes — step3d inserts between step3c and step4
- step3d failure must be silent — never block the pipeline
- step3d uses one batched LLM call — not one call per defect

---

## Success Criteria (GATEKEEPER test on `בדיקת-דירה-חדשה.pdf`)

- Defect count unchanged: 50+ (regression check)
- `reportTotal` unchanged: ₪198,545 (regression check)
- At least some defects with `costSource='report'` (inline extraction working)
- Fewer defects with flat COST_TABLE ranges after step3d
- `analysisLog` shows step3c and step3d assignment counts
- estimateBanner fires if ≥70% of defects are estimates
