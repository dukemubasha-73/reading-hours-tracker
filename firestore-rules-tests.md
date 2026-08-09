# Firestore Rules Test Cases — Reading Hours Tracker (Phase 5)

Run these against `firestore.rules` in the Rules Playground (Firebase console →
Firestore → Rules → Playground tab) or the local emulator. For each: set the
**Authenticated** toggle and UID as specified, set **Location** to the path
given, choose the **Simulation type** (get / create / update / delete), and
paste the **Document data** where applicable.

Two auth identities used throughout: `userA` (the legitimate owner of the data
under test) and `userB` (a different authenticated user, for cross-user tests).

---

## A. Ownership / access control

| # | Auth | Location | Op | Data | Expected |
|---|------|----------|----|----|----------|
| A1 | uid=`userA` | `/users/userA/sessions/sess1` | get | — | **ALLOW** |
| A2 | uid=`userA` | `/users/userA/sessions/sess1` | create | see "Valid session" below | **ALLOW** |
| A3 | uid=`userB` | `/users/userA/sessions/sess1` | get | — | **DENY** |
| A4 | uid=`userB` | `/users/userA/sessions/sess1` | create | see "Valid session" below | **DENY** |
| A5 | unauthenticated | `/users/userA/sessions/sess1` | get | — | **DENY** |
| A6 | unauthenticated | `/users/userA/sessions/sess1` | create | see "Valid session" below | **DENY** |
| A7 | uid=`userA` | `/users/userA/sessions/sess1` | delete | — | **ALLOW** |
| A8 | uid=`userB` | `/users/userA/sessions/sess1` | delete | — | **DENY** |
| A9r | uid=`userA` | `/users/userA` | get | — | **ALLOW** (read only — see rules comment: this exact read is used by cloud-sync.js's legacy-data check on every first sign-in; denying it broke that flow entirely, fixed after being caught in review) |
| A9w | uid=`userA` | `/users/userA` | create | `{"anything":"here"}` | **DENY** (write to the parent doc is still fully denied — nothing should ever write there under the new model) |
| A10 | uid=`userA` | `/randomCollection/doc1` | get | — | **DENY** (default-deny for anything outside the known model) |

---

## B. sessions/{sessionId} — malformed writes

Path for all: `/users/userA/sessions/sess1`, auth uid=`userA`, op=create (or update).

| # | Document data | Expected | Why |
|---|---|---|---|
| B1 (valid, control) | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":1.5,"note":"chapter 4","createdAt":1754400000000,"updatedAt":1754400000000}` | **ALLOW** | Baseline valid record |
| B2 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math"}` | **DENY** | Missing required `hours` |
| B3 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":"3"}` | **DENY** | `hours` is a string, not a number |
| B4 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":-1}` | **DENY** | `hours` negative |
| B5 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":25}` | **DENY** | `hours` exceeds the 24h ceiling |
| B6 | `{"id":"WRONG-ID","date":"2026-08-05","subjectId":"default-math","hours":1}` | **DENY** | `id` field doesn't match the document's actual path id (`sess1`) |
| B7 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":1,"hacked":"value"}` | **DENY** | Undeclared extra top-level field |
| B8 | `{"id":"sess1","date":"08/05/2026","subjectId":"default-math","hours":1}` | **DENY** | `date` not in `YYYY-MM-DD` shape |

---

## C. subjects/{subjectId} — malformed writes

Path for all: `/users/userA/subjects/sub1`, auth uid=`userA`, op=create (or update).

| # | Document data | Expected | Why |
|---|---|---|---|
| C1 (valid, control) | `{"id":"sub1","name":"Math","color":"#4285F4","deleted":false,"updatedAt":1754400000000}` | **ALLOW** | Baseline valid record |
| C2 | `{"id":"sub1","name":"Math"}` | **DENY** | Missing required `color` |
| C3 | `{"id":"sub1","name":"Math","color":"blue"}` | **DENY** | `color` not `#RRGGBB` hex |
| C4 | `{"id":"sub1","name":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","color":"#4285F4"}` | **DENY** | `name` over 40 chars (this example is 43) |
| C5 | `{"id":"sub1","name":"","color":"#4285F4"}` | **DENY** | `name` empty string |

---

## D. examResults/{resultId} — malformed writes

Path for all: `/users/userA/examResults/res1`, auth uid=`userA`, op=create (or update).

| # | Document data | Expected | Why |
|---|---|---|---|
| D1 (valid, control) | `{"id":"res1","subjectId":"default-math","percentage":87.5,"date":"2026-08-05","examName":"Midterm 1"}` | **ALLOW** | Baseline valid record |
| D2 | `{"id":"res1","subjectId":"default-math","date":"2026-08-05"}` | **DENY** | Missing required `percentage` |
| D3 | `{"id":"res1","subjectId":"default-math","percentage":150,"date":"2026-08-05"}` | **DENY** | `percentage` over 100 |
| D4 | `{"id":"res1","subjectId":"default-math","percentage":-5,"date":"2026-08-05"}` | **DENY** | `percentage` negative |
| D5 | `{"id":"res1","subjectId":"default-math","percentage":90,"date":"Aug 5 2026"}` | **DENY** | `date` not in `YYYY-MM-DD` shape |
| D6 | `{"id":"res1","subjectId":"default-math","percentage":82,"date":"2026-08-05","highestScore":95}` | **ALLOW** | Valid `highestScore` |
| D7 | `{"id":"res1","subjectId":"default-math","percentage":82,"date":"2026-08-05","highestScore":null}` | **ALLOW** | `highestScore` explicitly `null` — flattenExamResults() in cloud-sync.js always writes this key, defaulting to null, so null must pass the same as an absent field |
| D8 | `{"id":"res1","subjectId":"default-math","percentage":82,"date":"2026-08-05","highestScore":150}` | **DENY** | `highestScore` over 100 |
| D9 | `{"id":"res1","subjectId":"default-math","percentage":82,"date":"2026-08-05","highestScore":"95"}` | **DENY** | `highestScore` is a string, not a number |

---

## E. meta/settings — malformed writes

Path for all: `/users/userA/meta/settings`, auth uid=`userA`, op=create (or update).

| # | Document data | Expected | Why |
|---|---|---|---|
| E1 (valid, control) | `{"goalHours":1,"milestonesAwarded":{"total":[10,50],"streak":[7]},"chartType":"line"}` | **ALLOW** | Baseline valid record |
| E2 | `{"goalHours":0,"milestonesAwarded":{"total":[],"streak":[]},"chartType":"bar"}` | **DENY** | `goalHours` must be `> 0` |
| E3 | `{"goalHours":25,"milestonesAwarded":{"total":[],"streak":[]},"chartType":"bar"}` | **DENY** | `goalHours` exceeds 24 |
| E4 | `{"goalHours":1,"milestonesAwarded":{"total":[],"streak":[]},"chartType":"pie"}` | **DENY** | `chartType` not `"bar"`/`"line"` |
| E5 | `{"goalHours":1,"milestonesAwarded":[],"chartType":"bar"}` | **DENY** | `milestonesAwarded` is a list, not a map |
| E6 | `{"goalHours":1,"milestonesAwarded":{"total":[],"streak":[]},"chartType":"bar","extra":"x"}` | **DENY** | Undeclared extra top-level field |

Also test the doc-id restriction:

| # | Path | Data | Expected |
|---|---|---|---|
| E7 | `/users/userA/meta/other` | same as E1's valid data | **DENY** — only the doc id `settings` is accepted under `meta/` |

---

## F. `_syncedAt` / `updatedAt` trust checks

Path: `/users/userA/sessions/sess1`, auth uid=`userA`, op=create.

| # | Document data | Expected | Why |
|---|---|---|---|
| F1 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":1,"_syncedAt":1577836800000}` | **DENY** | `_syncedAt` set to an arbitrary number instead of via `serverTimestamp()` — in the Playground UI, the only way to pass this check is to use the "Firestore server value" option for this field; any literal value you type will fail, which is the point |
| F2 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":1,"updatedAt":9999999999999}` | **DENY** | `updatedAt` far in the future (year ~2286) — exceeds the 5-minute clock-skew allowance |
| F3 | `{"id":"sess1","date":"2026-08-05","subjectId":"default-math","hours":1,"updatedAt":100}` | **DENY** | `updatedAt` below the year-2000 sanity floor |

---

## Notes for running these

- For the "control"/valid rows, use the current wall-clock time in epoch-ms for `updatedAt`/`createdAt` fields — the sample values above (`1754400000000` ≈ Aug 2025) are illustrative; if the rules playground's `request.time` is far from that, F2/F3-style bounds could make even the control rows fail on `updatedAt` alone. Recompute or just omit `updatedAt` in the control rows (it's optional) if timing becomes fiddly.
- A1–A10 should be re-run once per collection (sessions/subjects/examResults/meta) if you want full coverage rather than spot-checking on sessions alone — the ownership logic is identical across all four, so this is optional but cheap.
- **Not testable in the Rules Playground:** a second bug was found alongside these rules — cloud-sync.js was sending `updatedAt` as an explicit JavaScript `undefined` (not omitting the key) for any record that predates Phase 2b, which the Firestore SDK rejects client-side before a request is even sent. The rules correctly treat `updatedAt` as optional either way, so this wouldn't show up as a rules failure — it would only show up as a stuck "N changes pending sync" that never clears, with a console error on every retry. Now fixed in cloud-sync.js (`stripUndefinedFields`). If you want to verify this by hand: in the browser console with the app loaded and signed in, run `window.ReadingHoursApp.setState` isn't exposed for direct poking, so the simplest manual check is to import a very old backup JSON (pre-dating this project's `updatedAt` work) via the app's Import Data button and confirm the sync-details panel's "pending" count actually reaches 0 rather than staying stuck.

