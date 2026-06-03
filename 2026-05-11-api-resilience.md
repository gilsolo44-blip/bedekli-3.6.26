# API Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate analysis failures caused by transient DNS errors and free-tier 429 thundering-herd cascades.

**Architecture:** Two targeted changes to `server.js` only. Task 1 adds transient-error retry logic and tightens cooldown scope inside `tryProviders`. Task 2 increases chunk-launch stagger and adds jitter so concurrent chunks don't hit the same provider simultaneously.

**Tech Stack:** Bun/Node.js, CJS, no external dependencies, no test framework — verification via `node -e` assertions + manual server test.

---

## Context

- `tryProviders` (`server.js:724`) — recursive cascade function; takes `idx` to walk the provider list
- `MIN_STAGGER` (`server.js:826`) — ms between consecutive step3 chunk launches
- Stagger applied at `server.js:889`: `const delay = slotLaunch++ * MIN_STAGGER;`
- `groqKeyExhausted` already cleared per-analysis at `server.js:1003` — no daily-reset timer needed

---

## Task 1: Transient-error retry + cooldown scope fix in `tryProviders`

**Files:**
- Modify: `server.js:724` — function signature (add `_tr` param)
- Modify: `server.js:759-767` — error handler block

### What changes

`tryProviders` currently treats every error identically: log it, maybe set 65s cooldown, cascade to `idx+1`. The fix:

1. Add `_tr = {}` (transient-retry counts) as a final parameter — threaded through recursive calls so counts persist across retries of the same provider.
2. In the error handler: if the error matches `/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i`, retry the **same** provider (same `idx`) after 2s, up to 2 retries. On the 3rd failure, cascade without setting a cooldown.
3. Cooldown (`providerCooldowns`) is set **only** for 429/rate-limit errors — not for DNS/network errors.

- [ ] **Step 1: Read current `tryProviders` signature and error block**

```bash
sed -n '724,780p' '/Users/gilsolo44/Downloads/בדקלי חדש/server.js'
```

Confirm line 724 starts with `function tryProviders(` and line 761 starts with `if (err) {`.

- [ ] **Step 2: Replace the function signature (line 724)**

Find:
```javascript
function tryProviders(system, user, log, callback, idx = 0, providers = PROVIDERS_FAST) {
```

Replace with:
```javascript
function tryProviders(system, user, log, callback, idx = 0, providers = PROVIDERS_FAST, _tr = {}) {
```

- [ ] **Step 3: Replace the error handler block (lines ~761-767)**

Find:
```javascript
    if (err) {
      log.push(`  [${p.name}] ✗ ${err.message.slice(0, 60)}`);
      if (/429|rate.limit|cooldown/i.test(err.message)) {
        providerCooldowns[p.name] = Date.now() + 65000;
        log.push(`  [${p.name}] → cooldown 65s`);
      }
      return tryProviders(system, user, log, callback, idx + 1, providers);
    }
```

Replace with:
```javascript
    if (err) {
      log.push(`  [${p.name}] ✗ ${err.message.slice(0, 60)}`);
      if (/429|rate.limit|cooldown/i.test(err.message)) {
        providerCooldowns[p.name] = Date.now() + 65000;
        log.push(`  [${p.name}] → cooldown 65s`);
        return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
      }
      if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(err.message)) {
        const r = (_tr[p.name] = (_tr[p.name] || 0) + 1);
        if (r <= 2) {
          log.push(`  [${p.name}] ↻ רשת — ניסיון ${r}/2`);
          return setTimeout(() => tryProviders(system, user, log, callback, idx, providers, _tr), 2000);
        }
        log.push(`  [${p.name}] ✗ רשת — עבר לבא בתור`);
        return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
      }
      return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
    }
```

- [ ] **Step 4: Update the two internal cascade calls (non-error paths) to pass `_tr`**

Find (the cooldown-wait path, ~line 753):
```javascript
      return setTimeout(() => tryProviders(system, user, log, callback, 0, providers), wait);
```
Replace with:
```javascript
      return setTimeout(() => tryProviders(system, user, log, callback, 0, providers, _tr), wait);
```

Find (the "all exhausted" early return, the cascade for empty/no-JSON responses):

Lines ~769-776:
```javascript
    if (!result || !result.trim()) {
      log.push(`  [${p.name}] ✗ empty response → cascade`);
      return tryProviders(system, user, log, callback, idx + 1, providers);
    }
    if (!result.includes('{') && !result.includes('[')) {
      log.push(`  [${p.name}] ✗ no JSON in response → cascade`);
      return tryProviders(system, user, log, callback, idx + 1, providers);
    }
```
Replace with:
```javascript
    if (!result || !result.trim()) {
      log.push(`  [${p.name}] ✗ empty response → cascade`);
      return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
    }
    if (!result.includes('{') && !result.includes('[')) {
      log.push(`  [${p.name}] ✗ no JSON in response → cascade`);
      return tryProviders(system, user, log, callback, idx + 1, providers, _tr);
    }
```

- [ ] **Step 5: Verify the logic with a node one-liner**

```bash
node -e "
const isTransient = msg => /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(msg);
const is429 = msg => /429|rate.limit|cooldown/i.test(msg);
console.assert(isTransient('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), 'ENOTFOUND match');
console.assert(isTransient('connect ETIMEDOUT'), 'ETIMEDOUT match');
console.assert(is429('Groq rate limited'), '429 match');
console.assert(!isTransient('Groq rate limited'), 'no transient false positive');
console.assert(!is429('getaddrinfo ENOTFOUND'), 'no 429 false positive');
console.log('all assertions pass');
"
```

Expected output: `all assertions pass`

- [ ] **Step 6: Start server and verify it boots without errors**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && pkill -f 'bun server.js' 2>/dev/null; sleep 1; bun server.js &
sleep 2 && curl -s http://localhost:3000/ | head -c 100
```

Expected: HTML response (first 100 chars of index.html), no crash.

- [ ] **Step 7: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש'
git add server.js
git commit -m "fix: retry transient DNS errors in tryProviders, cooldown only on 429"
```

---

## Task 2: Increase stagger and add jitter between chunk launches

**Files:**
- Modify: `server.js:826` — `MIN_STAGGER` constant
- Modify: `server.js:889` — delay calculation

### What changes

Currently all 4 chunks launch at `i * 200ms` — 0ms, 200ms, 400ms, 600ms. At 0ms they all start simultaneously. Increasing to 400ms base + ±100ms jitter means 0ms, ~400ms, ~800ms, ~1200ms — spreading load over 1.2 seconds instead of 0.6s.

- [ ] **Step 1: Change `MIN_STAGGER` from 200 to 400**

Find (`server.js:826`):
```javascript
const MIN_STAGGER = 200; // ms between consecutive slot launches
```
Replace with:
```javascript
const MIN_STAGGER = 400; // ms between consecutive slot launches
```

- [ ] **Step 2: Add jitter to the delay calculation**

Find (`server.js:889`):
```javascript
      const delay = slotLaunch++ * MIN_STAGGER;
```
Replace with:
```javascript
      const delay = slotLaunch++ * MIN_STAGGER + Math.floor(Math.random() * 200);
```

- [ ] **Step 3: Verify constant change is correct**

```bash
node -e "
const MIN_STAGGER = 400;
const delays = [0,1,2,3].map(i => i * MIN_STAGGER + Math.floor(Math.random() * 200));
console.log('Chunk delays (ms):', delays);
console.assert(delays[0] >= 0 && delays[0] < 200, 'chunk 0 starts near 0');
console.assert(delays[3] >= 1200 && delays[3] < 1600, 'chunk 3 starts after 1.2s');
console.log('jitter spread OK');
"
```

Expected: `Chunk delays (ms): [0-199, 400-599, 800-999, 1200-1399]` and `jitter spread OK`

- [ ] **Step 4: Confirm server still starts cleanly**

```bash
pkill -f 'bun server.js' 2>/dev/null; sleep 1
cd '/Users/gilsolo44/Downloads/בדקלי חדש' && bun server.js &
sleep 2 && curl -s http://localhost:3000/ | grep -c '<html'
```

Expected output: `1`

- [ ] **Step 5: Commit**

```bash
cd '/Users/gilsolo44/Downloads/בדקלי חדש'
git add server.js
git commit -m "fix: increase chunk launch stagger to 400ms + jitter to reduce provider thundering herd"
```

---

## Self-Review Against Spec

| Spec requirement | Task |
|-----------------|------|
| Detect ENOTFOUND/ETIMEDOUT/ECONNRESET, retry same provider ≤2 times with 2s delay | Task 1, Steps 2-4 |
| No cooldown set on transient network errors | Task 1, Step 3 (only 429 path sets cooldown) |
| Daily reset of groqKeyExhausted | N/A — already handled by `pipeline()` clearing it per-analysis at L1003 |
| Increase stagger from 200ms to 400ms + jitter | Task 2, Steps 1-2 |

All spec requirements covered. No placeholders. All code shown in full.
