  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
  import {
    getAuth, GoogleAuthProvider, signInWithPopup, signInWithCredential,
    signOut, onAuthStateChanged
  } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
  import {
    getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc,
    writeBatch, serverTimestamp
  } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

  const firebaseConfig = {
    apiKey: "AIzaSyDGDIVT0j8vfO_HfarkUdC1K8k_1mvQoDY",
    authDomain: "reading-hours-tracker.firebaseapp.com",
    projectId: "reading-hours-tracker",
    storageBucket: "reading-hours-tracker.firebasestorage.app",
    messagingSenderId: "831057101403",
    appId: "1:831057101403:web:68eb588bad4b83dbaff57e",
    measurementId: "G-DNGEPCSRJF"
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  // ---------------------------------------------------------------------
  // Data model (this rewrite)
  //
  //   users/{uid}/sessions/{sessionId}     one doc per study session
  //   users/{uid}/subjects/{subjectId}     one doc per subject, active OR
  //                                        deleted (deleted:true), so a
  //                                        deleted subject's name/color are
  //                                        still recoverable/inspectable
  //   users/{uid}/examResults/{resultId}   one doc per exam result
  //   users/{uid}/meta/settings            single doc: goalHours,
  //                                        milestonesAwarded, chartType
  //
  // Every doc gets an `updatedAt` server timestamp on write. This is *not*
  // yet used for conflict resolution (no merge logic in this phase — see
  // README notes in the chat) — it's there so a later phase can compare
  // "whoever wrote most recently wins" at the per-record level instead of
  // the whole-document level.
  //
  // flushQueue() below no longer writes the whole state on every change.
  // It diffs the current local state (via window.ReadingHoursApp.getState())
  // against an in-memory signature cache of what was last written, and
  // only touches the Firestore docs that actually changed.
  // ---------------------------------------------------------------------

  // ---- stable JSON stringify (key-order independent) so a record that
  // hasn't semantically changed never produces a "different" signature
  // just because object key insertion order shifted somewhere upstream.
  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + stableStringify(value[k]); }).join(",") + "}";
  }

  // ---- state shape (app.js) <-> record-map shape (Firestore) mapping ----

  // { date: [session,...] }  ->  { sessionId: {..session, date} }
  function flattenSessions(sessionsData) {
    const map = {};
    Object.keys(sessionsData || {}).forEach(function (date) {
      (sessionsData[date] || []).forEach(function (sess) {
        map[sess.id] = {
          id: sess.id,
          date: date,
          subjectId: sess.subjectId,
          hours: sess.hours,
          note: sess.note || "",
          createdAt: sess.createdAt || null,
          // Real local edit time (app.js, Phase 2b). Absent on records that
          // predate Phase 2b — handled as "no reliable timestamp" by the
          // merge logic below, not defaulted to 0/now.
          updatedAt: sess.updatedAt
        };
      });
    });
    return map;
  }

  function unflattenSessions(map) {
    const out = {};
    Object.keys(map).forEach(function (id) {
      const rec = map[id];
      if (!rec.date) return;
      if (!out[rec.date]) out[rec.date] = [];
      out[rec.date].push({
        id: rec.id,
        subjectId: rec.subjectId,
        hours: rec.hours,
        note: rec.note || "",
        createdAt: rec.createdAt || null,
        // Carry updatedAt back into local state on a cloud pull/merge, so
        // it survives round-trips instead of silently reverting this
        // record to "no timestamp" the next time it's compared.
        updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : undefined
      });
    });
    return out;
  }

  // subjects[] + deletedSubjects{} -> { subjectId: {..., deleted} }
  function flattenSubjects(subjects, deletedSubjects) {
    const map = {};
    (subjects || []).forEach(function (s) {
      map[s.id] = { id: s.id, name: s.name, color: s.color, deleted: false, updatedAt: s.updatedAt };
    });
    Object.keys(deletedSubjects || {}).forEach(function (id) {
      if (!map[id]) {
        map[id] = {
          id: id,
          name: deletedSubjects[id].name,
          color: deletedSubjects[id].color,
          deleted: true,
          updatedAt: deletedSubjects[id].updatedAt
        };
      }
    });
    return map;
  }

  function unflattenSubjects(map) {
    const subjects = [];
    const deletedSubjects = {};
    Object.keys(map).forEach(function (id) {
      const rec = map[id];
      const updatedAt = typeof rec.updatedAt === "number" ? rec.updatedAt : undefined;
      if (rec.deleted) {
        deletedSubjects[id] = { name: rec.name, color: rec.color, updatedAt: updatedAt };
      } else {
        subjects.push({ id: rec.id, name: rec.name, color: rec.color, updatedAt: updatedAt });
      }
    });
    return { subjects: subjects, deletedSubjects: deletedSubjects };
  }

  function flattenExamResults(examResults) {
    const map = {};
    (examResults || []).forEach(function (r) {
      map[r.id] = {
        id: r.id,
        subjectId: r.subjectId,
        examName: r.examName || "",
        percentage: r.percentage,
        date: r.date,
        createdAt: r.createdAt || null,
        updatedAt: r.updatedAt
      };
    });
    return map;
  }

  function unflattenExamResults(map) {
    return Object.keys(map).map(function (id) { return map[id]; });
  }

  // Firestore doc -> plain record (id + fields, minus the server-managed
  // updatedAt so it never pollutes signature comparisons or gets pushed
  // back into app.js's local state).
  function docToRecord(docSnap) {
    const data = docSnap.data() || {};
    const rec = Object.assign({}, data, { id: docSnap.id });
    // _syncedAt is Firestore's own server-write-time metadata (Phase 1),
    // separate from `updatedAt`, which is now real record data (the local
    // edit time from app.js, Phase 2b) and must NOT be stripped here.
    delete rec._syncedAt;
    return rec;
  }

  // ---------------------------------------------------------------------
  // In-memory "what did we last successfully write" cache, used to diff
  // against on every push so only changed records get written. This is
  // NOT persisted across reloads (that's the offline-queue phase, not
  // this one) — a fresh page load re-diffs against an empty cache, which
  // is wasteful (re-writes everything once) but not incorrect, since
  // Firestore set() on an unchanged doc is a harmless no-op write.
  // ---------------------------------------------------------------------
  const syncCache = { sessions: {}, subjects: {}, examResults: {}, meta: "" };

  function metaRecordFromState(state) {
    return {
      goalHours: state.goalHours,
      milestonesAwarded: state.milestonesAwarded,
      chartType: state.chartType
    };
  }

  // Seeds the signature cache from a known-good state (right after a pull,
  // or right after we determine there's nothing to push) so the *next*
  // local change only diffs real edits, not everything we just loaded.
  function seedSyncCacheFromState(state) {
    const sessionsMap = flattenSessions(state.sessionsData);
    const subjectsMap = flattenSubjects(state.subjects, state.deletedSubjects);
    const examMap = flattenExamResults(state.examResults);

    syncCache.sessions = {};
    Object.keys(sessionsMap).forEach(function (id) { syncCache.sessions[id] = stableStringify(sessionsMap[id]); });

    syncCache.subjects = {};
    Object.keys(subjectsMap).forEach(function (id) { syncCache.subjects[id] = stableStringify(subjectsMap[id]); });

    syncCache.examResults = {};
    Object.keys(examMap).forEach(function (id) { syncCache.examResults[id] = stableStringify(examMap[id]); });

    syncCache.meta = stableStringify(metaRecordFromState(state));
  }

  // Compares a current { id: record } map against the last-synced
  // signature cache for that collection. Returns which ids need a
  // set() (new or changed) and which need a delete() (present before,
  // gone now).
  function diffRecordMap(currentMap, lastSigMap) {
    const toWrite = {};
    const toDelete = [];
    Object.keys(currentMap).forEach(function (id) {
      const sig = stableStringify(currentMap[id]);
      if (lastSigMap[id] !== sig) toWrite[id] = currentMap[id];
    });
    Object.keys(lastSigMap).forEach(function (id) {
      if (!(id in currentMap)) toDelete.push(id);
    });
    return { toWrite: toWrite, toDelete: toDelete };
  }

  // Commits a list of {type:'set'|'delete', ref, data?, onSuccess} ops in
  // chunks of <=450 (Firestore batch limit is 500; leaving headroom).
  // Chunks commit sequentially — if one chunk fails, earlier chunks have
  // already been applied (and their sig-cache updates run), and the
  // remaining un-committed ops are simply left "dirty" so the next push
  // naturally retries them (their diff will still show as changed).
  function commitOpsChunked(ops) {
    const CHUNK_SIZE = 450;
    let chain = Promise.resolve();
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      chain = chain.then(function () {
        const batch = writeBatch(db);
        chunk.forEach(function (op) {
          if (op.type === "set") batch.set(op.ref, op.data);
          else batch.delete(op.ref);
        });
        return batch.commit().then(function () {
          chunk.forEach(function (op) { op.onSuccess(); });
        });
      });
    }
    return chain;
  }

  const signInBtn = document.getElementById("cloudSignInBtn");
  const signOutBtn = document.getElementById("cloudSignOutBtn");
  const cloudUserEl = document.getElementById("cloudUser");
  const cloudUserPhoto = document.getElementById("cloudUserPhoto");
  const cloudUserName = document.getElementById("cloudUserName");
  const cloudStatus = document.getElementById("cloudStatus");
  // Phase 4: sync-details toggle + panel.
  const cloudDetailsToggle = document.getElementById("cloudDetailsToggle");
  const cloudDetailsChevron = document.getElementById("cloudDetailsChevron");
  const cloudDetailsContent = document.getElementById("cloudDetailsContent");
  const cloudDetailsBody = document.getElementById("cloudDetailsBody");
  let cloudDetailsOpen = false;
  // Session-only (not persisted — resets on reload, unlike the Phase 3
  // queue, per the Phase 4 spec). lastSyncedAt: epoch ms of the last
  // successful write. lastMergeConflicts: conflicts from the most recent
  // syncOnSignIn() merge, each tagged with which collection it came from.
  let lastSyncedAt = null;
  let lastMergeConflicts = [];

  let currentUid = null;
  let pushTimer = null;
  let pushListenerRegistered = false;
  let applyingRemoteState = false;
  let flushInFlight = false; // guards against overlapping flush attempts (debounce + online event + app load can all fire close together)
  const PUSH_DEBOUNCE_MS = 1000;

  function setStatus(text, isWarning) {
    cloudStatus.textContent = text;
    cloudStatus.style.color = isWarning ? "#d93025" : "";
  }

  // ---------------------------------------------------------------------
  // Phase 4: sync-details panel. Purely a read of state Phases 1–3 already
  // compute (pendingQueue, lastSyncedAt, lastMergeConflicts) — does not
  // affect when anything syncs. Uses textContent (not innerHTML) since
  // record ids/reasons are assembled here, not sanitized elsewhere.
  // ---------------------------------------------------------------------
  function renderSyncDetails() {
    if (!cloudDetailsBody) return;
    cloudDetailsBody.innerHTML = "";

    function addLine(text) {
      const div = document.createElement("div");
      div.textContent = text;
      cloudDetailsBody.appendChild(div);
    }

    addLine("Last synced: " + (lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : "not yet"));

    const sessionsCount = Object.keys(pendingQueue.sessions).length;
    const subjectsCount = Object.keys(pendingQueue.subjects).length;
    const examCount = Object.keys(pendingQueue.examResults).length;
    const parts = [];
    if (sessionsCount) parts.push(sessionsCount + " session" + (sessionsCount === 1 ? "" : "s"));
    if (subjectsCount) parts.push(subjectsCount + " subject" + (subjectsCount === 1 ? "" : "s"));
    if (examCount) parts.push(examCount + " result" + (examCount === 1 ? "" : "s"));
    if (pendingQueue.meta) parts.push("settings");
    addLine("Pending: " + (parts.length ? parts.join(", ") : "up to date"));

    addLine("Recent conflict resolutions (last sign-in):");
    if (lastMergeConflicts.length === 0) {
      addLine("No conflicts in the last sign-in merge.");
    } else {
      const ul = document.createElement("ul");
      ul.className = "sync-detail-list";
      lastMergeConflicts.forEach(function (c) {
        const li = document.createElement("li");
        li.textContent = c.type + " " + c.id + ": kept " + c.winner + " — " + c.reason;
        ul.appendChild(li);
      });
      cloudDetailsBody.appendChild(ul);
    }
  }

  if (cloudDetailsToggle) {
    // Mirrors app.js's existing local-backup-toggle click pattern exactly
    // (native <button>, so Enter/Space already work via built-in button
    // activation — no separate keydown handler needed, same as app.js's
    // own comments note for its equivalent toggles). Written fresh here
    // rather than reused because app.js's toggle wiring (makeCardToggle,
    // toggleLocalBackupSection) is internal to its closure and not
    // exposed via window.ReadingHoursApp — see chat confirmation.
    cloudDetailsToggle.addEventListener("click", function () {
      cloudDetailsOpen = cloudDetailsContent.style.display === "none";
      cloudDetailsContent.style.display = cloudDetailsOpen ? "block" : "none";
      cloudDetailsToggle.setAttribute("aria-expanded", String(cloudDetailsOpen));
      if (cloudDetailsChevron) cloudDetailsChevron.classList.toggle("expanded", cloudDetailsOpen);
      if (cloudDetailsOpen) renderSyncDetails();
    });
  }

  // ---------------------------------------------------------------------
  // Phase 3: persistent offline write queue.
  //
  // Stored in localStorage, scoped per uid (so a queue never accidentally
  // gets flushed into a different account's data if the user signs out
  // and into another account on the same device without reloading).
  // Deliberately stores only DIRTY IDS per collection, not full record
  // snapshots — see chat notes for why (avoids ever replaying stale
  // content; the real content is always re-read live from
  // window.ReadingHoursApp.getState() at flush time).
  // ---------------------------------------------------------------------
  function queueStorageKey(uid) { return "readingHoursCloudSyncQueue:" + uid; }

  function loadPersistedQueue(uid) {
    try {
      const raw = localStorage.getItem(queueStorageKey(uid));
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        sessions: (parsed && parsed.sessions) || {},
        subjects: (parsed && parsed.subjects) || {},
        examResults: (parsed && parsed.examResults) || {},
        meta: !!(parsed && parsed.meta)
      };
    } catch (e) {
      console.warn("Could not read persisted sync queue, starting empty", e);
      return { sessions: {}, subjects: {}, examResults: {}, meta: false };
    }
  }

  function savePersistedQueue(uid, queue) {
    try {
      localStorage.setItem(queueStorageKey(uid), JSON.stringify(queue));
    } catch (e) {
      // Not fatal — the queue stays accurate in memory for this session;
      // it just won't survive a reload. Surfacing this would need its own
      // UI affordance, out of scope for this minimal status pass.
      console.warn("Could not persist sync queue", e);
    }
  }

  function queueSize(queue) {
    return Object.keys(queue.sessions).length + Object.keys(queue.subjects).length +
      Object.keys(queue.examResults).length + (queue.meta ? 1 : 0);
  }

  let pendingQueue = { sessions: {}, subjects: {}, examResults: {}, meta: false };

  function updateQueueStatus() {
    const n = queueSize(pendingQueue);
    if (n === 0) return; // leave whatever more specific status is already showing
    const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    const msg = n + " change" + (n === 1 ? "" : "s") + " pending sync" + (isOffline ? " — offline, will retry when reconnected" : "");
    setStatus((isOffline ? "📴 " : "☁️ ") + msg, isOffline);
  }

  // Computes the same local-vs-syncCache diff flushQueue used to compute
  // ad hoc, but now persists the result immediately (synchronous
  // localStorage write) instead of only holding it in memory until a
  // debounced write fires. This is what makes a change durable across a
  // tab close/crash even before the 1s debounce would have run.
  function markDirtyFromLiveState() {
    if (!window.ReadingHoursApp) return;
    const state = window.ReadingHoursApp.getState();
    const sessionsMap = flattenSessions(state.sessionsData);
    const subjectsMap = flattenSubjects(state.subjects, state.deletedSubjects);
    const examMap = flattenExamResults(state.examResults);
    const metaSig = stableStringify(metaRecordFromState(state));

    const sessionsDiff = diffRecordMap(sessionsMap, syncCache.sessions);
    const subjectsDiff = diffRecordMap(subjectsMap, syncCache.subjects);
    const examDiff = diffRecordMap(examMap, syncCache.examResults);

    Object.keys(sessionsDiff.toWrite).forEach(function (id) { pendingQueue.sessions[id] = true; });
    sessionsDiff.toDelete.forEach(function (id) { pendingQueue.sessions[id] = true; });
    Object.keys(subjectsDiff.toWrite).forEach(function (id) { pendingQueue.subjects[id] = true; });
    subjectsDiff.toDelete.forEach(function (id) { pendingQueue.subjects[id] = true; });
    Object.keys(examDiff.toWrite).forEach(function (id) { pendingQueue.examResults[id] = true; });
    examDiff.toDelete.forEach(function (id) { pendingQueue.examResults[id] = true; });
    if (metaSig !== syncCache.meta) pendingQueue.meta = true;

    savePersistedQueue(currentUid, pendingQueue);
    updateQueueStatus();
  }

  function queuePush() {
    if (!currentUid || applyingRemoteState || !window.ReadingHoursApp) return;
    // Requirement 1: record the pending change durably FIRST, immediately.
    markDirtyFromLiveState();
    // The debounce below only controls when we ATTEMPT the write — it no
    // longer controls whether the change is safe if the tab closes first.
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flushQueue, PUSH_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------
  // flushQueue: builds ops from the PERSISTED queue (not a fresh live
  // diff), reading each dirty id's current content from live state at
  // write time. Reuses commitOpsChunked() unchanged — same chunking and
  // same per-op onSuccess/partial-failure handling as Phase 1, just fed
  // from the queue instead of from an ad hoc diff.
  // ---------------------------------------------------------------------
  function flushQueue() {
    if (!currentUid || !window.ReadingHoursApp) return;
    if (flushInFlight) return; // another flush attempt is already in progress; queue stays durable either way
    if (queueSize(pendingQueue) === 0) return;

    const state = window.ReadingHoursApp.getState();
    const sessionsMap = flattenSessions(state.sessionsData);
    const subjectsMap = flattenSubjects(state.subjects, state.deletedSubjects);
    const examMap = flattenExamResults(state.examResults);
    const metaRecord = metaRecordFromState(state);
    const metaSig = stableStringify(metaRecord);

    const ops = [];

    // Firestore throws if any field in a write payload is explicitly
    // `undefined` (this Firestore instance doesn't set
    // ignoreUndefinedProperties). flattenSessions/flattenSubjects/
    // flattenExamResults deliberately set updatedAt: undefined for
    // records that predate Phase 2b (needed so merge logic can tell "no
    // timestamp" apart from "timestamp of 0") — that's correct for the
    // in-memory record used in signature comparisons, but would crash if
    // sent to Firestore as-is. This strips such keys from the WRITE
    // payload only; the original `rec` (with undefined intact) is still
    // what's used for syncCache signatures elsewhere, unchanged.
    function stripUndefinedFields(rec) {
      const copy = {};
      Object.keys(rec).forEach(function (k) {
        if (rec[k] !== undefined) copy[k] = rec[k];
      });
      return copy;
    }

    function buildOpsForCollection(liveMap, dirtyIds, collectionName, cacheKey) {
      Object.keys(dirtyIds).forEach(function (id) {
        const rec = liveMap[id];
        if (rec) {
          // Present locally -> write (covers both "new" and "edited since
          // last sync" — we don't need to distinguish, set() handles both).
          ops.push({
            type: "set",
            ref: doc(db, "users", currentUid, collectionName, id),
            data: Object.assign({}, stripUndefinedFields(rec), { _syncedAt: serverTimestamp() }),
            onSuccess: function () {
              syncCache[cacheKey][id] = stableStringify(rec);
              delete pendingQueue[cacheKey][id];
              savePersistedQueue(currentUid, pendingQueue);
            }
          });
        } else {
          // No longer present locally -> the local change was a deletion.
          ops.push({
            type: "delete",
            ref: doc(db, "users", currentUid, collectionName, id),
            onSuccess: function () {
              delete syncCache[cacheKey][id];
              delete pendingQueue[cacheKey][id];
              savePersistedQueue(currentUid, pendingQueue);
            }
          });
        }
      });
    }

    buildOpsForCollection(sessionsMap, pendingQueue.sessions, "sessions", "sessions");
    buildOpsForCollection(subjectsMap, pendingQueue.subjects, "subjects", "subjects");
    buildOpsForCollection(examMap, pendingQueue.examResults, "examResults", "examResults");

    if (pendingQueue.meta) {
      ops.push({
        type: "set",
        ref: doc(db, "users", currentUid, "meta", "settings"),
        data: Object.assign({}, metaRecord, { _syncedAt: serverTimestamp() }),
        onSuccess: function () {
          syncCache.meta = metaSig;
          pendingQueue.meta = false;
          savePersistedQueue(currentUid, pendingQueue);
        }
      });
    }

    if (ops.length === 0) return;

    const queueSizeBeforeFlush = queueSize(pendingQueue);
    flushInFlight = true;
    setStatus("☁️ Syncing " + ops.length + " change" + (ops.length === 1 ? "" : "s") + "…");

    commitOpsChunked(ops).then(function () {
      flushInFlight = false;
      // Requirement 3: partial failure — commitOpsChunked already only
      // ran onSuccess (which clears the queue entry) for ops in chunks
      // that actually committed, so anything still in pendingQueue here
      // genuinely still needs retrying.
      const remaining = queueSize(pendingQueue);
      if (remaining === 0) {
        setStatus("☁️ Synced · " + new Date().toLocaleTimeString());
      } else {
        updateQueueStatus();
      }
      lastSyncedAt = Date.now(); // reaching .then() means every queued op committed
      if (cloudDetailsOpen) renderSyncDetails();
    }).catch(function (err) {
      flushInFlight = false;
      console.error("Cloud sync (push) failed", err);
      // Nothing is lost: pendingQueue is untouched for whatever didn't
      // commit, and it's already durable on disk from
      // markDirtyFromLiveState(). Requirement 3: retried on the next
      // "online" event or app load.
      updateQueueStatus();
      // Some earlier chunk(s) may still have committed before the failure
      // (commitOpsChunked runs chunks sequentially) — if the queue shrank
      // at all, that's a real (partial) successful sync moment.
      if (queueSize(pendingQueue) < queueSizeBeforeFlush) lastSyncedAt = Date.now();
      if (cloudDetailsOpen) renderSyncDetails();
    });
  }

  // ---------------------------------------------------------------------
  // Phase 2b: record-level merge for first sign-in when BOTH local and
  // cloud have data.
  //   - id only local  -> keep, will be pushed
  //   - id only cloud  -> keep, pulled into local
  //   - id both, same content (ignoring updatedAt) -> no real conflict
  //   - id both, different content -> compare real updatedAt (now present
  //     on any record created/edited under app.js Phase 2b) and keep
  //     whichever is numerically newer. A record that predates Phase 2b
  //     (on either side) has no updatedAt at all — that side is treated
  //     as older than any side that DOES have one, same fallback as
  //     Phase 2. If BOTH sides lack a timestamp, or have the exact same
  //     one, that's genuinely ambiguous — not guessed at silently, just
  //     defaulted to cloud and clearly logged as a tie rather than framed
  //     as "newer edit wins" (see resolveConflict below).
  // ---------------------------------------------------------------------
  function effectiveUpdatedAt(rec) {
    return (rec && typeof rec.updatedAt === "number") ? rec.updatedAt : null;
  }

  function formatRelativeDiff(ms) {
    const sec = Math.round(Math.abs(ms) / 1000);
    if (sec < 60) return sec + "s";
    const min = Math.round(sec / 60);
    if (min < 60) return min + "m";
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + "h";
    return Math.round(hr / 24) + "d";
  }

  function stripUpdatedAt(rec) {
    const copy = Object.assign({}, rec);
    delete copy.updatedAt;
    return copy;
  }

  function resolveConflict(collectionLabel, id, localRec, cloudRec) {
    const localTs = effectiveUpdatedAt(localRec);
    const cloudTs = effectiveUpdatedAt(cloudRec);
    let winner, reason;

    if (localTs !== null && cloudTs !== null && localTs !== cloudTs) {
      winner = localTs > cloudTs ? "local" : "cloud";
      reason = formatRelativeDiff(localTs - cloudTs) + " newer";
    } else if (localTs !== null && cloudTs === null) {
      winner = "local";
      reason = "cloud copy predates updatedAt tracking (no cloud timestamp to compare)";
    } else if (localTs === null && cloudTs !== null) {
      winner = "cloud";
      reason = "local copy predates updatedAt tracking (no local timestamp to compare)";
    } else if (localTs !== null && cloudTs !== null && localTs === cloudTs) {
      winner = "cloud";
      reason = "identical timestamps — genuinely ambiguous, defaulted to cloud rather than guessed";
    } else {
      winner = "cloud";
      reason = "neither side has a timestamp — defaulted to cloud";
    }

    console.warn("[" + collectionLabel + "] conflict on " + id + ": kept " + winner + " edit — " + reason);
    return { winner: winner, reason: reason };
  }

  function mergeCollection(localMap, cloudMap, collectionLabel) {
    const merged = {};
    const localOnlyIds = [];
    const cloudOnlyIds = [];
    const conflicts = []; // [{ id, winner, reason }]
    const allIds = {};
    Object.keys(localMap).forEach(function (id) { allIds[id] = true; });
    Object.keys(cloudMap).forEach(function (id) { allIds[id] = true; });

    Object.keys(allIds).forEach(function (id) {
      const inLocal = Object.prototype.hasOwnProperty.call(localMap, id);
      const inCloud = Object.prototype.hasOwnProperty.call(cloudMap, id);

      if (inLocal && !inCloud) {
        merged[id] = localMap[id];
        localOnlyIds.push(id);
      } else if (!inLocal && inCloud) {
        merged[id] = cloudMap[id];
        cloudOnlyIds.push(id);
      } else {
        const sameContent = stableStringify(stripUpdatedAt(localMap[id])) === stableStringify(stripUpdatedAt(cloudMap[id]));
        if (sameContent) {
          merged[id] = cloudMap[id];
        } else {
          const resolution = resolveConflict(collectionLabel, id, localMap[id], cloudMap[id]);
          merged[id] = resolution.winner === "local" ? localMap[id] : cloudMap[id];
          conflicts.push({ id: id, type: collectionLabel, winner: resolution.winner, reason: resolution.reason });
        }
      }
    });

    return { merged: merged, localOnlyIds: localOnlyIds, cloudOnlyIds: cloudOnlyIds, conflicts: conflicts };
  }

  // Milestones are monotonic ("badges already earned"), so union rather
  // than pick-a-side — losing an earned badge on either side would be a
  // real regression, and unlike sessions/subjects/results there's no
  // meaningful sense in which one side's earned-badge list should
  // "overwrite" the other's.
  function unionMilestones(local, cloud) {
    const localM = local || { total: [], streak: [] };
    const cloudM = cloud || { total: [], streak: [] };
    return {
      total: Array.from(new Set((localM.total || []).concat(cloudM.total || []))),
      streak: Array.from(new Set((localM.streak || []).concat(cloudM.streak || [])))
    };
  }

  // Shared by the "local empty -> just pull" path and, indirectly, by the
  // merge path (which builds its own merged state instead of calling this,
  // but follows the same setState + seed pattern).
  function pullCloudIntoLocal(sessionsSnap, subjectsSnap, examSnap, metaSnap) {
    const sessionsMap = {};
    sessionsSnap.forEach(function (d) { sessionsMap[d.id] = docToRecord(d); });
    const subjectsMap = {};
    subjectsSnap.forEach(function (d) { subjectsMap[d.id] = docToRecord(d); });
    const examMap = {};
    examSnap.forEach(function (d) { examMap[d.id] = docToRecord(d); });
    const meta = metaSnap.exists() ? metaSnap.data() : {};
    const subjResult = unflattenSubjects(subjectsMap);

    const state = {
      subjects: subjResult.subjects,
      deletedSubjects: subjResult.deletedSubjects,
      sessionsData: unflattenSessions(sessionsMap),
      examResults: unflattenExamResults(examMap),
      goalHours: typeof meta.goalHours === "number" ? meta.goalHours : undefined,
      milestonesAwarded: meta.milestonesAwarded,
      chartType: meta.chartType
    };

    applyingRemoteState = true;
    window.ReadingHoursApp.setState(state);
    applyingRemoteState = false;
    seedSyncCacheFromState(window.ReadingHoursApp.getState());
  }

  // ---------------------------------------------------------------------
  // syncOnSignIn: reads local state AND the three subcollections + meta
  // doc before doing anything, then branches:
  //   - cloud has nothing            -> upload local as-is (unchanged)
  //   - local has nothing            -> pull cloud as-is (unchanged)
  //   - both have data               -> merge by record id (new)
  //
  // NOTE ON THE OLD DATA MODEL: unchanged from Phase 1 — an account that
  // synced under the old users/{uid} whole-doc model will look "empty"
  // under the new subcollection check. Detected and warned, not migrated
  // (see console.warn below) — still an open item, not addressed here.
  // ---------------------------------------------------------------------
  function syncOnSignIn(uid) {
    setStatus("☁️ Connecting…");

    if (!window.ReadingHoursApp) {
      setStatus("⚠️ App not ready — couldn't sync", true);
      return;
    }

    // Fresh bookkeeping for this account: syncCache is reset so nothing
    // leaks across an account switch on the same tab (it was previously
    // never reset, which was harmless in practice but not actually
    // correct). pendingQueue is loaded from THIS uid's own persisted
    // queue — any edits made while offline in a previous session for
    // this account resume from here (Phase 3).
    syncCache.sessions = {};
    syncCache.subjects = {};
    syncCache.examResults = {};
    syncCache.meta = "";
    pendingQueue = loadPersistedQueue(uid);
    lastMergeConflicts = []; // Phase 4: reset per sign-in; the localEmpty/cloudEmpty branches below have no merge to report, so this correctly reads as "no conflicts" for those too

    const localStateBefore = window.ReadingHoursApp.getState();

    Promise.all([
      getDocs(collection(db, "users", uid, "sessions")),
      getDocs(collection(db, "users", uid, "subjects")),
      getDocs(collection(db, "users", uid, "examResults")),
      getDoc(doc(db, "users", uid, "meta", "settings"))
    ]).then(function (results) {
      const sessionsSnap = results[0];
      const subjectsSnap = results[1];
      const examSnap = results[2];
      const metaSnap = results[3];

      const cloudEmpty = sessionsSnap.empty && subjectsSnap.empty && examSnap.empty && !metaSnap.exists();

      // Requirement 2: nothing in the cloud yet.
      if (cloudEmpty) {
        return getDoc(doc(db, "users", uid)).then(function (legacySnap) {
          if (legacySnap.exists()) {
            console.warn(
              "Found data under the old users/{uid} whole-doc sync model for this account, " +
              "but not under the new subcollections. It has NOT been migrated or deleted — " +
              "see cloud-sync.js syncOnSignIn() notes."
            );
            setStatus("⚠️ Found older-format cloud data that wasn't migrated — this device's data was backed up separately. See console.", true);
          } else {
            setStatus("☁️ Backing up this device's data to your account…");
          }
          // syncCache is already fully reset (see top of syncOnSignIn),
          // so with it empty, this marks every current local record as
          // dirty (a full initial backup) and persists that queue before
          // attempting the write, same durability guarantee as any other
          // change.
          markDirtyFromLiveState();
          flushQueue();
        });
      }

      // Requirement 3: nothing local yet — subjects are excluded from this
      // check since app.js always auto-seeds 5 DEFAULT_SUBJECTS on first
      // load even before any real use, so "local empty" means no sessions
      // and no exam results, regardless of subjects.
      const localEmpty =
        Object.keys(localStateBefore.sessionsData || {}).every(function (d) { return !(localStateBefore.sessionsData[d] || []).length; }) &&
        (localStateBefore.examResults || []).length === 0;

      if (localEmpty) {
        pullCloudIntoLocal(sessionsSnap, subjectsSnap, examSnap, metaSnap);
        // Local state was just replaced wholesale with the cloud's copy
        // (existing Phase 2 behavior for this branch — see the known,
        // separate caveat about subject-only edits in the chat notes).
        // Any queue entries from a previous offline session referred to
        // local data that no longer represents the user's state, so they
        // no longer mean anything useful to push — clear them rather than
        // let them linger and later overwrite what was just pulled.
        pendingQueue = { sessions: {}, subjects: {}, examResults: {}, meta: false };
        savePersistedQueue(uid, pendingQueue);
        setStatus("☁️ Loaded your synced data");
        return;
      }

      // Requirement 4: both sides have data — merge by record id.
      const localSessionsMap = flattenSessions(localStateBefore.sessionsData);
      const localSubjectsMap = flattenSubjects(localStateBefore.subjects, localStateBefore.deletedSubjects);
      const localExamMap = flattenExamResults(localStateBefore.examResults);

      const cloudSessionsMap = {};
      sessionsSnap.forEach(function (d) { cloudSessionsMap[d.id] = docToRecord(d); });
      const cloudSubjectsMap = {};
      subjectsSnap.forEach(function (d) { cloudSubjectsMap[d.id] = docToRecord(d); });
      const cloudExamMap = {};
      examSnap.forEach(function (d) { cloudExamMap[d.id] = docToRecord(d); });
      const cloudMeta = metaSnap.exists() ? metaSnap.data() : {};

      const sessionsMerge = mergeCollection(localSessionsMap, cloudSessionsMap, "sessions");
      const subjectsMerge = mergeCollection(localSubjectsMap, cloudSubjectsMap, "subjects");
      const examMerge = mergeCollection(localExamMap, cloudExamMap, "examResults");

      const mergedMeta = {
        goalHours: (metaSnap.exists() && typeof cloudMeta.goalHours === "number") ? cloudMeta.goalHours : localStateBefore.goalHours,
        chartType: (metaSnap.exists() && cloudMeta.chartType) ? cloudMeta.chartType : localStateBefore.chartType,
        milestonesAwarded: unionMilestones(localStateBefore.milestonesAwarded, metaSnap.exists() ? cloudMeta.milestonesAwarded : null)
      };

      const subjResult = unflattenSubjects(subjectsMerge.merged);
      const mergedState = {
        subjects: subjResult.subjects,
        deletedSubjects: subjResult.deletedSubjects,
        sessionsData: unflattenSessions(sessionsMerge.merged),
        examResults: unflattenExamResults(examMerge.merged),
        goalHours: mergedMeta.goalHours,
        milestonesAwarded: mergedMeta.milestonesAwarded,
        chartType: mergedMeta.chartType
      };

      // Requirement 5: write the merged result to local storage first.
      applyingRemoteState = true;
      window.ReadingHoursApp.setState(mergedState);
      applyingRemoteState = false;

      // Seed the signature cache from the canonical post-merge state (so
      // future diffs compare against what setState actually normalized),
      // then deliberately invalidate the entries that the cloud does NOT
      // yet have — the local-only ids, plus meta if the union changed it —
      // so the flushQueue() call below writes exactly those and nothing
      // else (not a full re-write of the merged state).
      const canonicalState = window.ReadingHoursApp.getState();
      seedSyncCacheFromState(canonicalState);

      // Local-only ids need pushing (cloud doesn't have them). Local-WON
      // conflicts also need pushing now — unlike Phase 2, cloud doesn't
      // automatically win every conflict anymore, so a fresher local edit
      // must be written back up or the cloud stays stale.
      //
      // Phase 3: this also reconciles any queue entries carried over from
      // a previous offline session (loaded into pendingQueue above). Every
      // such id is necessarily part of localSessionsMap/etc (app.js always
      // persists locally regardless of cloud queue state), so it was
      // already processed by mergeCollection above as either local-only or
      // one side of a conflict. Rebuilding pendingQueue fresh from the
      // merge outcome — rather than keeping the old entries — means an id
      // that LOST its conflict (cloud was genuinely newer) is correctly
      // dropped from the queue instead of being retried forever.
      pendingQueue.sessions = {};
      pendingQueue.subjects = {};
      pendingQueue.examResults = {};

      function invalidateForPush(merge, cacheKey) {
        merge.localOnlyIds.forEach(function (id) {
          delete syncCache[cacheKey][id];
          pendingQueue[cacheKey][id] = true;
        });
        merge.conflicts.forEach(function (c) {
          if (c.winner === "local") {
            delete syncCache[cacheKey][c.id];
            pendingQueue[cacheKey][c.id] = true;
          }
        });
      }
      invalidateForPush(sessionsMerge, "sessions");
      invalidateForPush(subjectsMerge, "subjects");
      invalidateForPush(examMerge, "examResults");

      const rawCloudMetaSig = stableStringify({
        goalHours: metaSnap.exists() ? cloudMeta.goalHours : undefined,
        milestonesAwarded: metaSnap.exists() ? cloudMeta.milestonesAwarded : undefined,
        chartType: metaSnap.exists() ? cloudMeta.chartType : undefined
      });
      pendingQueue.meta = false;
      if (syncCache.meta !== rawCloudMetaSig) {
        // Merged meta (e.g. a milestones union) differs from what's
        // actually stored in Firestore — force the next push to include it.
        syncCache.meta = "";
        pendingQueue.meta = true;
      }

      savePersistedQueue(uid, pendingQueue);

      // Requirement 6: status reflects what actually happened, including
      // which side won each conflict (no longer always "cloud").
      const totalLocalOnly = sessionsMerge.localOnlyIds.length + subjectsMerge.localOnlyIds.length + examMerge.localOnlyIds.length;
      const totalCloudOnly = sessionsMerge.cloudOnlyIds.length + subjectsMerge.cloudOnlyIds.length + examMerge.cloudOnlyIds.length;
      const allConflicts = sessionsMerge.conflicts.concat(subjectsMerge.conflicts, examMerge.conflicts);
      const totalConflicts = allConflicts.length;
      const localWinCount = allConflicts.filter(function (c) { return c.winner === "local"; }).length;
      const cloudWinCount = totalConflicts - localWinCount;

      let summary = "Merged " + totalLocalOnly + " local + " + totalCloudOnly + " cloud " +
        ((totalLocalOnly + totalCloudOnly) === 1 ? "entry" : "entries");
      if (totalConflicts > 0) {
        const parts = [];
        if (localWinCount > 0) parts.push(localWinCount + " kept local");
        if (cloudWinCount > 0) parts.push(cloudWinCount + " kept cloud");
        summary += " — " + totalConflicts + " conflict" + (totalConflicts === 1 ? "" : "s") +
          " resolved (" + parts.join(", ") + ")";
      }
      setStatus("☁️ " + summary);
      // Per-conflict detail (which record, which side, how much newer) is
      // already logged individually to console by resolveConflict() above
      // as each one is decided. Phase 4: also keep it in memory for the
      // sync-details panel (session-only — resets on reload, unlike the
      // Phase 3 queue).
      lastMergeConflicts = allConflicts;
      if (cloudDetailsOpen) renderSyncDetails();

      if (queueSize(pendingQueue) > 0) {
        flushQueue();
      }
    }).catch(function (err) {
      console.error("Cloud sync (initial) failed", err);
      setStatus("⚠️ Couldn't reach the cloud — still saved on this device", true);
    });
  }

  // ---------------------------------------------------------------------
  // Google One Tap (unchanged from before)
  // ---------------------------------------------------------------------
  const GOOGLE_ONE_TAP_CLIENT_ID = "831057101403-je6i9utanal29puihtbf5ljlqj3a1b5d.apps.googleusercontent.com";
  let oneTapInitialized = false;

  function handleOneTapCredential(response) {
    setStatus("☁️ Opening sign-in…");
    const credential = GoogleAuthProvider.credential(response.credential);
    signInWithCredential(auth, credential).catch(function (err) {
      console.error("One Tap sign-in failed", err);
      setStatus("⚠️ Sign-in failed. Try again.", true);
    });
  }

  function tryShowOneTap() {
    if (currentUid) return;
    const gsi = window.google && window.google.accounts && window.google.accounts.id;
    if (!gsi) return;
    if (!oneTapInitialized) {
      try {
        gsi.initialize({
          client_id: GOOGLE_ONE_TAP_CLIENT_ID,
          callback: handleOneTapCredential,
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: true
        });
        oneTapInitialized = true;
      } catch (e) {
        console.warn("One Tap unavailable", e);
        return;
      }
    }
    try {
      gsi.prompt();
    } catch (e) {
      console.warn("One Tap prompt failed", e);
    }
  }

  onAuthStateChanged(auth, function (user) {
    if (user) {
      currentUid = user.uid;
      signInBtn.style.display = "none";
      signOutBtn.style.display = "block";
      cloudUserEl.style.display = "flex";
      cloudUserName.textContent = user.displayName || user.email || "Signed in";
      if (user.photoURL) {
        cloudUserPhoto.src = user.photoURL;
        cloudUserPhoto.style.display = "";
      } else {
        cloudUserPhoto.style.display = "none";
      }
      if (window.google && window.google.accounts && window.google.accounts.id) {
        try { window.google.accounts.id.cancel(); } catch (e) { /* no-op */ }
      }
      syncOnSignIn(user.uid);
      if (window.ReadingHoursApp && !pushListenerRegistered) {
        window.ReadingHoursApp.onCloudChange(queuePush);
        pushListenerRegistered = true;
      }
    } else {
      currentUid = null;
      signInBtn.style.display = "flex";
      signOutBtn.style.display = "none";
      cloudUserEl.style.display = "none";
      pendingQueue = { sessions: {}, subjects: {}, examResults: {}, meta: false };
      setStatus("Signed out — using this device's storage only");
      tryShowOneTap();
    }
  });

  window.addEventListener("load", function () {
    setTimeout(tryShowOneTap, 300);
  });

  // Requirement 3: reconnect triggers a flush attempt. (App load is
  // already covered — Firebase Auth persists sessions across reloads and
  // fires onAuthStateChanged automatically, which runs syncOnSignIn ->
  // loads this uid's persisted queue -> flushes it via the branches
  // above, so no separate "on load, if signed in" check is needed here.)
  window.addEventListener("online", function () {
    if (currentUid) flushQueue();
  });
  window.addEventListener("offline", function () {
    if (currentUid) updateQueueStatus();
  });

  signInBtn.addEventListener("click", function () {
    setStatus("☁️ Opening sign-in…");
    signInWithPopup(auth, provider).catch(function (err) {
      console.error("Sign-in popup failed", err);
      if (err && err.code === "auth/popup-blocked") {
        setStatus("⚠️ Popup blocked — allow popups for this site, then tap Sign in again.", true);
      } else if (err && (err.code === "auth/cancelled-popup-request" || err.code === "auth/popup-closed-by-user")) {
        setStatus("Signed out — using this device's storage only");
      } else {
        setStatus("⚠️ Sign-in failed. Try again.", true);
      }
    });
  });

  signOutBtn.addEventListener("click", function () {
    signOut(auth).catch(function (err) {
      console.error("Sign-out failed", err);
    });
  });
