# API Resilience Design — Bedekli

**Date:** 2026-05-11  
**Scope:** `server.js` — `tryProviders` function + startup init  
**Goal:** Eliminate analysis failures caused by transient DNS errors and free-tier rate-limit cascades.

---

## Problem Summary

Four confirmed failure modes (from cache log analysis):

| # | Problem | Evidence |
|---|---------|----------|
| 1 | DNS/transient errors cascade immediately (no retry) | `ENOTFOUND` for googleapis/openrouter/cerebras mid-run |
| 2 | `groqKeyExhausted` never resets — survives server lifetime | Set populated by TPD errors, never cleared |
| 3 | All errors set 65s cooldown, including DNS glitches | `providerCooldowns[p.name] = Date.now() + 65000` fires on all errors |
| 4 | 4 concurrent chunks hit Groq simultaneously → thundering herd 429 | 200ms stagger insufficient at CONCURRENCY=4 |

---

## Design

### Fix 1 — Transient-error retry in `tryProviders`

**Where:** `tryProviders` callback, before the cascade call  
**What:** Detect transient network errors (`ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`). Retry the **same** provider after 2s, up to 2 retries. Only cascade on 3rd failure.

```
err.message matches /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/
  → if retryCount < 2: setTimeout(same provider call, 2000)
  → else: cascade to idx+1 (no cooldown set)
```

Non-transient errors (4xx API responses, parse errors) cascade immediately as before.

### Fix 2 — Daily reset of `groqKeyExhausted`

**Where:** After `groqKeyExhausted` declaration  
**What:** Single `setInterval` that clears the exhausted set every 24 hours.

```javascript
setInterval(() => groqKeyExhausted.clear(), 24 * 60 * 60 * 1000);
```

No retry logic change needed — once cleared, Groq keys re-enter rotation automatically.

### Fix 3 — No cooldown on transient errors

**Where:** `tryProviders` error handler  
**What:** Current code sets `providerCooldowns[p.name] = Date.now() + 65000` on ALL errors. Change to only set cooldown when error is a 429/rate-limit response, not for network/DNS errors.

```
if (/429|rate.limit|cooldown/i.test(err.message)) → set cooldown (as now)
else (transient network) → no cooldown, cascade or retry
```

### Fix 4 — Increased stagger with jitter

**Where:** `buildStep3Tasks` dispatch / chunk launch loop  
**What:** Increase base stagger from 200ms to 400ms. Add ±100ms random jitter per chunk to prevent synchronized bursts.

```javascript
const delay = i * 400 + Math.floor(Math.random() * 200);  // was: i * 200
```

---

## Constraints

- CJS only (`require`, no `import`)
- No new files — all changes in `server.js`
- No pipeline changes — `tryProviders` signature unchanged
- No external dependencies added

---

## Files Changed

| File | Lines touched |
|------|--------------|
| `server.js` | `tryProviders` (~L724-780), `groqKeyExhausted` init (~L47), chunk stagger (~L880) |

---

## Success Criteria

- Analysis completes on `בדיקת-דירה-חדשה.pdf` when network has brief interruptions
- No ENOTFOUND cascades that skip a reachable provider
- Groq keys re-enter rotation after 24h without server restart
- Concurrent chunks don't all hit Groq in the same 200ms window
