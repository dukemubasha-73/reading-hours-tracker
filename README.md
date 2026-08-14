# Reading Hours Tracker — Project Reference

Read this file first. It's meant to answer "what does this codebase do and how
is it built" without re-reading all ~7,600 lines of source. Only read the
actual files when you need to change something this doc doesn't cover in
enough detail, or when this doc looks stale (check `sw.js`'s CACHE_VERSION
against what you'd expect — if it's higher than this doc mentions, treat this
doc as out of date and regenerate it).

## What this is

A single-page PWA ("Study Hour Tracker" / "Reading Hours Tracker") for
logging study sessions per subject, tracking a daily hours goal + streak,
recording exam results, and charting progress over time. Works fully offline
(localStorage), with optional Google-account cloud sync (Firestore) across
devices.

## Files and their roles

| File | Role |
|---|---|
| `index.html` | Markup + two small inline `<script>` blocks (anti-FOUC theme init that must run synchronously before paint; a tiny post-load block). Loads Chart.js, Google Identity Services, `app.js`, then `cloud-sync.js` as an ES module. |
| `app.js` (~4,200 lines) | The entire app: state, localStorage persistence, all rendering, all UI event handlers. One big IIFE, `function` expressions throughout (no arrow functions — deliberate style consistency), `const`/`let`. Exposes `window.ReadingHoursApp = { getState, setState, onCloudChange }` as the bridge cloud-sync.js uses. |
| `cloud-sync.js` (~1,040 lines) | ES module. Firebase Auth (Google sign-in) + Firestore sync: push local changes, pull remote changes, merge on sign-in, offline queue with retry. Talks to `app.js` only through `window.ReadingHoursApp`. |
| `styles.css` (~1,720 lines) | All styling. CSS custom properties for light/dark theming (`:root` + `[data-theme="dark"]` overrides), no build step/preprocessor. |
| `sw.js` | Service worker, cache-first for static assets, network-first-ish for navigations. **`CACHE_VERSION` must be bumped on every deploy that touches `app.js`/`cloud-sync.js`/`index.html`/`styles.css`, or returning visitors keep the old cached versions indefinitely.** Currently `reading-hours-v36` — check the running file for the true current value. |
| `manifest.json` | PWA manifest. Rarely changes. |
| `firestore.rules` | Firestore security rules — deployed separately via Firebase Console (Firestore → Rules tab) or `firebase deploy --only firestore:rules`. **Not** part of the web asset upload; forgetting to deploy this after a data-model change (like adding a new synced field) breaks cloud sync silently (writes get rejected, app still works locally). |

## Data model

### localStorage keys (all under `app.js`, prefixed `readingHours*` unless noted)
- `readingHoursSubjects`, `readingHoursDeletedSubjects` — subjects (soft-delete via a `deleted` flag, not actually removed, so old sessions referencing a deleted subject still resolve)
- `readingHoursSessionsV2` — sessions, keyed by date. (`readingHoursData`/`readingHoursTitles` are the pre-migration legacy shape; `readingHoursMigratedToSessionsV2` is a one-time migration flag.)
- `readingHoursExamResults`
- `readingHoursGoal` — Daily Goal, hours, default 1, range (0, 24]
- `readingHoursStreakMinimum` — Streak Minimum, hours, default = 50% of goal rounded to nearest 0.25, range [0.25, 24] (`STREAK_MINIMUM_MIN`/`MAX` constants)
- `readingHoursMilestonesAwarded` — `{ total: [...], streak: [...] }`, which milestone badges have already fired
- `readingHoursChartType`, `readingHoursPerformanceRange`, `readingHoursPerformanceChartType`, `readingHoursHighestVsChartVisible` — UI/chart preferences
- `readingHoursTheme`, `readingHoursActiveSection` — UI state
- `readingHoursTimerState` — in-progress session timer (survives reload)
- `streakRiskDismissedDate` (sessionStorage, not localStorage) — per-day dismissal of the streak-at-risk banner
- `linkedFile` — legacy, largely vestigial

### Firestore (cloud sync), under `users/{uid}/`
- `sessions/{sessionId}`, `subjects/{subjectId}`, `examResults/{resultId}` — one doc per record, flattened/unflattened by `cloud-sync.js`
- `meta/settings` — single doc, always written as a full replace (`set()`, not merge): `{ goalHours, streakMinimum, milestonesAwarded, chartType, _syncedAt }`. `firestore.rules`' `isValidMeta()` requires exactly these keys (`hasAll` + `hasOnly`) — **adding any new synced setting requires updating both `metaRecordFromState()` in cloud-sync.js AND `isValidMeta()` in firestore.rules together**, or every meta push starts failing.
- The old parent `users/{uid}` doc is a legacy pre-subcollection format; read-only detection logic exists for it, nothing writes there anymore.

## Core logic map (app.js)

- **Streak**: `computeDailyTotals()` sums each day's sessions. `computeStats()` (current streak) and `computeBestStreak()` (all-time best) both take an optional `threshold` param defaulting to the live `streakMinimum`; a day counts toward the streak only if `total >= threshold`. `previewStreaksWithMinimum(candidate)` runs the same calc against a hypothetical new value without mutating state — used to show real before/after numbers in the "change streak minimum" confirmation dialog.
- **Daily Goal**: `renderGoalProgress()` — progress bar, `goal-complete`/`streak-safe` visual states, the "Goal: Xh · Streak needs: Yh" meta line, and the one-shot celebration (CSS pulse + firework particle burst, both gated by `wasGoalComplete` — seeded from actual stored data at startup, not `false`, so reopening the app after already hitting the goal doesn't replay the celebration).
- **Streak-at-risk banner**: `updateStreakRiskBanner()` — after 6 PM (`RISK_HOUR`), if today's total is still under `streakMinimum` and there's an active streak, shows how many more hours are needed.
- **Milestones**: `checkAndAwardMilestones()` / `queueMilestoneToast()` — one-time badge toasts for total-hours and streak-length thresholds, tracked in `MILESTONES_KEY` so they don't refire.
- **Export/Import**: `buildExportPayload()` (JSON, `version: 5`, includes `goalHours`/`streakMinimum`/everything) and `parseImportFile()`/`performImport()` (handles both the JSON export shape and CSV).
- **Timer**: `startTimer`/`pauseTimer`/`resumeTimer` + `saveTimerState`/`loadSavedTimerState` so an in-progress session survives a reload; optional browser notifications for long sessions.
- **Modal pattern**: one shared `openModal(title, text, confirmLabel, onConfirm, onCancel, secondary)` / `closeModal()` / `cancelModal()` — `onConfirm` must call `closeModal()` itself (not automatic); `cancelModal()` is wired to the Cancel button, backdrop click, and Escape, and always fires `onCancel`. `.modal-text` supports `\n` line breaks (`white-space: pre-line`) for multi-line bodies like the streak-minimum before/after confirmation.
- **Debounced autosave**: `scheduleAutoSave()` — inline debounce, separate from `cloud-sync.js`'s own `queuePush`/`flushQueue` debounce (intentionally not shared — different modules, no bundler).

## Cloud sync (cloud-sync.js)

- Bridge: `window.ReadingHoursApp.getState()`/`setState(state)` — the only contact points with `app.js`.
- On sign-in (`syncOnSignIn`): reads local + cloud, branches on which is empty, otherwise merges by record id (`mergeCollection`) using `updatedAt` for conflict resolution, and `unionMilestones` for the milestones list specifically.
- Ongoing sync: `queuePush()` batches dirty records (sessions/subjects/examResults are per-id diffed; meta is one signature-diffed blob) and writes them; `pullCloudIntoLocal()` handles incoming remote snapshots.
- Offline: `pendingQueue` persists to localStorage per-uid so queued edits survive a reload before they've synced.
- `stableStringify()` — key-order-independent JSON serialization used for change-signature comparisons (custom because no native equivalent exists for this).

## Known conventions / gotchas

- No arrow functions anywhere in `app.js`/`cloud-sync.js` — keep new code consistent with the existing `function(){}` style.
- `roundTo`, `toISODate`, `computeDailyTotals`, etc. are `function` declarations (hoisted) — safe to call from code physically earlier in the file (used deliberately for the `wasGoalComplete` startup seed).
- `toISODate` is used instead of `Date.prototype.toISOString()` deliberately — `toISOString()` converts to UTC, which shifts the date near local midnight.
- Every `localStorage`-backed setting has a `load*`/`save*` pair following the same shape; new settings should follow it (parse + range-validate on load, falling back to a sensible default; write raw on save).
- **Any new setting that should sync across devices touches four places**: `app.js`'s `getState()`/`setState()`, `cloud-sync.js`'s `metaRecordFromState()` + `pullCloudIntoLocal()` + the sign-in merge + the cache-signature check, AND `firestore.rules`' `isValidMeta()`. Missing any one of these causes a silent partial failure (usually: rules reject the write, or the value doesn't survive a fresh sign-in pull).
- **Every deploy that touches JS/HTML/CSS needs `sw.js`'s `CACHE_VERSION` bumped**, or returning visitors keep serving stale cached files indefinitely.
- `firestore.rules` deploys separately from the web files, via the Firebase Console or CLI — not part of a normal file upload.

## Recent feature history (most recent first)

- **Firework celebration** — CSS particle-burst (`.firework`/`.progress-wrap` in styles.css + index.html, trigger in app.js's `renderGoalProgress`) added alongside the existing goal-complete pulse. GPU-only (`transform`/`opacity`), one shared `@keyframes` parameterized per-particle via custom properties. Respects `prefers-reduced-motion`.
- **Dual Target Streak System** — added Streak Minimum (see Data model/Core logic above) as a setting independent of Daily Goal. Chose "Approach A": single global value, streaks always computed live against it (changing it recalculates history), with a confirmation dialog showing real before/after streak numbers rather than a historical per-day snapshot approach (rejected as unnecessary complexity for this app's scale).
- **Performance graph card redesign** — fixed "Graph" header, range selector as primary control, softened type toggle, compact subject-picker chip, taller chart area.

## Known open items / accepted edge cases (not bugs to "fix" without discussion)

- If `Streak Minimum > Daily Goal`, a day can hit the goal (green bar + celebration) while still being below the streak minimum (risk banner also showing) — both are individually correct per spec (goal visuals are goal-only, banner is streak-minimum-only) but can look contradictory together. Not resolved; options were discussed but a decision was deferred.
- `firestore.rules`' milestone-array validation is shallow (checks it's a list under a size cap, not that every element is actually a number) — accepted as low-risk since it's just badge markers.
- An account that synced under the pre-Phase-1 whole-doc Firestore model (before the `sessions`/`subjects`/`examResults`/`meta` subcollection split) is detected and warned about on sign-in, not auto-migrated.
