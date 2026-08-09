(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Auto-save-to-file state — declared first, before any data-loading code
  // below (which can trigger a save/scheduleAutoSave call during startup
  // migration) has a chance to reference these.
  // ---------------------------------------------------------------------
  const AUTOSAVE_SUPPORTED = "showSaveFilePicker" in window && "indexedDB" in window;
  const LINK_DB_NAME = "readingHoursFileLink";
  const LINK_STORE_NAME = "handles";
  const LINK_KEY = "linkedFile";
  const AUTOSAVE_DEBOUNCE_MS = 500;

  let linkedFileHandle = null;
  let autoSaveTimer = null;
  let autoSaveInFlight = false;
  let autoSavePending = false;

  // ---------------------------------------------------------------------
  // Storage keys
  //
  // ⚠️ PERMANENT CONTRACT — read this before changing anything below.
  // Every string value here is a real key already sitting in real users'
  // browser localStorage. Renaming, removing, or reusing any of these
  // string values in a future update does NOT delete the old data (it
  // stays harmlessly in the browser) — it just makes the app stop finding
  // it, which looks identical to data loss from the user's side (subjects,
  // sessions, exam results, goal, etc. would silently reset to defaults).
  //
  // Safe to do:
  //   - Add a brand-new key for a brand-new feature.
  //   - Add new fields inside an existing key's JSON value (old code
  //     ignored fields it didn't know about anyway).
  //
  // NOT safe without a one-time migration function (see
  // migrateLegacyDataIfNeeded() below for the pattern already used once):
  //   - Changing what a key's string literal is.
  //   - Changing the shape/meaning of the JSON already stored under a key
  //     in a way older data wouldn't satisfy.
  // ---------------------------------------------------------------------
  const SUBJECTS_KEY = "readingHoursSubjects";
  const DELETED_SUBJECTS_KEY = "readingHoursDeletedSubjects";
  const SESSIONS_KEY = "readingHoursSessionsV2";
  const MIGRATION_FLAG_KEY = "readingHoursMigratedToSessionsV2";
  // Performance section: logged exam results, keyed independently of study
  // sessions but sharing the same Subjects list (SUBJECTS_KEY above).
  const EXAM_RESULTS_KEY = "readingHoursExamResults";

  // Legacy (pre-subjects) keys — read only, used to migrate old data on
  // first load under the new model. Never written to again after that.
  const LEGACY_DATA_KEY = "readingHoursData";
  const LEGACY_TITLES_KEY = "readingHoursTitles";

  const GOAL_KEY = "readingHoursGoal";
  const DEFAULT_GOAL_HOURS = 1;
  // Which milestones have already triggered a badge toast, so the same
  // milestone never fires twice (e.g. after editing entries back and forth).
  const MILESTONES_KEY = "readingHoursMilestonesAwarded";
  const TOTAL_HOUR_MILESTONES = [10, 50, 100, 250];
  const STREAK_DAY_MILESTONES = [7, 30, 100];
  // Remembers whether the user prefers the bar or line chart style.
  const CHART_TYPE_KEY = "readingHoursChartType";
  const VALID_CHART_TYPES = ["bar", "line"];
  const DEFAULT_CHART_TYPE = "bar";
  // Remembers the Overall Performance chart's range selection ("5" / "10" / "all").
  const PERFORMANCE_RANGE_KEY = "readingHoursPerformanceRange";
  const VALID_PERFORMANCE_RANGES = ["5", "10", "all"];
  const DEFAULT_PERFORMANCE_RANGE = "10";
  // Remembers whether the "Highest vs You" chart is expanded or collapsed.
  const HIGHEST_VS_CHART_VISIBLE_KEY = "readingHoursHighestVsChartVisible";

  // Fallback color used when a session's subject has been deleted.
  const NEUTRAL_COLOR = "#9aa0a6";

  const DEFAULT_SUBJECTS = [
    { id: "default-math", name: "Math", color: "#4285F4", updatedAt: 0 },
    { id: "default-physics", name: "Physics", color: "#AB47BC", updatedAt: 0 },
    { id: "default-reading", name: "Reading", color: "#26A69A", updatedAt: 0 },
    { id: "default-history", name: "History", color: "#FF7043", updatedAt: 0 },
    { id: "default-english", name: "English", color: "#66BB6A", updatedAt: 0 }
  ];

  const NICE_COLOR_PALETTE = ["#4285F4", "#AB47BC", "#26A69A", "#FF7043", "#66BB6A", "#EC407A", "#7E57C2", "#FFCA28", "#42A5F5", "#8D6E63"];

  function randomNiceColor() {
    return NICE_COLOR_PALETTE[Math.floor(Math.random() * NICE_COLOR_PALETTE.length)];
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------
  function loadSubjects() {
    try {
      const raw = localStorage.getItem(SUBJECTS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse stored subjects, resetting.", e);
    }
    const defaults = DEFAULT_SUBJECTS.map(function (s) { return Object.assign({}, s); });
    saveSubjects(defaults);
    return defaults;
  }

  function saveSubjects(list) {
    localStorage.setItem(SUBJECTS_KEY, JSON.stringify(list));
    scheduleAutoSave();
  }

  function loadDeletedSubjects() {
    try {
      const raw = localStorage.getItem(DELETED_SUBJECTS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("Failed to parse deleted subjects, resetting.", e);
      return {};
    }
  }

  function saveDeletedSubjects(map) {
    localStorage.setItem(DELETED_SUBJECTS_KEY, JSON.stringify(map));
  }

  function loadSessions() {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("Failed to parse stored sessions, resetting.", e);
      return {};
    }
  }

  function saveSessions(data) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(data));
    scheduleAutoSave();
  }

  function loadExamResults() {
    try {
      const raw = localStorage.getItem(EXAM_RESULTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error("Failed to parse stored exam results, resetting.", e);
      return [];
    }
  }

  function saveExamResults(list) {
    localStorage.setItem(EXAM_RESULTS_KEY, JSON.stringify(list));
    scheduleAutoSave();
  }

  function loadGoalHours() {
    const raw = localStorage.getItem(GOAL_KEY);
    const val = parseFloat(raw);
    // Clamp to the valid range (0, 24]. Anything outside falls back / caps.
    if (isNaN(val) || val <= 0) return DEFAULT_GOAL_HOURS;
    if (val > 24) return 24;
    return val;
  }

  function saveGoalHours(hours) {
    localStorage.setItem(GOAL_KEY, String(hours));
    scheduleAutoSave();
  }

  function loadChartType() {
    const raw = localStorage.getItem(CHART_TYPE_KEY);
    return VALID_CHART_TYPES.indexOf(raw) !== -1 ? raw : DEFAULT_CHART_TYPE;
  }

  function saveChartType(type) {
    localStorage.setItem(CHART_TYPE_KEY, type);
  }

  function loadPerformanceRange() {
    const raw = localStorage.getItem(PERFORMANCE_RANGE_KEY);
    return VALID_PERFORMANCE_RANGES.indexOf(raw) !== -1 ? raw : DEFAULT_PERFORMANCE_RANGE;
  }

  function savePerformanceRange(range) {
    localStorage.setItem(PERFORMANCE_RANGE_KEY, range);
  }

  // One-time migration: converts any old single-number-per-day entries
  // (readingHoursData / readingHoursTitles) into a single session per day
  // under the new multi-session model. Runs at most once, ever.
  function migrateLegacyDataIfNeeded() {
    if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;

    let legacyData = {};
    let legacyTitles = {};
    try { legacyData = JSON.parse(localStorage.getItem(LEGACY_DATA_KEY) || "{}"); } catch (e) { legacyData = {}; }
    try { legacyTitles = JSON.parse(localStorage.getItem(LEGACY_TITLES_KEY) || "{}"); } catch (e) { legacyTitles = {}; }

    // Prefer the "Reading" default subject for migrated entries, since this
    // app started life as a reading-only tracker; fall back to whatever
    // subject happens to be first if that default isn't present.
    const preferred = subjects.find(function (s) { return s.id === "default-reading"; }) || subjects[0];

    if (preferred) {
      Object.keys(legacyData).forEach(function (date) {
        const hours = parseFloat(legacyData[date]);
        if (isNaN(hours) || hours <= 0) return;
        if (!sessionsData[date]) sessionsData[date] = [];
        sessionsData[date].push({
          id: generateId(),
          subjectId: preferred.id,
          hours: roundTo(hours, 2),
          note: legacyTitles[date] ? String(legacyTitles[date]).slice(0, 200) : "",
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      });
      saveSessions(sessionsData);
    }

    localStorage.setItem(MIGRATION_FLAG_KEY, "1");
  }

  // On first run under this feature, silently treat any milestones already
  // met by existing history as "awarded" so upgrading doesn't immediately
  // dump a pile of celebration toasts for progress that already happened.
  function loadMilestones() {
    try {
      const raw = localStorage.getItem(MILESTONES_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse stored milestones, resetting.", e);
    }
    const stats = computeStats();
    const initial = {
      total: TOTAL_HOUR_MILESTONES.filter(function (t) { return stats.total >= t; }),
      streak: STREAK_DAY_MILESTONES.filter(function (t) { return stats.streak >= t; })
    };
    saveMilestones(initial);
    return initial;
  }

  function saveMilestones(milestones) {
    localStorage.setItem(MILESTONES_KEY, JSON.stringify(milestones));
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let subjects = loadSubjects();
  let deletedSubjects = loadDeletedSubjects();
  let sessionsData = loadSessions();
  migrateLegacyDataIfNeeded();

  let examResults = loadExamResults();
  let editingExamResult = null; // id of the exam result being edited, or null
  let currentOverallRange = loadPerformanceRange(); // "5" | "10" | "all"
  let currentSubjectChartId = null;                 // subject id shown in the By Subject chart
  let overallChartInstance = null;
  let subjectChartInstance = null;
  let highestVsChartInstance = null;

  let goalHours = loadGoalHours();
  let wasGoalComplete = false;  // tracks false→true crossing for the goal-celebration animation
  let editingSession = null;    // { date, id } | null
  let currentRange = 14;
  let currentChartType = loadChartType();
  let expandedDates = new Set();
  // Populated after computeStats() is defined below (function declarations
  // are hoisted, so calling it here from loadMilestones() is safe).
  let milestonesAwarded = loadMilestones();

  // Callbacks registered by the cloud-sync module script (see bottom of
  // page). Notified after every local data change so a signed-in session
  // can push the update to Firestore. Empty/no-ops while signed out.
  const cloudChangeListeners = [];

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const dateInput = document.getElementById("dateInput");
  const hoursInput = document.getElementById("hoursInput");
  const subjectSelectInput = document.getElementById("subjectSelectInput");
  const noteInput = document.getElementById("noteInput");
  const addBtn = document.getElementById("addBtn");
  const editActions = document.getElementById("editActions");
  const saveEditBtn = document.getElementById("saveEditBtn");
  const cancelEditBtn = document.getElementById("cancelEditBtn");
  const editBanner = document.getElementById("editBanner");
  const clearBtn = document.getElementById("clearBtn");
  const localBackupToggle = document.getElementById("localBackupToggle");
  const localBackupContent = document.getElementById("localBackupContent");
  const localBackupChevron = document.getElementById("localBackupChevron");
  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");
  const importFile = document.getElementById("importFile");
  const linkFileBtn = document.getElementById("linkFileBtn");
  const autoSaveRow = document.getElementById("autoSaveRow");
  const autoSaveStatusEl = document.getElementById("autoSaveStatus");
  const entriesList = document.getElementById("entriesList");
  const entryCount = document.getElementById("entryCount");
  const chartRange = document.getElementById("chartRange");
  const chartTitle = document.getElementById("chartTitle");
  const rangeButtons = document.querySelectorAll("#studyRangeSelector .range-btn");
  const chartTypeButtons = document.querySelectorAll(".chart-type-btn");
  const chartWrap = document.getElementById("chartWrap");
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toastMsg");
  const confirmOverlay = document.getElementById("confirmOverlay");
  const modalBox = document.getElementById("modalBox");
  const modalTitle = document.getElementById("modalTitle");
  const modalText = document.getElementById("modalText");
  const modalCancelBtn = document.getElementById("modalCancelBtn");
  const modalMergeBtn = document.getElementById("modalMergeBtn");
  const modalConfirmBtn = document.getElementById("modalConfirmBtn");

  // Timer DOM
  const timerDisplay = document.getElementById("timerDisplay");
  const timerSubjectSelect = document.getElementById("timerSubjectSelect");
  const timerNoteInput = document.getElementById("timerNoteInput");
  const timerStartBtn = document.getElementById("timerStartBtn");
  const timerPauseBtn = document.getElementById("timerPauseBtn");
  const timerResumeBtn = document.getElementById("timerResumeBtn");
  const timerStopBtn = document.getElementById("timerStopBtn");
  const timerStatus = document.getElementById("timerStatus");
  const timerPermissionWarning = document.getElementById("timerPermissionWarning");

  const statTotal = document.getElementById("statTotal");
  const statAvg = document.getElementById("statAvg");
  const statStreak = document.getElementById("statStreak");
  const statBestStreak = document.getElementById("statBestStreak");

  const streakRiskBanner = document.getElementById("streakRiskBanner");
  const streakRiskText = document.getElementById("streakRiskText");
  const streakRiskDismiss = document.getElementById("streakRiskDismiss");

  const goalEditBtn = document.getElementById("goalEditBtn");
  const goalEditRow = document.getElementById("goalEditRow");
  const goalInput = document.getElementById("goalInput");
  const goalSaveBtn = document.getElementById("goalSaveBtn");
  const goalCancelBtn = document.getElementById("goalCancelBtn");
  const goalProgressFill = document.getElementById("goalProgressFill");
  const goalProgressLabel = document.getElementById("goalProgressLabel");
  const goalProgressPct = document.getElementById("goalProgressPct");
  const themeToggleBtn = document.getElementById("themeToggleBtn");

  // Bottom nav / section switching
  const bottomNav = document.getElementById("bottomNav");
  const bottomNavIndicator = document.getElementById("bottomNavIndicator");
  const navTabButtons = document.querySelectorAll(".nav-tab");
  const studySection = document.getElementById("studySection");
  const performanceSection = document.getElementById("performanceSection");
  const headerTitleTextEl = document.getElementById("headerTitleText");
  const headerIconUseEl = document.getElementById("headerIconUse");
  const headerSubtitleEl = document.getElementById("headerSubtitle");

  // Performance section (exam results)
  const examDateInput = document.getElementById("examDateInput");
  const examScoreInput = document.getElementById("examScoreInput");
  const examSubjectSelect = document.getElementById("examSubjectSelect");
  const examNameInput = document.getElementById("examNameInput");
  const examHighestScoreInput = document.getElementById("examHighestScoreInput");
  const examAddBtn = document.getElementById("examAddBtn");
  const examEditActions = document.getElementById("examEditActions");
  const examSaveEditBtn = document.getElementById("examSaveEditBtn");
  const examCancelEditBtn = document.getElementById("examCancelEditBtn");
  const examEditBanner = document.getElementById("examEditBanner");
  const examResultsList = document.getElementById("examResultsList");
  const examResultCount = document.getElementById("examResultCount");
  const examClearBtn = document.getElementById("examClearBtn");

  // Performance charts (Phase 3)
  const overallChartWrap = document.getElementById("overallChartWrap");
  const overallChartRangeEl = document.getElementById("overallChartRange");
  const overallChartLegendEl = document.getElementById("overallChartLegend");
  const overallRangeButtons = document.querySelectorAll("#overallRangeSelector .range-btn");
  const subjectChartWrap = document.getElementById("subjectChartWrap");
  const subjectChartRangeEl = document.getElementById("subjectChartRange");
  const subjectChartSelect = document.getElementById("subjectChartSelect");
  const subjectChartToggle = document.getElementById("subjectChartToggle");
  const subjectChartContent = document.getElementById("subjectChartContent");
  const subjectChartChevron = document.getElementById("subjectChartChevron");

  // Per-subject exam summary (always visible — see refreshPerformance()).
  const subjectSummaryList = document.getElementById("subjectSummaryList");

  // "Highest vs You" chart — collapsible, same pattern as By Subject above.
  const highestVsChartWrap = document.getElementById("highestVsChartWrap");
  const highestVsChartRangeEl = document.getElementById("highestVsChartRange");
  const highestVsChartLegendEl = document.getElementById("highestVsChartLegend");
  const highestVsChartToggle = document.getElementById("highestVsChartToggle");
  const highestVsChartContent = document.getElementById("highestVsChartContent");
  const highestVsChartChevron = document.getElementById("highestVsChartChevron");

  const subjectsList = document.getElementById("subjectsList");
  const addSubjectBtn = document.getElementById("addSubjectBtn");
  const subjectEditRow = document.getElementById("subjectEditRow");
  const subjectNameInput = document.getElementById("subjectNameInput");
  const subjectColorInput = document.getElementById("subjectColorInput");
  const subjectSaveBtn = document.getElementById("subjectSaveBtn");
  const subjectCancelBtn = document.getElementById("subjectCancelBtn");
  const subjectsToggle = document.getElementById("subjectsToggle");
  const subjectsContent = document.getElementById("subjectsContent");
  const subjectsChevron = document.getElementById("subjectsChevron");

  // Performance page's own copy of the Subjects card — same underlying
  // `subjects` data, independent collapse/edit-form state (see
  // createSubjectManager below).
  const subjectsListPerf = document.getElementById("subjectsListPerf");
  const addSubjectBtnPerf = document.getElementById("addSubjectBtnPerf");
  const subjectEditRowPerf = document.getElementById("subjectEditRowPerf");
  const subjectNameInputPerf = document.getElementById("subjectNameInputPerf");
  const subjectColorInputPerf = document.getElementById("subjectColorInputPerf");
  const subjectSaveBtnPerf = document.getElementById("subjectSaveBtnPerf");
  const subjectCancelBtnPerf = document.getElementById("subjectCancelBtnPerf");
  const subjectsTogglePerf = document.getElementById("subjectsTogglePerf");
  const subjectsContentPerf = document.getElementById("subjectsContentPerf");
  const subjectsChevronPerf = document.getElementById("subjectsChevronPerf");

  // ---------------------------------------------------------------------
  // Date / formatting helpers
  // ---------------------------------------------------------------------
  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // Parses a "YYYY-MM-DD" string into a local Date at midnight. Used
  // wherever we need to compare or diff calendar dates (streaks, chart
  // range anchoring, CSV/JSON import validation).
  function parseISODate(isoStr) {
    const parts = isoStr.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function isValidDateStr(str) {
    return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str);
  }

  // Keeps the date input within a sensible window: no earlier than 2020,
  // and no more than 7 days into the future. Called on load and whenever
  // the page becomes visible again (in case the system date changed).
  function updateDateInputBounds() {
    const today = new Date();
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + 7);
    dateInput.min = "2020-01-01";
    dateInput.max = toISODate(maxDate);
    if (examDateInput) {
      examDateInput.min = "2020-01-01";
      examDateInput.max = toISODate(maxDate);
    }
  }

  // Cache of today's/yesterday's ISO strings, since formatDisplayDate() is
  // called once per visible entry on every render (list + both charts) —
  // recomputing two `new Date()` objects and their arithmetic that often
  // added up on longer lists. Recomputed only when the day actually rolls
  // over, not on every call.
  let _todayCache = null;
  function getTodayYesterdayStrs() {
    const nowStr = toISODate(new Date());
    if (_todayCache && _todayCache.todayStr === nowStr) return _todayCache;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    _todayCache = { todayStr: nowStr, yesterdayStr: toISODate(yesterday) };
    return _todayCache;
  }

  function formatDisplayDate(isoStr) {
    const cached = getTodayYesterdayStrs();

    if (isoStr === cached.todayStr) return "Today";
    if (isoStr === cached.yesterdayStr) return "Yesterday";

    const dt = parseISODate(isoStr);
    return dt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  // Formats a number of minutes as a compact "1h 15m" / "45m" / "2h" string,
  // used in the daily goal progress line.
  function formatMinutesShort(totalMinutes) {
    const rounded = Math.round(totalMinutes);
    const h = Math.floor(rounded / 60);
    const m = rounded % 60;
    if (h === 0) return m + "m";
    if (m === 0) return h + "h";
    return h + "h " + m + "m";
  }

  // Sums the hours already logged on a given date, optionally excluding one
  // session by id (used when editing, so the session being edited doesn't
  // count against itself). Used to enforce a 24h/day ceiling across ALL
  // sessions on that day, not just the one being added/edited.
  function getDayTotalExcluding(date, excludeId) {
    const list = sessionsData[date] || [];
    const sum = list.reduce(function (s, sess) {
      if (excludeId && sess.id === excludeId) return s;
      return s + (parseFloat(sess.hours) || 0);
    }, 0);
    return roundTo(sum, 2);
  }

  function roundTo(num, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(num * factor) / factor;
  }

  // Initialise date input to today and apply min/max bounds.
  updateDateInputBounds();
  dateInput.value = toISODate(new Date());
  if (examDateInput) examDateInput.value = toISODate(new Date());

  // Escapes any string before it is inserted into innerHTML, so that
  // values pulled from storage (which could in theory be tampered with
  // outside the app, e.g. via devtools) can never be interpreted as
  // markup. Defense-in-depth on top of the native input constraints.
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  let toastTimer = null;

  function showToast(message, isError) {
    toastMsg.textContent = message;
    toast.classList.remove("hide");
    toast.classList.add("show");
    toast.classList.toggle("toast-error", !!isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.add("hide");
      toast.classList.remove("show");
      setTimeout(function () { toast.classList.remove("hide"); }, 300);
    }, 2200);
  }

  // ---------------------------------------------------------------------
  // Subjects
  // ---------------------------------------------------------------------

  // Resolves a subjectId to display info. Falls back to the archived
  // (deleted) subject's name with a neutral color, or an "Unknown" label
  // if even the archive doesn't have it (e.g. corrupted data).
  function resolveSubject(subjectId, subjectMap) {
    const match = subjectMap ? subjectMap.get(subjectId) : subjects.find(function (s) { return s.id === subjectId; });
    if (match) return { name: match.name, color: match.color, deleted: false };
    if (deletedSubjects[subjectId]) {
      return { name: deletedSubjects[subjectId].name, color: NEUTRAL_COLOR, deleted: true };
    }
    return { name: "Unknown subject", color: NEUTRAL_COLOR, deleted: true };
  }

  // Builds an id -> subject Map for O(1) lookups within a single render
  // pass. Rebuilt fresh each time it's called (subjects lists are small,
  // so this is cheap) rather than kept as long-lived cached state — that
  // avoids having to track invalidation across every place `subjects` is
  // mutated (add/rename/delete/cloud restore all touch it independently).
  function buildSubjectMap() {
    const m = new Map();
    subjects.forEach(function (s) { m.set(s.id, s); });
    return m;
  }

  // Fills all subject <select>s (manual entry + timer + exam result form)
  // with all active subjects. If selectedId belongs to a deleted subject,
  // an extra option is added so the select can still display/keep that
  // value (only relevant while editing an old entry whose subject was
  // later deleted). Also preserves the timer's and exam form's current
  // selections even if that subject was deleted in the meantime.
  //
  // examSelectedId is optional — pass it when explicitly setting the exam
  // form's selection (e.g. starting to edit a result); omit it to leave
  // the exam select's current value untouched, same as the timer's.
  function populateSubjectSelect(selectedId, examSelectedId) {
    const prevTimerId = timerSubjectSelect.value;
    const prevExamId = examSubjectSelect ? examSubjectSelect.value : null;

    let html = subjects.map(function (s) {
      return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>';
    }).join("");

    // Ensure any "currently selected but deleted" id appears as an option
    // for the main form, timer, and/or exam form so the value is not
    // silently lost.
    function ensureDeletedOption(id) {
      if (!id || subjects.some(function (s) { return s.id === id; })) return;
      if (html.indexOf('value="' + escapeHtml(id) + '"') !== -1) return;
      const info = resolveSubject(id);
      html = '<option value="' + escapeHtml(id) + '">' + escapeHtml(info.name) + ' (deleted)</option>' + html;
    }
    ensureDeletedOption(selectedId);
    ensureDeletedOption(prevTimerId);
    ensureDeletedOption(examSelectedId || prevExamId);

    subjectSelectInput.innerHTML = html;
    timerSubjectSelect.innerHTML = html;
    if (examSubjectSelect) examSubjectSelect.innerHTML = html;

    if (selectedId) {
      subjectSelectInput.value = selectedId;
    } else if (subjects.length) {
      subjectSelectInput.value = subjects[0].id;
    }

    if (prevTimerId && (subjects.some(function (s) { return s.id === prevTimerId; }) || deletedSubjects[prevTimerId])) {
      timerSubjectSelect.value = prevTimerId;
    } else if (subjects.length) {
      timerSubjectSelect.value = subjects[0].id;
    }

    if (examSubjectSelect) {
      const targetExamId = examSelectedId || prevExamId;
      if (targetExamId && (subjects.some(function (s) { return s.id === targetExamId; }) || deletedSubjects[targetExamId])) {
        examSubjectSelect.value = targetExamId;
      } else if (subjects.length) {
        examSubjectSelect.value = subjects[0].id;
      }
    }
  }

  // Subjects management is now needed in two places (Study and
  // Performance), both editing the same shared `subjects` array. Each
  // location gets its own independent manager instance — its own
  // open/closed add-edit form state — so working in one never disturbs
  // the other, while both always render the same underlying data and
  // both refresh together on every change (via refreshAll()).
  function createSubjectManager(refs) {
    let editingId = null;

    function render() {
      if (subjects.length === 0) {
        refs.listEl.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">No subjects yet</p><p class="empty-state-sub">Add one below to start organizing your sessions.</p></div>';
        return;
      }

      refs.listEl.innerHTML = subjects.map(function (s) {
        return '' +
          '<div class="subject-row">' +
            '<div class="subject-info">' +
              '<span class="subject-swatch" style="background:' + escapeHtml(s.color) + '"></span>' +
              '<span class="subject-name">' + escapeHtml(s.name) + '</span>' +
            '</div>' +
            '<div class="subject-actions">' +
              '<button class="icon-btn edit-btn subject-edit-btn" data-id="' + escapeHtml(s.id) + '" aria-label="Edit subject">✎</button>' +
              '<button class="icon-btn delete-btn subject-delete-btn" data-id="' + escapeHtml(s.id) + '" aria-label="Delete subject">✕</button>' +
            '</div>' +
          '</div>';
      }).join("");
      // Edit/delete buttons are wired via a single delegated listener,
      // registered once below (outside render()) — this list is rebuilt
      // by refreshAll() on every unrelated action across the app (adding
      // a session, an exam result, etc.), so re-attaching two listeners
      // per subject on every one of those calls was pure waste whenever
      // subjects themselves hadn't actually changed.
    }

    function openForm() {
      refs.editRow.classList.add("show");
      refs.nameInput.focus();
      refs.editRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function closeForm() {
      refs.editRow.classList.remove("show");
      editingId = null;
    }

    function startEdit(id) {
      const s = subjects.find(function (x) { return x.id === id; });
      if (!s) return;
      editingId = id;
      refs.nameInput.value = s.name;
      refs.colorInput.value = s.color;
      openForm();
    }

    function save() {
      const name = refs.nameInput.value.trim();
      const color = refs.colorInput.value || randomNiceColor();

      if (!name) { showToast("Enter a subject name.", true); return; }

      const wasEditing = !!editingId;

      if (wasEditing) {
        const s = subjects.find(function (x) { return x.id === editingId; });
        if (s) { s.name = name.slice(0, 40); s.color = color; s.updatedAt = Date.now(); }
      } else {
        subjects.push({ id: generateId(), name: name.slice(0, 40), color: color, updatedAt: Date.now() });
      }

      closeForm();
      refreshAll();
      showToast(wasEditing ? "Subject updated" : "Subject added");
    }

    function removeSubject(id) {
      const s = subjects.find(function (x) { return x.id === id; });
      if (!s) return;

      openModal(
        "Delete this subject?",
        "\u201C" + s.name + "\u201D will be removed from your subject list. Sessions already logged under it will keep their name but show as a neutral color.",
        "Delete",
        function () {
          deletedSubjects[s.id] = { name: s.name, color: s.color, updatedAt: Date.now() };
          subjects = subjects.filter(function (x) { return x.id !== id; });

          // If the Timer or exam-result form currently has this
          // now-deleted subject selected, reset it to a real subject
          // rather than leaving it pointing at a stale id. This also
          // stops "<name> (deleted)" from leaking into every subject
          // dropdown on the next refresh — populateSubjectSelect()
          // re-adds a "(deleted)" option for ANY select whose current
          // value still references a removed subject, so clearing the
          // reference here is what prevents that, not something handled
          // after the fact.
          const fallbackId = subjects.length ? subjects[0].id : "";
          if (timerSubjectSelect.value === id) {
            timerSubjectSelect.value = fallbackId;
          }
          if (examSubjectSelect && examSubjectSelect.value === id) {
            examSubjectSelect.value = fallbackId;
          }

          if (editingId === id) closeForm();

          closeModal();
          refreshAll();
          showToast("Subject deleted");
        }
      );
    }

    refs.addBtn.addEventListener("click", function () {
      editingId = null;
      refs.nameInput.value = "";
      refs.colorInput.value = randomNiceColor();
      openForm();
    });

    refs.cancelBtn.addEventListener("click", closeForm);
    refs.saveBtn.addEventListener("click", save);
    refs.nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") save();
    });

    // Single delegated listener for this manager's subject list, replacing
    // the per-button listeners that used to be re-attached inside render()
    // on every call.
    refs.listEl.addEventListener("click", function (e) {
      const editBtn = e.target.closest(".subject-edit-btn");
      if (editBtn) { startEdit(editBtn.dataset.id); return; }
      const deleteBtn = e.target.closest(".subject-delete-btn");
      if (deleteBtn) { removeSubject(deleteBtn.dataset.id); return; }
    });

    return { render: render };
  }

  const studySubjectManager = createSubjectManager({
    listEl: subjectsList,
    addBtn: addSubjectBtn,
    editRow: subjectEditRow,
    nameInput: subjectNameInput,
    colorInput: subjectColorInput,
    saveBtn: subjectSaveBtn,
    cancelBtn: subjectCancelBtn
  });

  const perfSubjectManager = createSubjectManager({
    listEl: subjectsListPerf,
    addBtn: addSubjectBtnPerf,
    editRow: subjectEditRowPerf,
    nameInput: subjectNameInputPerf,
    colorInput: subjectColorInputPerf,
    saveBtn: subjectSaveBtnPerf,
    cancelBtn: subjectCancelBtnPerf
  });

  function renderAllSubjectLists() {
    studySubjectManager.render();
    perfSubjectManager.render();
  }

  // Study & Performance Subjects cards are optional / collapsed by
  // default, same rationale and pattern as the By Subject chart: most
  // people set their subjects up once and rarely revisit this card.
  function makeCardToggle(toggleEl, contentEl, chevronEl, storageKey) {
    function loadVisible() {
      try { return localStorage.getItem(storageKey) === "1"; } catch (e) { return false; }
    }
    function saveVisible(visible) {
      try { localStorage.setItem(storageKey, visible ? "1" : "0"); } catch (e) { /* no-op */ }
    }
    function setVisible(visible) {
      if (!contentEl) return;
      contentEl.style.display = visible ? "block" : "none";
      if (toggleEl) toggleEl.setAttribute("aria-expanded", String(visible));
      if (chevronEl) chevronEl.classList.toggle("expanded", visible);
      saveVisible(visible);
    }
    if (toggleEl) {
      // toggleEl is a native <button>, so Enter/Space already trigger this
      // click listener via the browser's built-in button activation
      // behavior — no separate keydown handler needed.
      toggleEl.addEventListener("click", function () {
        setVisible(contentEl.style.display === "none");
      });
    }
    return { setVisible: setVisible, loadVisible: loadVisible };
  }

  const studySubjectsToggle = makeCardToggle(subjectsToggle, subjectsContent, subjectsChevron, "readingHoursSubjectsVisibleStudy");
  const perfSubjectsToggle = makeCardToggle(subjectsTogglePerf, subjectsContentPerf, subjectsChevronPerf, "readingHoursSubjectsVisiblePerf");

  // ---------------------------------------------------------------------
  // Derived data: sessions -> daily totals (keeps stats/streak/chart logic
  // working the same way it always has, just sourced from sessions).
  // ---------------------------------------------------------------------
  function computeDailyTotals() {
    const totals = {};
    Object.keys(sessionsData).forEach(function (date) {
      const list = sessionsData[date] || [];
      const sum = list.reduce(function (s, sess) { return s + (parseFloat(sess.hours) || 0); }, 0);
      if (sum > 0) totals[date] = roundTo(sum, 2);
    });
    return totals;
  }

  // Scans the full history (not just the run ending today/yesterday) for the
  // longest run of consecutive logged days, so "best streak" survives even
  // after the current streak is eventually broken.
  function computeBestStreak() {
    const totals = computeDailyTotals();
    // Best streak should only reflect days that have actually happened —
    // future-dated entries (the date picker allows up to 7 days ahead)
    // must not count toward it, or a run of future entries could inflate
    // "Best" above what's actually been achieved so far.
    const todayStr = toISODate(new Date());
    const dates = Object.keys(totals)
      .filter(function (d) { return totals[d] > 0 && d <= todayStr; })
      .sort();

    if (dates.length === 0) return 0;

    let best = 1;
    let run = 1;
    for (let i = 1; i < dates.length; i++) {
      const diffDays = Math.round((parseISODate(dates[i]) - parseISODate(dates[i - 1])) / 86400000);
      run = (diffDays === 1) ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }

  function computeStats() {
    const totals = computeDailyTotals();
    const dates = Object.keys(totals);
    const total = dates.reduce(function (sum, d) { return sum + (totals[d] || 0); }, 0);
    const avg = dates.length ? total / dates.length : 0;

    let streak = 0;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);

    if (!(toISODate(cursor) in totals) || totals[toISODate(cursor)] <= 0) {
      cursor.setDate(cursor.getDate() - 1);
    }

    while (true) {
      const key = toISODate(cursor);
      if (totals[key] && totals[key] > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }

    return { total: roundTo(total, 2), avg: roundTo(avg, 2), streak: streak, best: computeBestStreak() };
  }

  function renderStats() {
    const s = computeStats();
    statTotal.textContent = s.total;
    statAvg.textContent = s.avg;
    statStreak.textContent = s.streak;
    // Best streak is always at least as large as the current streak, since
    // it's computed from the same underlying history.
    statBestStreak.textContent = "Best: " + Math.max(s.best, s.streak);
  }

  // Updates the daily-goal progress bar/label to reflect today's logged
  // hours (summed across all of today's sessions) against the configured
  // goal.
  function renderGoalProgress() {
    const todayKey = toISODate(new Date());
    const totals = computeDailyTotals();
    const todayHours = totals[todayKey] || 0;
    const todayMinutes = todayHours * 60;
    const goalMinutes = goalHours * 60;
    const pct = goalMinutes > 0 ? Math.min(100, Math.round((todayMinutes / goalMinutes) * 100)) : 0;
    const isComplete = todayMinutes >= goalMinutes;

    goalProgressFill.style.width = pct + "%";
    goalProgressFill.classList.toggle("goal-complete", isComplete);

    // Plays a one-off "celebrate" animation only the moment the goal is
    // newly crossed (not on every re-render while already complete, and
    // not on page load if it was already met earlier today).
    if (isComplete && !wasGoalComplete) {
      goalProgressFill.classList.remove("celebrate");
      void goalProgressFill.offsetWidth; // force reflow so the animation restarts
      goalProgressFill.classList.add("celebrate");
    }
    wasGoalComplete = isComplete;

    goalProgressLabel.textContent = formatMinutesShort(todayMinutes) + " / " + formatMinutesShort(goalMinutes);
    goalProgressPct.textContent = pct + "%";
  }

  // Shows (or hides) the "streak at risk" banner: only relevant after 6 PM
  // local time, when today has no entry yet, and there's an active streak
  // (as of yesterday) that would be broken if today goes unlogged. Can be
  // dismissed for the rest of the day via sessionStorage, so it doesn't
  // nag repeatedly on every re-render.
  const RISK_HOUR = 18; // 6 PM
  const DISMISS_KEY = "streakRiskDismissedDate";

  function updateStreakRiskBanner() {
    const now = new Date();
    const todayKey = toISODate(now);
    const totals = computeDailyTotals();
    const loggedToday = !!(totals[todayKey] && totals[todayKey] > 0);
    const stats = computeStats();
    const dismissedToday = sessionStorage.getItem(DISMISS_KEY) === todayKey;

    const atRisk = now.getHours() >= RISK_HOUR && !loggedToday && stats.streak > 0 && !dismissedToday;

    streakRiskBanner.classList.toggle("show", atRisk);
    if (atRisk) {
      streakRiskText.textContent = "Your " + stats.streak + "-day streak is at risk — log today's reading before midnight!";
    }
  }

  // Awards a badge toast the first time the user crosses a total-hours or
  // streak-length milestone. Each milestone only ever fires once (tracked
  // in milestonesAwarded / localStorage), even if hours are later edited
  // down and back up again.
  function checkAndAwardMilestones() {
    const stats = computeStats();
    const messages = [];

    TOTAL_HOUR_MILESTONES.forEach(function (t) {
      if (stats.total >= t && milestonesAwarded.total.indexOf(t) === -1) {
        milestonesAwarded.total.push(t);
        messages.push("🏅 Milestone reached: " + t + " total hours read!");
      }
    });

    STREAK_DAY_MILESTONES.forEach(function (t) {
      if (stats.streak >= t && milestonesAwarded.streak.indexOf(t) === -1) {
        milestonesAwarded.streak.push(t);
        messages.push("🔥 Milestone reached: " + t + "-day streak!");
      }
    });

    // If more than one milestone was crossed in a single update (e.g. a
    // large data import), each one now gets its own toast, shown one after
    // another so none of them get silently dropped.
    if (messages.length) {
      saveMilestones(milestonesAwarded);
      messages.forEach(function (message, i) {
        queueMilestoneToast(message, i);
      });
    }
  }

  // checkAndAwardMilestones() runs inside refreshAll(), which every caller
  // (addEntry, saveEdit, performImport, ...) follows immediately with its
  // own showToast("Session added"/etc.) in the same tick. Showing a
  // milestone toast synchronously here would just get instantly clobbered
  // by that call, so each one is queued to appear in sequence after the
  // regular toast fades.
  function queueMilestoneToast(message, index) {
    const delay = 2400 + (index || 0) * 3600;
    setTimeout(function () { showMilestoneToast(message); }, delay);
  }

  function showMilestoneToast(message) {
    toastMsg.textContent = message;
    toast.classList.remove("hide");
    toast.classList.remove("toast-error");
    toast.classList.add("show", "toast-milestone");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.add("hide");
      toast.classList.remove("show", "toast-milestone");
      setTimeout(function () { toast.classList.remove("hide"); }, 300);
    }, 3600);
  }

  // ---------------------------------------------------------------------
  // All Entries: grouped by day, expandable to show individual sessions.
  // ---------------------------------------------------------------------
  function renderEntriesList() {
    const dates = Object.keys(sessionsData)
      .filter(function (d) { return sessionsData[d] && sessionsData[d].length > 0; })
      .sort()
      .reverse();

    const totalSessions = dates.reduce(function (sum, d) { return sum + sessionsData[d].length; }, 0);
    entryCount.textContent = totalSessions
      ? totalSessions + (totalSessions === 1 ? " session" : " sessions") + " · " + dates.length + (dates.length === 1 ? " day" : " days")
      : "";

    if (dates.length === 0) {
      entriesList.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">Nothing logged yet</p><p class="empty-state-sub">Add your first study session above to see it here.</p></div>';
      return;
    }

    // Built once per render pass so every session row does an O(1) map
    // lookup instead of a linear scan through `subjects` (same fix as the
    // Performance section's result list — see resolveSubject()).
    const subjectMap = buildSubjectMap();
    entriesList.innerHTML = dates.map(function (date) {
      const sessions = sessionsData[date].slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      const dayTotal = roundTo(sessions.reduce(function (s, x) { return s + (parseFloat(x.hours) || 0); }, 0), 2);
      const isExpanded = expandedDates.has(date);
      const safeDate = escapeHtml(date);
      const safeDisplayDate = escapeHtml(formatDisplayDate(date));

      const sessionsHtml = sessions.map(function (sess) {
        const info = resolveSubject(sess.subjectId, subjectMap);
        const noteHtml = sess.note ? '<div class="session-note">📝 ' + escapeHtml(sess.note) + '</div>' : '';
        const deletedTag = info.deleted ? ' <span style="font-weight:400;color:var(--text-muted);">(deleted)</span>' : '';
        return '' +
          '<div class="session-row">' +
            '<div class="session-info">' +
              '<span class="subject-swatch sm" style="background:' + escapeHtml(info.color) + '"></span>' +
              '<div class="session-text">' +
                '<div class="session-subject">' + escapeHtml(info.name) + deletedTag + '</div>' +
                noteHtml +
              '</div>' +
            '</div>' +
            '<div class="session-right">' +
              '<span class="hours-badge">' + escapeHtml(sess.hours) + 'h</span>' +
              '<button class="icon-btn edit-btn session-edit-btn" data-date="' + safeDate + '" data-id="' + escapeHtml(sess.id) + '" aria-label="Edit session">✎</button>' +
              '<button class="icon-btn delete-btn session-delete-btn" data-date="' + safeDate + '" data-id="' + escapeHtml(sess.id) + '" aria-label="Delete session">✕</button>' +
            '</div>' +
          '</div>';
      }).join("");

      return '' +
        '<div class="day-group">' +
          '<div class="day-header" data-date="' + safeDate + '">' +
            '<div class="day-header-left">' +
              '<span class="day-toggle' + (isExpanded ? ' expanded' : '') + '">▶</span>' +
              '<div>' +
                '<div class="day-date">' + safeDisplayDate + '</div>' +
                '<div class="day-meta">' + sessions.length + (sessions.length === 1 ? ' session' : ' sessions') + '</div>' +
              '</div>' +
            '</div>' +
            '<span class="hours-badge">' + dayTotal + 'h</span>' +
          '</div>' +
          '<div class="day-sessions' + (isExpanded ? ' show' : '') + '"><div class="day-sessions-inner">' + sessionsHtml + '</div></div>' +
        '</div>';
    }).join("");
    // day-header toggle / edit / delete are all wired once via a single
    // delegated listener on entriesList (set up below, outside this
    // function) instead of being re-attached to every row here on every
    // render — this list previously reattached three separate listener
    // sets (day-header, edit-btn, delete-btn) per element, per render.
  }

  let chartInstance = null;
  // Tracks the last chart type so we can destroy+recreate when switching
  // between bar (stacked multi-dataset) and line (single dataset).
  let lastRenderedChartType = null;

  function getLastNDays(n) {
    const days = [];

    // Always anchor the window on "today" so recent days never get pushed
    // out of view by a future-dated entry. Future entries still appear in
    // the "All Entries" list — they just won't show on this chart until
    // their date is within the window.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push(toISODate(d));
    }
    return days;
  }

  // For each day in the range, returns a map of subjectId -> hours (summed
  // across sessions of that subject). Used by both stacked bars and the
  // line-chart tooltip breakdown.
  function computeDailySubjectBreakdown(days) {
    const byDay = {};
    days.forEach(function (date) {
      const map = {};
      const list = sessionsData[date] || [];
      list.forEach(function (sess) {
        const h = parseFloat(sess.hours) || 0;
        if (h <= 0) return;
        const sid = sess.subjectId || "_unknown";
        map[sid] = (map[sid] || 0) + h;
      });
      // Round each subject total
      Object.keys(map).forEach(function (sid) {
        map[sid] = roundTo(map[sid], 2);
      });
      byDay[date] = map;
    });
    return byDay;
  }

  // Ordered list of subject ids that appear in the given day range, with
  // active subjects first (in subjects-list order), then any deleted ones.
  function getSubjectsInRange(breakdown) {
    const used = {};
    Object.keys(breakdown).forEach(function (date) {
      Object.keys(breakdown[date]).forEach(function (sid) {
        if (breakdown[date][sid] > 0) used[sid] = true;
      });
    });

    const ordered = [];
    subjects.forEach(function (s) {
      if (used[s.id]) ordered.push(s.id);
    });
    Object.keys(used).forEach(function (sid) {
      if (ordered.indexOf(sid) === -1) ordered.push(sid);
    });
    return ordered;
  }

  // items is normally an array of subject ids (existing callers: the
  // Overall chart's per-subject legend). The Highest vs You chart's two
  // series ("You" / "Highest") aren't subjects, so items may also contain
  // plain {name, color} objects — resolveSubject() only runs for string
  // entries, so existing subject-id callers behave exactly as before.
  function renderChartLegend(items, targetElId) {
    const legendEl = document.getElementById(targetElId || "chartLegend");
    if (!legendEl) return;

    if (!items || items.length === 0) {
      legendEl.innerHTML = "";
      return;
    }

    legendEl.innerHTML = items.map(function (item) {
      const info = (typeof item === "string") ? resolveSubject(item) : item;
      return '' +
        '<span class="chart-legend-item">' +
          '<span class="chart-legend-swatch" style="background:' + escapeHtml(info.color) + '"></span>' +
          escapeHtml(info.name) +
        '</span>';
    }).join("");
  }

  // Bug fix: previously all Chart.js colors (grid lines, tick labels, the
  // line chart's stroke/fill) were hardcoded for light mode, so the chart
  // stayed washed-out/low-contrast whenever dark mode was active — even
  // though the surrounding .chart-wrap card had already gone dark via CSS.
  // Called fresh on every renderChart() so switching themes updates it too.
  function getChartThemeColors() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    return {
      grid: isDark ? "rgba(255, 255, 255, 0.08)" : "#eef1f4",
      tick: isDark ? "#9aa0a6" : "#5f6368",
      lineBorder: isDark ? "#8ab4f8" : "#1a73e8",
      lineFill: isDark ? "rgba(138, 180, 248, 0.18)" : "rgba(26, 115, 232, 0.15)",
      pointBorder: isDark ? "#1e2128" : "#fff",
      emptyBar: isDark ? "#8ab4f8" : "#1a73e8",
      // "Highest" series color for the Highest vs You chart — reuses the
      // app's existing accent2 tone (the same "special" gold/amber used
      // for the Day Streak stat) so it reads as a distinct, deliberate
      // second series rather than an arbitrary new color.
      highestBorder: isDark ? "#e3a552" : "#c9740a",
      highestFill: isDark ? "rgba(227, 165, 82, 0.16)" : "rgba(201, 116, 10, 0.12)"
    };
  }

  function renderChart() {
    const days = getLastNDays(currentRange);
    const totals = computeDailyTotals();
    const breakdown = computeDailySubjectBreakdown(days);
    const subjectIds = getSubjectsInRange(breakdown);
    const themeColors = getChartThemeColors();

    const labels = days.map(function (d) {
      const parts = d.split("-").map(Number);
      const dt = new Date(parts[0], parts[1] - 1, parts[2]);
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });

    chartTitle.textContent = "Last " + currentRange + " Days";
    chartRange.textContent = labels[0] + " - " + labels[labels.length - 1];

    const ctx = document.getElementById("readingChart").getContext("2d");
    let data;
    let options;

    if (currentChartType === "bar") {
      // Stacked bar: one dataset per subject, colored with the subject's
      // custom color. Days with no data for a subject get 0 (invisible).
      const datasets = subjectIds.map(function (sid) {
        const info = resolveSubject(sid);
        return {
          label: info.name,
          data: days.map(function (d) { return (breakdown[d] && breakdown[d][sid]) || 0; }),
          backgroundColor: info.color,
          borderRadius: 3,
          maxBarThickness: 28,
          stack: "subjects"
        };
      });

      // If nothing was studied in the range, still show an empty chart
      // with a single zero dataset so axes render cleanly.
      if (datasets.length === 0) {
        datasets.push({
          label: "Hours",
          data: days.map(function () { return 0; }),
          backgroundColor: themeColors.emptyBar,
          borderRadius: 3,
          maxBarThickness: 28,
          stack: "subjects"
        });
      }

      data = { labels: labels, datasets: datasets };
      options = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                const v = ctx.parsed.y;
                if (!v) return null; // hide zero segments
                return ctx.dataset.label + ": " + v + "h";
              },
              footer: function (items) {
                const sum = items.reduce(function (s, it) { return s + (it.parsed.y || 0); }, 0);
                return sum > 0 ? "Total: " + roundTo(sum, 2) + "h" : "";
              }
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            ticks: { autoSkip: true, maxRotation: 0, minRotation: 0, color: themeColors.tick }
          },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { precision: 0, color: themeColors.tick },
            grid: { color: themeColors.grid }
          }
        }
      };
    } else {
      // Line chart: single smooth line of daily totals. Tooltip shows the
      // full subject breakdown for the hovered/tapped day.
      const values = days.map(function (d) { return totals[d] || 0; });

      data = {
        labels: labels,
        datasets: [{
          label: "Total hours",
          data: values,
          backgroundColor: themeColors.lineFill,
          borderColor: themeColors.lineBorder,
          borderWidth: 2,
          pointBackgroundColor: themeColors.lineBorder,
          pointBorderColor: themeColors.pointBorder,
          pointBorderWidth: 1.5,
          pointRadius: 3,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.35
        }]
      };

      options = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              // Title stays the date label (default).
              label: function (ctx) {
                const dayIndex = ctx.dataIndex;
                const date = days[dayIndex];
                const dayMap = breakdown[date] || {};
                const total = totals[date] || 0;
                const lines = [];

                lines.push("Total: " + total + "h");

                // Subject breakdown, ordered the same way as the legend.
                subjectIds.forEach(function (sid) {
                  const h = dayMap[sid];
                  if (!h) return;
                  const info = resolveSubject(sid);
                  lines.push(info.name + ": " + h + "h");
                });

                // Chart.js joins multi-line labels with newlines when the
                // callback returns an array.
                return lines;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0, color: themeColors.tick },
            grid: { color: themeColors.grid }
          },
          x: {
            grid: { display: false },
            ticks: { autoSkip: true, maxRotation: 0, minRotation: 0, color: themeColors.tick }
          }
        }
      };
    }

    // Destroy and recreate when switching chart type — stacked multi-dataset
    // bar vs single-dataset line don't update cleanly in place.
    const typeChanged = lastRenderedChartType !== null && lastRenderedChartType !== currentChartType;
    if (chartInstance && typeChanged) {
      chartInstance.destroy();
      chartInstance = null;
    }

    if (chartInstance) {
      chartInstance.config.type = currentChartType;
      chartInstance.data = data;
      chartInstance.options = options;
      chartInstance.update();
    } else {
      chartInstance = new Chart(ctx, { type: currentChartType, data: data, options: options });
    }
    lastRenderedChartType = currentChartType;

    renderChartLegend(subjectIds);
  }

  // Briefly fades the canvas out/in around a chart update so type switches
  // (and, harmlessly, range switches) read as an animated transition rather
  // than an instant redraw.
  function renderChartAnimated() {
    chartWrap.classList.add("chart-switching");
    window.setTimeout(function () {
      renderChart();
      chartWrap.classList.remove("chart-switching");
    }, 140);
  }

  function setActiveChartTypeButton() {
    chartTypeButtons.forEach(function (b) {
      b.classList.toggle("active", b.dataset.chartType === currentChartType);
    });
  }

  rangeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      currentRange = parseInt(btn.dataset.range, 10);
      rangeButtons.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      renderChartAnimated();
    });
  });

  chartTypeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const type = btn.dataset.chartType;
      if (type === currentChartType || VALID_CHART_TYPES.indexOf(type) === -1) return;
      currentChartType = type;
      saveChartType(currentChartType);
      setActiveChartTypeButton();
      renderChartAnimated();
    });
  });

  setActiveChartTypeButton();

  // ---------------------------------------------------------------------
  // Core refresh
  // ---------------------------------------------------------------------
  function refreshAll() {
    saveSessions(sessionsData);
    saveSubjects(subjects);
    saveDeletedSubjects(deletedSubjects);
    renderStats();
    renderAllSubjectLists();
    populateSubjectSelect(subjectSelectInput.value);
    renderEntriesList();
    renderChart();
    renderGoalProgress();
    updateStreakRiskBanner();
    checkAndAwardMilestones();
    // Subjects are shared with Performance — a rename/color change/delete
    // here should show up there immediately too, not just after switching
    // tabs (which would re-render anyway, but this keeps both in sync
    // even if the user has both sections' state cached from earlier).
    renderExamResultsList();
    renderSubjectSummary();
    populateSubjectChartSelect();
    renderOverallChart();
    renderSubjectChart();
    renderHighestVsChart();
    cloudChangeListeners.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("Cloud change listener failed", e); }
    });
  }

  // ---------------------------------------------------------------------
  // Built-in Timer
  // Uses real timestamps (Date.now) so elapsed time stays accurate even
  // when the tab is backgrounded or the device screen is locked. The
  // display is updated with a lightweight interval; accuracy comes only
  // from the timestamps, not from the interval itself.
  // ---------------------------------------------------------------------
  let timerState = "idle";          // "idle" | "running" | "paused"
  let timerAccumulatedMs = 0;       // elapsed time stored while paused / stopped
  let timerStartedAt = null;        // Date.now() when the current running segment began
  let timerTickInterval = null;

  // Persists the in-progress timer to localStorage so it survives the OS
  // killing the app's process while backgrounded — which installed PWAs
  // are especially prone to, often within well under a minute. Regular JS
  // variables above vanish when that happens (the next "resume" is really
  // a full page reload), but localStorage does not. Since timerStartedAt
  // is a real wall-clock timestamp, elapsed time computed from it is still
  // correct after such a restart — the same math already used for
  // ordinary backgrounding, just re-anchored on reload instead of on a
  // live interval.
  const TIMER_STATE_KEY = "readingHoursTimerState";

  // A live notification showing timer progress, kept up to date (roughly)
  // while the app's JS is actually running. Note this has the same
  // fundamental limit as the timer itself: once the OS fully suspends the
  // app, nothing can update the notification further — it'll just sit
  // frozen at its last value rather than erroring or vanishing. Combined
  // with the persisted state above, reopening the app still recovers the
  // correct elapsed time even if the notification itself went stale.
  const NOTIFICATION_TAG = "reading-hours-timer";
  const NOTIFICATION_UPDATE_MS = 60000; // refresh roughly once a minute while running
  let notificationUpdateInterval = null;

  function formatTimerMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return String(h).padStart(2, "0") + ":" +
           String(m).padStart(2, "0") + ":" +
           String(s).padStart(2, "0");
  }

  function getCurrentElapsedMs() {
    if (timerState === "running" && timerStartedAt != null) {
      return timerAccumulatedMs + (Date.now() - timerStartedAt);
    }
    return timerAccumulatedMs;
  }

  // ---- Timer state persistence (survives the app process being killed) ----
  function saveTimerState() {
    if (timerState === "idle") {
      clearSavedTimerState();
      return;
    }
    try {
      localStorage.setItem(TIMER_STATE_KEY, JSON.stringify({
        state: timerState,                          // "running" | "paused"
        startedAt: timerStartedAt,                   // ms timestamp, or null while paused
        accumulatedMs: timerAccumulatedMs,
        subjectId: timerSubjectSelect.value,
        note: timerNoteInput.value
      }));
    } catch (e) {
      console.warn("Could not persist timer state", e);
    }
  }

  function clearSavedTimerState() {
    try { localStorage.removeItem(TIMER_STATE_KEY); } catch (e) { /* no-op */ }
  }

  function loadSavedTimerState() {
    try {
      const raw = localStorage.getItem(TIMER_STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || (parsed.state !== "running" && parsed.state !== "paused")) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  // ---- Timer progress notification ----
  // Reflects the browser's actual Notification.permission value in the
  // Timer card's warning banner. Doesn't touch anything else — the timer
  // itself always keeps counting correctly (it's timestamp-based) even
  // without permission; this only affects whether the person can *tell*
  // it's still running once they lock the phone or switch apps.
  function updateTimerPermissionWarning() {
    if (!timerPermissionWarning) return;
    const needsWarning = ("Notification" in window) && Notification.permission !== "granted";
    timerPermissionWarning.classList.toggle("show", needsWarning);
  }

  function maybeRequestNotificationPermission() {
    if (!("Notification" in window)) return;
    // Only ask once, at the moment it's actually useful (starting a timer)
    // — never nag on every start if the user already granted or denied it.
    if (Notification.permission === "default") {
      Notification.requestPermission().then(function () {
        updateTimerPermissionWarning();
      }).catch(function () { /* ignored */ });
    }
  }

  function updateTimerNotification() {
    if (timerState === "idle") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!("serviceWorker" in navigator)) return;

    const info = resolveSubject(timerSubjectSelect.value);
    const elapsedMs = getCurrentElapsedMs();
    const paused = timerState === "paused";
    // The elapsed time shown here can only ever be as fresh as the last
    // time this function ran — Android suspends this page's JS almost
    // immediately once backgrounded/locked, so a live-looking "HH:MM:SS"
    // would just freeze and look broken (the notification can't actually
    // count up on its own the way a native alarm/timer app's notification
    // does — that's an OS-level feature web apps don't have access to).
    // Saying plainly that it's running in the background is honest about
    // that limitation instead of looking stuck.
    const body = paused
      ? info.name + " — Timer paused."
      : info.name + " — The timer is running in background. Keep pushing!";

    navigator.serviceWorker.ready.then(function (registration) {
      // Reusing the same tag replaces the previous notification instead of
      // stacking a new one every update; silent avoids re-alerting the
      // user each minute for what's just a progress refresh.
      return registration.showNotification("⏱️ Reading Hours Timer", {
        body: body,
        tag: NOTIFICATION_TAG,
        silent: true,
        renotify: false,
        icon: "icon-192.png",
        badge: "icon-192.png"
      });
    }).catch(function (err) {
      console.warn("Notification update failed", err);
    });

    if (navigator.setAppBadge) {
      navigator.setAppBadge(Math.floor(elapsedMs / 60000)).catch(function () { /* ignored */ });
    }
  }

  function clearTimerNotification() {
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () { /* ignored */ });
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function (registration) {
      return registration.getNotifications({ tag: NOTIFICATION_TAG });
    }).then(function (notifications) {
      notifications.forEach(function (n) { n.close(); });
    }).catch(function () { /* ignored */ });
  }

  function startNotificationInterval() {
    stopNotificationInterval();
    notificationUpdateInterval = setInterval(updateTimerNotification, NOTIFICATION_UPDATE_MS);
  }

  function stopNotificationInterval() {
    if (notificationUpdateInterval) {
      clearInterval(notificationUpdateInterval);
      notificationUpdateInterval = null;
    }
  }

  function updateTimerDisplay() {
    const ms = getCurrentElapsedMs();
    timerDisplay.textContent = formatTimerMs(ms);
    timerDisplay.classList.toggle("running", timerState === "running");
    timerDisplay.classList.toggle("paused", timerState === "paused");
  }

  function setTimerButtons() {
    timerStartBtn.style.display = timerState === "idle" ? "" : "none";
    timerPauseBtn.style.display = timerState === "running" ? "" : "none";
    timerResumeBtn.style.display = timerState === "paused" ? "" : "none";
    timerStopBtn.style.display = (timerState === "running" || timerState === "paused") ? "" : "none";

    // Prevent changing subject while a session is being timed (note is still editable).
    timerSubjectSelect.disabled = timerState !== "idle";
  }

  function startTimerTick() {
    if (timerTickInterval) return;
    timerTickInterval = setInterval(updateTimerDisplay, 250);
  }

  function stopTimerTick() {
    if (timerTickInterval) {
      clearInterval(timerTickInterval);
      timerTickInterval = null;
    }
  }

  function startTimer() {
    if (subjects.length === 0) {
      showToast("Add a subject first.", true);
      return;
    }
    if (!timerSubjectSelect.value) {
      showToast("Choose a subject.", true);
      return;
    }

    // Always start a fresh segment from idle (accumulated should already
    // be 0 after resetTimer, but zero explicitly for safety).
    timerAccumulatedMs = 0;
    timerState = "running";
    timerStartedAt = Date.now();
    timerStatus.textContent = "Running…";
    setTimerButtons();
    updateTimerDisplay();
    startTimerTick();
    saveTimerState();
    maybeRequestNotificationPermission();
    updateTimerNotification();
    startNotificationInterval();
  }

  function pauseTimer() {
    if (timerState !== "running") return;
    timerAccumulatedMs += Date.now() - timerStartedAt;
    timerStartedAt = null;
    timerState = "paused";
    timerStatus.textContent = "Paused";
    setTimerButtons();
    updateTimerDisplay();
    // Keep the tick running so the display stays frozen but UI stays responsive;
    // or stop it — either is fine. Stopping saves a tiny bit of work.
    stopTimerTick();
    saveTimerState();
    updateTimerNotification();
    // No need to keep refreshing a notification whose elapsed time isn't
    // moving — the "— Paused" notification above just sits as-is until
    // resumed or stopped.
    stopNotificationInterval();
  }

  function resumeTimer() {
    if (timerState !== "paused") return;
    timerState = "running";
    timerStartedAt = Date.now();
    timerStatus.textContent = "Running…";
    setTimerButtons();
    updateTimerDisplay();
    startTimerTick();
    saveTimerState();
    updateTimerNotification();
    startNotificationInterval();
  }

  function resetTimer() {
    stopTimerTick();
    timerState = "idle";
    timerAccumulatedMs = 0;
    timerStartedAt = null;
    timerStatus.textContent = "";
    setTimerButtons();
    updateTimerDisplay();
    clearSavedTimerState();
    stopNotificationInterval();
    clearTimerNotification();
  }

  function stopTimer() {
    // Finalize elapsed time using timestamps.
    const elapsedMs = getCurrentElapsedMs();
    const MIN_MS = 60 * 1000; // 1 minute

    if (elapsedMs < MIN_MS) {
      showToast("Session too short — need at least 1 minute.", true);
      resetTimer();
      return;
    }

    const hours = roundTo(elapsedMs / 3600000, 2);
    const subjectId = timerSubjectSelect.value;
    const note = timerNoteInput.value.trim();
    const today = toISODate(new Date());

    if (!subjectId) {
      // Subject select is locked while the timer runs; if the value was
      // somehow lost (e.g. every subject deleted), reset so the user is
      // not stuck unable to change subject or save.
      showToast("Choose a subject.", true);
      resetTimer();
      return;
    }

    // Match the manual entry limit so a long-running timer cannot create
    // an unrealistic single-day total.
    if (hours > 24) {
      showToast("Hours can't exceed 24 in a single day.", true);
      resetTimer();
      return;
    }

    // Also check against any sessions already logged today — the timer
    // itself can't exceed 24h, but combined with earlier manual entries
    // today's total still could without this check.
    const existingDayTotal = getDayTotalExcluding(today, null);
    if (roundTo(existingDayTotal + hours, 2) > 24) {
      showToast("Today already has " + existingDayTotal + "h logged — this session would exceed 24h total. Not saved.", true);
      resetTimer();
      return;
    }

    if (!sessionsData[today]) sessionsData[today] = [];
    sessionsData[today].push({
      id: generateId(),
      subjectId: subjectId,
      hours: hours,
      note: note ? note.slice(0, 200) : "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    expandedDates.add(today);

    // Clear the note so the next timed session starts clean; keep subject.
    timerNoteInput.value = "";
    resetTimer();
    refreshAll();
    showToast("Session saved (" + hours + "h)");
  }

  timerStartBtn.addEventListener("click", startTimer);
  timerPauseBtn.addEventListener("click", pauseTimer);
  timerResumeBtn.addEventListener("click", resumeTimer);
  timerStopBtn.addEventListener("click", stopTimer);

  // Reconstructs an in-progress timer from localStorage after a reload —
  // whether that's a normal browser refresh or, more commonly for the
  // installed app, the OS having silently killed the process while it was
  // backgrounded. Called once during startup, below.
  function restoreTimerIfAny() {
    const saved = loadSavedTimerState();
    if (!saved) return;

    if (saved.subjectId) {
      // Set the value first, then re-run populateSubjectSelect so its own
      // "keep a deleted subject visible" logic (keyed off the select's
      // current value) applies here too — a subject someone deletes while
      // a timer is mid-run shouldn't silently bump the timer to a
      // different subject on the next reload.
      timerSubjectSelect.value = saved.subjectId;
      populateSubjectSelect(subjectSelectInput.value);
      timerSubjectSelect.value = saved.subjectId;
    }

    timerNoteInput.value = saved.note || "";
    timerAccumulatedMs = typeof saved.accumulatedMs === "number" ? saved.accumulatedMs : 0;

    if (saved.state === "running" && typeof saved.startedAt === "number") {
      timerState = "running";
      timerStartedAt = saved.startedAt;
      timerStatus.textContent = "Running…";
      startTimerTick();
      startNotificationInterval();
    } else {
      timerState = "paused";
      timerStartedAt = null;
      timerStatus.textContent = "Paused";
    }

    updateTimerNotification();
    showToast("Resumed your in-progress timer");
  }

  // When the page becomes visible again (tab switch / unlock), force a
  // display refresh so any time that passed in the background is shown
  // immediately rather than waiting for the next interval tick.
  // Also refresh date-input bounds in case the system date changed, and
  // give the timer notification an immediate refresh rather than waiting
  // up to a minute for its own interval.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      updateDateInputBounds();
      updateTimerPermissionWarning();
      if (timerState === "running") {
        updateTimerDisplay();
      }
      if (timerState === "running" || timerState === "paused") {
        updateTimerNotification();
      }
    }
  });

  // ---------------------------------------------------------------------
  // Sessions: add / edit / delete
  // ---------------------------------------------------------------------
  function addEntry() {
    let date = dateInput.value;
    const hours = parseFloat(hoursInput.value);
    const subjectId = subjectSelectInput.value;
    const note = noteInput.value.trim();

    if (!date || !isValidDateStr(date)) {
      showToast("Please choose a valid date.", true);
      return;
    }
    // Normalise to a clean local YYYY-MM-DD key (guards against browser quirks).
    date = toISODate(parseISODate(date));

    if (isNaN(hours) || hours < 0) { showToast("Enter a valid number of hours (0 or more).", true); return; }
    if (hours > 24) { showToast("Hours can't exceed 24 in a single day.", true); return; }
    if (subjects.length === 0) { showToast("Add a subject first.", true); return; }
    if (!subjectId) { showToast("Choose a subject.", true); return; }

    const existingDayTotal = getDayTotalExcluding(date, null);
    if (roundTo(existingDayTotal + hours, 2) > 24) {
      showToast("That day already has " + existingDayTotal + "h logged — can't exceed 24h total.", true);
      return;
    }

    const todayStr = toISODate(new Date());
    const isFuture = date > todayStr;

    if (!sessionsData[date]) sessionsData[date] = [];
    sessionsData[date].push({
      id: generateId(),
      subjectId: subjectId,
      hours: roundTo(hours, 2),
      note: note ? note.slice(0, 200) : "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // Expand today's/this date's group so the newly added session is
    // immediately visible without an extra tap.
    expandedDates.add(date);

    hoursInput.value = "";
    noteInput.value = "";
    refreshAll();
    showToast(isFuture ? "Session added (future date)" : "Session added");
  }

  function startEditSession(date, id) {
    const list = sessionsData[date] || [];
    const sess = list.find(function (s) { return s.id === id; });
    if (!sess) return;

    editingSession = { date: date, id: id };
    dateInput.value = date;
    hoursInput.value = sess.hours;
    noteInput.value = sess.note || "";
    populateSubjectSelect(sess.subjectId);

    addBtn.style.display = "none";
    editActions.style.display = "flex";
    editBanner.classList.add("show");

    hoursInput.focus();
    dateInput.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function exitEditMode() {
    editingSession = null;
    addBtn.style.display = "block";
    editActions.style.display = "none";
    editBanner.classList.remove("show");
    hoursInput.value = "";
    noteInput.value = "";
    updateDateInputBounds();
    dateInput.value = toISODate(new Date());
    populateSubjectSelect(subjects.length ? subjects[0].id : null);
  }

  function saveEdit() {
    if (!editingSession) return;

    let newDate = dateInput.value;
    const hours = parseFloat(hoursInput.value);
    const subjectId = subjectSelectInput.value;
    const note = noteInput.value.trim();

    if (!newDate || !isValidDateStr(newDate)) {
      showToast("Please choose a valid date.", true);
      return;
    }
    // Normalise to a clean local YYYY-MM-DD key.
    newDate = toISODate(parseISODate(newDate));

    if (isNaN(hours) || hours < 0) { showToast("Enter a valid number of hours (0 or more).", true); return; }
    if (hours > 24) { showToast("Hours can't exceed 24 in a single day.", true); return; }
    if (!subjectId) { showToast("Choose a subject.", true); return; }

    const oldDate = editingSession.date;
    const id = editingSession.id;

    // Exclude the session being edited from the target day's existing
    // total (relevant whether it's staying on the same day or moving to
    // a new one — either way it shouldn't be double-counted against itself).
    const existingDayTotal = getDayTotalExcluding(newDate, id);
    if (roundTo(existingDayTotal + hours, 2) > 24) {
      showToast("That day already has " + existingDayTotal + "h logged — can't exceed 24h total.", true);
      return;
    }

    const todayStr = toISODate(new Date());
    const isFuture = newDate > todayStr;
    const list = sessionsData[oldDate] || [];
    const idx = list.findIndex(function (s) { return s.id === id; });
    if (idx === -1) { exitEditMode(); return; }

    const sess = list[idx];
    sess.hours = roundTo(hours, 2);
    sess.subjectId = subjectId;
    sess.note = note ? note.slice(0, 200) : "";
    sess.updatedAt = Date.now();

    // Multiple sessions can share a day, so moving a session to a new date
    // never collides with anything already there — just relocate it.
    if (newDate !== oldDate) {
      list.splice(idx, 1);
      if (list.length === 0) delete sessionsData[oldDate];
      if (!sessionsData[newDate]) sessionsData[newDate] = [];
      sessionsData[newDate].push(sess);
      expandedDates.add(newDate);
    }

    exitEditMode();
    refreshAll();
    showToast(isFuture ? "Session updated (future date)" : "Session updated");
  }

  // Individual sessions require confirmation before deletion, matching the
  // safety level of "Clear All Data" (reuses the same modal).
  function deleteSession(date, id) {
    const list = sessionsData[date];
    if (!list) return;
    const sess = list.find(function (s) { return s.id === id; });
    if (!sess) return;
    const info = resolveSubject(sess.subjectId);

    openModal(
      "Delete this session?",
      "This will permanently remove the " + info.name + " session (" + sess.hours + "h) logged on " + formatDisplayDate(date) + ".",
      "Delete",
      function () {
        if (editingSession && editingSession.date === date && editingSession.id === id) exitEditMode();

        const idx = list.findIndex(function (s) { return s.id === id; });
        if (idx !== -1) list.splice(idx, 1);
        if (list.length === 0) delete sessionsData[date];

        closeModal();
        refreshAll();
        showToast("Session deleted");
      }
    );
  }

  // ---------------------------------------------------------------------
  // Performance: exam results (add / edit / delete / render)
  // Mirrors the Sessions block above, but results are a flat list (no
  // per-day grouping) since exams are naturally sparse compared to daily
  // study sessions. Subjects are shared with Study — same list, same
  // colors, same resolveSubject()/deletedSubjects handling.
  // ---------------------------------------------------------------------

  // Buckets a score into a readable tier for the color-coded badge.
  function getScoreTier(pct) {
    if (pct >= 90) return "excellent";
    if (pct >= 75) return "good";
    if (pct >= 50) return "fair";
    return "low";
  }

  // Parses the optional Highest Score field. Returns:
  //   - a number, if the field has a valid 0-100 value
  //   - null, if the field is empty (the field is optional)
  //   - NaN, if the field has something present but invalid — callers use
  //     this to distinguish "left blank" from "typed garbage" and block
  //     the save only for the latter.
  function parseOptionalHighestScore() {
    if (!examHighestScoreInput) return null;
    const raw = examHighestScoreInput.value;
    if (raw === "" || raw === null) return null;
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0 || val > 100) return NaN;
    return val;
  }

  function addExamResult() {
    let date = examDateInput.value;
    const pct = parseFloat(examScoreInput.value);
    const subjectId = examSubjectSelect.value;
    const examName = examNameInput.value.trim();
    const highestScore = parseOptionalHighestScore();

    if (!date || !isValidDateStr(date)) {
      showToast("Please choose a valid date.", true);
      return;
    }
    date = toISODate(parseISODate(date));

    if (isNaN(pct) || pct < 0 || pct > 100) {
      showToast("Enter a score between 0 and 100.", true);
      return;
    }
    if (subjects.length === 0) { showToast("Add a subject first.", true); return; }
    if (!subjectId) { showToast("Choose a subject.", true); return; }
    if (isNaN(highestScore)) {
      showToast("Enter a valid highest score between 0 and 100.", true);
      return;
    }
    if (highestScore !== null && highestScore < pct) {
      showToast("Highest score can't be lower than your own score.", true);
      return;
    }

    examResults.push({
      id: generateId(),
      subjectId: subjectId,
      examName: examName ? examName.slice(0, 60) : "",
      percentage: roundTo(pct, 2),
      highestScore: highestScore === null ? null : roundTo(highestScore, 2),
      date: date,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    examScoreInput.value = "";
    examNameInput.value = "";
    if (examHighestScoreInput) examHighestScoreInput.value = "";
    refreshPerformance();
    showToast("Result added");
  }

  function startEditExamResult(id) {
    const result = examResults.find(function (r) { return r.id === id; });
    if (!result) return;

    editingExamResult = id;
    examDateInput.value = result.date;
    examScoreInput.value = result.percentage;
    examNameInput.value = result.examName || "";
    if (examHighestScoreInput) {
      examHighestScoreInput.value = (result.highestScore === null || result.highestScore === undefined) ? "" : result.highestScore;
    }
    // Refresh options (in case subjects changed) without disturbing the
    // Study form's own selection, then explicitly select this result's
    // subject in the exam form.
    populateSubjectSelect(subjectSelectInput.value, result.subjectId);

    examAddBtn.style.display = "none";
    examEditActions.style.display = "flex";
    examEditBanner.classList.add("show");

    examScoreInput.focus();
    examDateInput.closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function exitExamEditMode() {
    editingExamResult = null;
    examAddBtn.style.display = "block";
    examEditActions.style.display = "none";
    examEditBanner.classList.remove("show");
    examScoreInput.value = "";
    examNameInput.value = "";
    if (examHighestScoreInput) examHighestScoreInput.value = "";
    if (examDateInput) examDateInput.value = toISODate(new Date());
    populateSubjectSelect(subjectSelectInput.value, subjects.length ? subjects[0].id : null);
  }

  function saveExamEdit() {
    if (!editingExamResult) return;

    let newDate = examDateInput.value;
    const pct = parseFloat(examScoreInput.value);
    const subjectId = examSubjectSelect.value;
    const examName = examNameInput.value.trim();
    const highestScore = parseOptionalHighestScore();

    if (!newDate || !isValidDateStr(newDate)) {
      showToast("Please choose a valid date.", true);
      return;
    }
    newDate = toISODate(parseISODate(newDate));

    if (isNaN(pct) || pct < 0 || pct > 100) {
      showToast("Enter a score between 0 and 100.", true);
      return;
    }
    if (!subjectId) { showToast("Choose a subject.", true); return; }
    if (isNaN(highestScore)) {
      showToast("Enter a valid highest score between 0 and 100.", true);
      return;
    }
    if (highestScore !== null && highestScore < pct) {
      showToast("Highest score can't be lower than your own score.", true);
      return;
    }

    const result = examResults.find(function (r) { return r.id === editingExamResult; });
    if (!result) { exitExamEditMode(); return; }

    result.date = newDate;
    result.percentage = roundTo(pct, 2);
    result.subjectId = subjectId;
    result.examName = examName ? examName.slice(0, 60) : "";
    result.highestScore = highestScore === null ? null : roundTo(highestScore, 2);
    result.updatedAt = Date.now();

    exitExamEditMode();
    refreshPerformance();
    showToast("Result updated");
  }

  // Individual results require confirmation before deletion, matching the
  // safety level of session deletes and "Clear All Results" (reuses the
  // same shared modal).
  function deleteExamResult(id) {
    const result = examResults.find(function (r) { return r.id === id; });
    if (!result) return;
    const info = resolveSubject(result.subjectId);

    openModal(
      "Delete this result?",
      "This will permanently remove the " + info.name + " result (" + result.percentage + "%) logged on " + formatDisplayDate(result.date) + ".",
      "Delete",
      function () {
        if (editingExamResult === id) exitExamEditMode();

        examResults = examResults.filter(function (r) { return r.id !== id; });

        closeModal();
        refreshPerformance();
        showToast("Result deleted");
      }
    );
  }

  function openClearExamModal() {
    openModal(
      "Clear all results?",
      "This will permanently delete all your logged exam results. Your subjects will be kept. This cannot be undone.",
      "Delete All",
      performClearAllExamResults
    );
  }

  function performClearAllExamResults() {
    examResults = [];
    exitExamEditMode();
    refreshPerformance();
    closeModal();
    showToast("All results cleared");
  }

  function renderExamResultsList() {
    if (!examResultsList) return;

    const sorted = examResults.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // most recent date first
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    if (examResultCount) {
      examResultCount.textContent = sorted.length
        ? sorted.length + (sorted.length === 1 ? " result" : " results")
        : "";
    }

    if (sorted.length === 0) {
      examResultsList.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">No results yet</p><p class="empty-state-sub">Log your first exam above to start tracking scores.</p></div>';
      return;
    }

    const subjectMap = buildSubjectMap();
    examResultsList.innerHTML = sorted.map(function (r) {
      const info = resolveSubject(r.subjectId, subjectMap);
      const tier = getScoreTier(r.percentage);
      const deletedTag = info.deleted ? ' <span style="font-weight:400;color:var(--text-muted);">(deleted)</span>' : '';
      const nameHtml = r.examName ? '<div class="session-note">📝 ' + escapeHtml(r.examName) + '</div>' : '';
      // Only shown when this result has an optional Highest Score logged —
      // existing rows without one render exactly as they did before this
      // field existed.
      const highestHtml = (r.highestScore !== null && r.highestScore !== undefined)
        ? '<span style="font-size:11px;color:var(--text-muted);">of ' + escapeHtml(r.highestScore) + '%</span>'
        : '';
      return '' +
        '<div class="session-row">' +
          '<div class="session-info">' +
            '<span class="subject-swatch sm" style="background:' + escapeHtml(info.color) + '"></span>' +
            '<div class="session-text">' +
              '<div class="session-subject">' + escapeHtml(info.name) + deletedTag + '</div>' +
              '<div class="entry-hours">' + escapeHtml(formatDisplayDate(r.date)) + '</div>' +
              nameHtml +
            '</div>' +
          '</div>' +
          '<div class="session-right">' +
            '<span class="score-badge score-' + tier + '">' + escapeHtml(r.percentage) + '%</span>' +
            highestHtml +
            '<button class="icon-btn edit-btn exam-edit-btn" data-id="' + escapeHtml(r.id) + '" aria-label="Edit result">✎</button>' +
            '<button class="icon-btn delete-btn exam-delete-btn" data-id="' + escapeHtml(r.id) + '" aria-label="Delete result">✕</button>' +
          '</div>' +
        '</div>';
    }).join("");
    // Edit/delete buttons are wired once via a single delegated listener
    // (set up below, outside this function) rather than re-attached to
    // every row here on every render.
  }

  // ---------------------------------------------------------------------
  // Performance: per-subject exam summary
  // Always visible (unlike the collapsible charts below) since it only
  // needs `percentage`, which every existing exam result already has —
  // no new field required, so it's immediately useful to every user.
  // ---------------------------------------------------------------------

  // Walks examResults once, grouping by subjectId into running
  // count/sum/high/low. Uses buildSubjectMap() at the call site rather
  // than resolveSubject()'s linear scan, since this iterates every exam
  // result on every render.
  function buildSubjectExamSummaries() {
    const bySubject = {};
    examResults.forEach(function (r) {
      const bucket = bySubject[r.subjectId] || (bySubject[r.subjectId] = { count: 0, sum: 0, high: r.percentage, low: r.percentage });
      bucket.count += 1;
      bucket.sum += r.percentage;
      if (r.percentage > bucket.high) bucket.high = r.percentage;
      if (r.percentage < bucket.low) bucket.low = r.percentage;
    });
    return bySubject;
  }

  function renderSubjectSummary() {
    if (!subjectSummaryList) return;

    const bySubject = buildSubjectExamSummaries();
    const subjectIdsWithResults = Object.keys(bySubject);

    if (subjectIdsWithResults.length === 0) {
      subjectSummaryList.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">No results yet</p><p class="empty-state-sub">Log an exam result to see per-subject stats here.</p></div>';
      return;
    }

    const subjectMap = buildSubjectMap();
    // Ordered to match the Subjects list, same convention as the Overall
    // chart's legend above.
    const ordered = [];
    subjects.forEach(function (s) { if (bySubject[s.id]) ordered.push(s.id); });
    subjectIdsWithResults.forEach(function (sid) { if (ordered.indexOf(sid) === -1) ordered.push(sid); });

    subjectSummaryList.innerHTML = ordered.map(function (sid) {
      const info = resolveSubject(sid, subjectMap);
      const bucket = bySubject[sid];
      const avg = roundTo(bucket.sum / bucket.count, 1);
      const countLabel = bucket.count + (bucket.count === 1 ? " exam" : " exams");
      return '' +
        '<div class="session-row">' +
          '<div class="session-info">' +
            '<span class="subject-swatch sm" style="background:' + escapeHtml(info.color) + '"></span>' +
            '<div class="session-text">' +
              '<div class="session-subject">' + escapeHtml(info.name) + '</div>' +
              '<div class="entry-hours">Avg ' + escapeHtml(avg) + '% · High ' + escapeHtml(bucket.high) + '% · Low ' + escapeHtml(bucket.low) + '% · ' + escapeHtml(countLabel) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }).join("");
  }

  // ---------------------------------------------------------------------
  // Performance: charts (Overall trend + By Subject)
  // Both reuse getChartThemeColors()/renderChartLegend() from the Study
  // chart above, and the same .chart-wrap/.range-selector CSS, so they
  // inherit matching visuals, theme-awareness, and animations for free.
  // Unlike Study's chart (which is anchored to a fixed day-range), these
  // are built directly from the actual logged results — sparse, real
  // events rather than a daily grid — so an empty range shows a proper
  // empty-state message instead of a blank chart.
  // ---------------------------------------------------------------------

  // Returns exam results sorted oldest → newest (left-to-right on the
  // chart, matching the Study chart's convention), optionally limited to
  // the last N by currentOverallRange.
  function getOverallChartData() {
    const sorted = examResults.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    if (currentOverallRange === "all") return sorted;
    const n = parseInt(currentOverallRange, 10);
    return sorted.slice(-n);
  }

  // Chart.js canvases lose their element reference once an empty-state
  // message has replaced them in the DOM; this restores a fresh <canvas>
  // in the given wrap (if one isn't already present) and returns its 2D
  // context, ready to draw into.
  function ensureChartCanvas(wrapEl, canvasId) {
    let canvas = document.getElementById(canvasId);
    if (!canvas) {
      wrapEl.innerHTML = '<canvas id="' + canvasId + '"></canvas>';
      canvas = document.getElementById(canvasId);
    }
    return canvas.getContext("2d");
  }

  function renderOverallChart() {
    if (!overallChartWrap) return;
    const data = getOverallChartData();
    const themeColors = getChartThemeColors();

    if (overallChartRangeEl) {
      overallChartRangeEl.textContent = data.length
        ? formatDisplayDate(data[0].date) + " – " + formatDisplayDate(data[data.length - 1].date)
        : "";
    }

    if (data.length === 0) {
      if (overallChartInstance) { overallChartInstance.destroy(); overallChartInstance = null; }
      overallChartWrap.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">Your trend starts here</p><p class="empty-state-sub">Log an exam result to see your performance trend.</p></div>';
      renderChartLegend([], "overallChartLegend");
      return;
    }

    const ctx = ensureChartCanvas(overallChartWrap, "overallChart");

    const labels = data.map(function (r) {
      const dt = parseISODate(r.date);
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const values = data.map(function (r) { return r.percentage; });
    // Points are colored by each result's own subject — a single line
    // still shows the overall trend, but you can see at a glance which
    // subject each point belongs to, reusing subjects' existing colors
    // rather than introducing a new color scheme.
    const subjectMap = buildSubjectMap();
    const pointColors = data.map(function (r) { return resolveSubject(r.subjectId, subjectMap).color; });

    const chartData = {
      labels: labels,
      datasets: [{
        label: "Score",
        data: values,
        borderColor: themeColors.lineBorder,
        backgroundColor: themeColors.lineFill,
        borderWidth: 2,
        pointBackgroundColor: pointColors,
        pointBorderColor: themeColors.pointBorder,
        pointBorderWidth: 1.5,
        pointRadius: 4,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.3
      }]
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const r = data[ctx.dataIndex];
              const info = resolveSubject(r.subjectId, subjectMap);
              const lines = [info.name + ": " + r.percentage + "%"];
              if (r.examName) lines.push(r.examName);
              return lines;
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { precision: 0, color: themeColors.tick, callback: function (v) { return v + "%"; } },
          grid: { color: themeColors.grid }
        },
        x: {
          grid: { display: false },
          ticks: { autoSkip: true, maxRotation: 0, minRotation: 0, color: themeColors.tick }
        }
      }
    };

    if (overallChartInstance) {
      overallChartInstance.data = chartData;
      overallChartInstance.options = options;
      overallChartInstance.update();
    } else {
      overallChartInstance = new Chart(ctx, { type: "line", data: chartData, options: options });
    }

    // Legend: subjects actually present in the current range, ordered to
    // match the Subjects list (same convention as the Study chart).
    const presentIds = [];
    data.forEach(function (r) { if (presentIds.indexOf(r.subjectId) === -1) presentIds.push(r.subjectId); });
    const orderedIds = [];
    subjects.forEach(function (s) { if (presentIds.indexOf(s.id) !== -1) orderedIds.push(s.id); });
    presentIds.forEach(function (sid) { if (orderedIds.indexOf(sid) === -1) orderedIds.push(sid); });
    renderChartLegend(orderedIds, "overallChartLegend");
  }

  function setActiveOverallRangeButton() {
    overallRangeButtons.forEach(function (b) {
      b.classList.toggle("active", b.dataset.range === currentOverallRange);
    });
  }

  overallRangeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const range = btn.dataset.range;
      if (range === currentOverallRange || VALID_PERFORMANCE_RANGES.indexOf(range) === -1) return;
      currentOverallRange = range;
      savePerformanceRange(currentOverallRange);
      setActiveOverallRangeButton();
      renderOverallChart();
    });
  });

  // Fills the By Subject chart's subject picker. Keeps the current
  // selection if it's still a valid subject; otherwise defaults to the
  // first subject that actually has logged results (falling back to the
  // first subject overall if none do).
  function populateSubjectChartSelect() {
    if (!subjectChartSelect) return;

    if (subjects.length === 0) {
      subjectChartSelect.innerHTML = "";
      currentSubjectChartId = null;
      return;
    }

    subjectChartSelect.innerHTML = subjects.map(function (s) {
      return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>';
    }).join("");

    const stillValid = currentSubjectChartId && subjects.some(function (s) { return s.id === currentSubjectChartId; });
    if (!stillValid) {
      const subjectWithResults = subjects.find(function (s) {
        return examResults.some(function (r) { return r.subjectId === s.id; });
      });
      currentSubjectChartId = (subjectWithResults || subjects[0]).id;
    }
    subjectChartSelect.value = currentSubjectChartId;
  }

  function renderSubjectChart() {
    if (!subjectChartWrap) return;
    if (!subjectChartContent || subjectChartContent.style.display === "none") return;

    if (!currentSubjectChartId) {
      if (subjectChartInstance) { subjectChartInstance.destroy(); subjectChartInstance = null; }
      subjectChartWrap.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">No subjects yet</p><p class="empty-state-sub">Add a subject to chart its trend.</p></div>';
      if (subjectChartRangeEl) subjectChartRangeEl.textContent = "";
      return;
    }

    const data = examResults
      .filter(function (r) { return r.subjectId === currentSubjectChartId; })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

    const info = resolveSubject(currentSubjectChartId);
    const themeColors = getChartThemeColors();

    if (subjectChartRangeEl) {
      subjectChartRangeEl.textContent = data.length
        ? formatDisplayDate(data[0].date) + " – " + formatDisplayDate(data[data.length - 1].date)
        : "";
    }

    if (data.length === 0) {
      if (subjectChartInstance) { subjectChartInstance.destroy(); subjectChartInstance = null; }
      subjectChartWrap.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">No results for ' + escapeHtml(info.name) + ' yet</p><p class="empty-state-sub">Log a result to see the trend appear here.</p></div>';
      return;
    }

    const ctx = ensureChartCanvas(subjectChartWrap, "subjectChart");

    const labels = data.map(function (r) {
      const dt = parseISODate(r.date);
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const values = data.map(function (r) { return r.percentage; });

    const chartData = {
      labels: labels,
      datasets: [{
        label: info.name,
        data: values,
        borderColor: info.color,
        backgroundColor: info.color + "26", // ~15% alpha fill, same subject color
        borderWidth: 2,
        pointBackgroundColor: info.color,
        pointBorderColor: themeColors.pointBorder,
        pointBorderWidth: 1.5,
        pointRadius: 4,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.3
      }]
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const r = data[ctx.dataIndex];
              const lines = [r.percentage + "%"];
              if (r.examName) lines.push(r.examName);
              return lines;
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { precision: 0, color: themeColors.tick, callback: function (v) { return v + "%"; } },
          grid: { color: themeColors.grid }
        },
        x: {
          grid: { display: false },
          ticks: { autoSkip: true, maxRotation: 0, minRotation: 0, color: themeColors.tick }
        }
      }
    };

    if (subjectChartInstance) {
      subjectChartInstance.data = chartData;
      subjectChartInstance.options = options;
      subjectChartInstance.update();
    } else {
      subjectChartInstance = new Chart(ctx, { type: "line", data: chartData, options: options });
    }
  }

  if (subjectChartSelect) {
    subjectChartSelect.addEventListener("change", function () {
      currentSubjectChartId = subjectChartSelect.value;
      renderSubjectChart();
    });
  }

  // By Subject chart is optional / collapsed by default — this remembers
  // the user's expand/collapse choice across reloads (same pattern as the
  // "On-device backup options" toggle elsewhere in the app).
  const SUBJECT_CHART_VISIBLE_KEY = "readingHoursSubjectChartVisible";
  function loadSubjectChartVisible() {
    try { return localStorage.getItem(SUBJECT_CHART_VISIBLE_KEY) === "1"; } catch (e) { return false; }
  }
  function saveSubjectChartVisible(visible) {
    try { localStorage.setItem(SUBJECT_CHART_VISIBLE_KEY, visible ? "1" : "0"); } catch (e) { /* no-op */ }
  }

  function setSubjectChartVisible(visible) {
    if (!subjectChartContent) return;
    subjectChartContent.style.display = visible ? "block" : "none";
    if (subjectChartToggle) subjectChartToggle.setAttribute("aria-expanded", String(visible));
    if (subjectChartChevron) subjectChartChevron.classList.toggle("expanded", visible);
    saveSubjectChartVisible(visible);
    if (visible) {
      renderSubjectChart();
      if (subjectChartInstance) requestAnimationFrame(function () { subjectChartInstance.resize(); });
    }
  }

  if (subjectChartToggle) {
    // subjectChartToggle is a native <button>, so Enter/Space already
    // trigger this click listener via the browser's built-in button
    // activation behavior — no separate keydown handler needed.
    subjectChartToggle.addEventListener("click", function () {
      setSubjectChartVisible(subjectChartContent.style.display === "none");
    });
  }

  // "Highest vs You": the most opt-in view in the section — it only has
  // data once a user starts filling in the optional Highest Score field,
  // so it's grouped with the app's other opt-in chart (By Subject) at the
  // end of the collapsible cluster rather than competing with the
  // always-visible Overall chart for attention.

  // Results with both percentage and highestScore present, oldest -> newest
  // (same left-to-right convention as getOverallChartData()). Anything
  // missing either value is skipped rather than substituted with 0, since
  // a 0 would misrepresent an exam that simply has no comparison data.
  function getHighestVsChartData() {
    return examResults
      .filter(function (r) {
        return r.percentage !== null && r.percentage !== undefined &&
          r.highestScore !== null && r.highestScore !== undefined;
      })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
  }

  function renderHighestVsChart() {
    if (!highestVsChartWrap) return;
    if (!highestVsChartContent || highestVsChartContent.style.display === "none") return;

    const data = getHighestVsChartData();
    const themeColors = getChartThemeColors();

    if (highestVsChartRangeEl) {
      highestVsChartRangeEl.textContent = data.length
        ? formatDisplayDate(data[0].date) + " – " + formatDisplayDate(data[data.length - 1].date)
        : "";
    }

    if (data.length === 0) {
      if (highestVsChartInstance) { highestVsChartInstance.destroy(); highestVsChartInstance = null; }
      highestVsChartWrap.innerHTML = '<div class="empty-state"><svg class="empty-state-icon" aria-hidden="true"><use href="#icon-empty-trend"></use></svg><p class="empty-state-title">No comparisons yet</p><p class="empty-state-sub">Add a Highest Score to a result to chart it against your own.</p></div>';
      renderChartLegend([], "highestVsChartLegend");
      return;
    }

    const ctx = ensureChartCanvas(highestVsChartWrap, "highestVsChart");

    const labels = data.map(function (r) {
      const dt = parseISODate(r.date);
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const youValues = data.map(function (r) { return r.percentage; });
    const highestValues = data.map(function (r) { return r.highestScore; });

    const chartData = {
      labels: labels,
      datasets: [
        {
          label: "You",
          data: youValues,
          borderColor: themeColors.lineBorder,
          backgroundColor: themeColors.lineFill,
          borderWidth: 2,
          pointBackgroundColor: themeColors.lineBorder,
          pointBorderColor: themeColors.pointBorder,
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 7,
          fill: false,
          tension: 0.3
        },
        {
          label: "Highest",
          data: highestValues,
          borderColor: themeColors.highestBorder,
          backgroundColor: themeColors.highestFill,
          borderWidth: 2,
          pointBackgroundColor: themeColors.highestBorder,
          pointBorderColor: themeColors.pointBorder,
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 7,
          fill: false,
          tension: 0.3
        }
      ]
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const r = data[ctx.dataIndex];
              const lines = [ctx.dataset.label + ": " + ctx.parsed.y + "%"];
              if (ctx.datasetIndex === 0 && r.examName) lines.push(r.examName);
              return lines;
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { precision: 0, color: themeColors.tick, callback: function (v) { return v + "%"; } },
          grid: { color: themeColors.grid }
        },
        x: {
          grid: { display: false },
          ticks: { autoSkip: true, maxRotation: 0, minRotation: 0, color: themeColors.tick }
        }
      }
    };

    if (highestVsChartInstance) {
      highestVsChartInstance.data = chartData;
      highestVsChartInstance.options = options;
      highestVsChartInstance.update();
    } else {
      highestVsChartInstance = new Chart(ctx, { type: "line", data: chartData, options: options });
    }

    renderChartLegend([
      { name: "You", color: themeColors.lineBorder },
      { name: "Highest", color: themeColors.highestBorder }
    ], "highestVsChartLegend");
  }

  // Collapsed by default, same remembered-choice pattern as the By Subject
  // chart above (SUBJECT_CHART_VISIBLE_KEY) — the key itself lives in the
  // Storage Keys block at the top (HIGHEST_VS_CHART_VISIBLE_KEY).
  function loadHighestVsChartVisible() {
    try { return localStorage.getItem(HIGHEST_VS_CHART_VISIBLE_KEY) === "1"; } catch (e) { return false; }
  }
  function saveHighestVsChartVisible(visible) {
    try { localStorage.setItem(HIGHEST_VS_CHART_VISIBLE_KEY, visible ? "1" : "0"); } catch (e) { /* no-op */ }
  }

  function setHighestVsChartVisible(visible) {
    if (!highestVsChartContent) return;
    highestVsChartContent.style.display = visible ? "block" : "none";
    if (highestVsChartToggle) highestVsChartToggle.setAttribute("aria-expanded", String(visible));
    if (highestVsChartChevron) highestVsChartChevron.classList.toggle("expanded", visible);
    saveHighestVsChartVisible(visible);
    if (visible) {
      renderHighestVsChart();
      if (highestVsChartInstance) requestAnimationFrame(function () { highestVsChartInstance.resize(); });
    }
  }

  if (highestVsChartToggle) {
    highestVsChartToggle.addEventListener("click", function () {
      setHighestVsChartVisible(highestVsChartContent.style.display === "none");
    });
  }

  // Saves + re-renders the Performance section, and notifies the cloud-sync
  // module (same listener array Study's refreshAll() uses) so a signed-in
  // session pushes exam results to Firestore too.
  function refreshPerformance() {
    saveExamResults(examResults);
    renderExamResultsList();
    renderSubjectSummary();
    populateSubjectChartSelect();
    renderOverallChart();
    renderSubjectChart();
    renderHighestVsChart();
    cloudChangeListeners.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("Cloud change listener failed", e); }
    });
  }

  // ---------------------------------------------------------------------
  // Modal (shared confirmation dialog)
  // ---------------------------------------------------------------------
  // Generic modal opener: sets the title/body text and wires the confirm
  // button to run the given callback when tapped. An optional onCancel
  // callback runs when the user backs out (Cancel button, backdrop tap,
  // or Escape key) instead of confirming. Used for "Clear All Data",
  // "delete session", "delete subject", and import prompts.
  //
  // An optional `secondary` config ({label, onClick}) adds a third button
  // (Merge) between Cancel and the primary confirm button — currently only
  // used by the "Import data" prompt, which needs Merge vs Replace All
  // instead of a single confirm action.
  let pendingConfirmAction = null;
  let pendingCancelAction = null;
  let pendingSecondaryAction = null;
  let lastFocusedBeforeModal = null;

  function getFocusableModalElements() {
    return modalBox.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  }

  function openModal(title, text, confirmLabel, onConfirm, onCancel, secondary) {
    modalTitle.textContent = title;
    modalText.textContent = text;
    modalConfirmBtn.textContent = confirmLabel;
    pendingConfirmAction = onConfirm;
    pendingCancelAction = onCancel || null;

    if (secondary) {
      modalMergeBtn.textContent = secondary.label;
      modalMergeBtn.style.display = "block";
      pendingSecondaryAction = secondary.onClick;
    } else {
      modalMergeBtn.style.display = "none";
      pendingSecondaryAction = null;
    }

    lastFocusedBeforeModal = document.activeElement;
    confirmOverlay.classList.add("show");

    // Move focus into the dialog for keyboard/screen-reader users.
    modalCancelBtn.focus();
  }

  function closeModal() {
    confirmOverlay.classList.remove("show");
    pendingConfirmAction = null;
    pendingCancelAction = null;
    pendingSecondaryAction = null;
    modalMergeBtn.style.display = "none";

    // Return focus to whatever triggered the modal.
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === "function") {
      lastFocusedBeforeModal.focus();
    }
    lastFocusedBeforeModal = null;
  }

  // Runs the optional cancel callback (if any), then closes the modal.
  // Wired to the Cancel button, backdrop click, and the Escape key.
  function cancelModal() {
    if (typeof pendingCancelAction === "function") pendingCancelAction();
    closeModal();
  }

  function openClearModal() {
    openModal(
      "Clear all data?",
      "This will permanently delete all your logged sessions. Your subjects will be kept. This cannot be undone.",
      "Delete All",
      performClearAllData
    );
  }

  function performClearAllData() {
    sessionsData = {};
    expandedDates = new Set();
    exitEditMode();
    resetTimer();
    refreshAll();
    closeModal();
    showToast("All data cleared");
  }

  // ---------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------
  // Full-fidelity JSON payload: subjects (with colors), sessions, exam
  // results, and goal so a re-import (or a restore from the auto-saved
  // file) restores everything exactly. Shared by the manual "Export Data"
  // button and the auto-save-to-file feature below.
  function buildExportPayload() {
    const dates = Object.keys(sessionsData).filter(function (d) {
      return sessionsData[d] && sessionsData[d].length > 0;
    }).sort();

    // Built once and reused for both the examResults and sessions loops
    // below, instead of each call to resolveSubject() re-scanning the
    // full `subjects` array — this function walks every session and every
    // exam result ever logged, and runs on every auto-save (debounced,
    // but still on essentially every save action), so it's the largest
    // total loop volume in the app.
    const subjectMap = buildSubjectMap();

    const payload = {
      version: 5,
      exportedAt: new Date().toISOString(),
      goalHours: goalHours,
      milestonesAwarded: milestonesAwarded,
      subjects: subjects.map(function (s) {
        return { id: s.id, name: s.name, color: s.color };
      }),
      sessions: {},
      examResults: examResults.map(function (r) {
        const info = resolveSubject(r.subjectId, subjectMap);
        return {
          id: r.id,
          subjectId: r.subjectId,
          subjectName: info.name,
          examName: r.examName || "",
          percentage: r.percentage,
          highestScore: (r.highestScore === null || r.highestScore === undefined) ? null : r.highestScore,
          date: r.date,
          createdAt: r.createdAt || null
        };
      })
    };

    dates.forEach(function (date) {
      payload.sessions[date] = sessionsData[date].map(function (sess) {
        const info = resolveSubject(sess.subjectId, subjectMap);
        return {
          id: sess.id,
          subjectId: sess.subjectId,
          subjectName: info.name,
          hours: sess.hours,
          note: sess.note || "",
          createdAt: sess.createdAt || null
        };
      });
    });

    return payload;
  }

  function exportData() {
    const hasData = Object.keys(sessionsData).some(function (d) {
      return sessionsData[d] && sessionsData[d].length > 0;
    });
    const hasExamData = examResults.length > 0;

    if (!hasData && !hasExamData && subjects.length === 0) {
      showToast("No data to export");
      return;
    }

    const todayStr = toISODate(new Date());
    const payload = buildExportPayload();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "reading-hours-" + todayStr + ".json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast("Data exported");
  }

  // ---------------------------------------------------------------------
  // Auto-save to a linked file (File System Access API)
  //
  // Lets the user pick a JSON file once; from then on, every change
  // (new/edited/deleted session, subject, or goal update) is silently
  // rewritten to that same file — no repeated manual "Export" needed.
  //
  // Only supported in Chromium browsers (Chrome, Edge, Opera, Brave) as of
  // this writing; Safari and Firefox don't implement showSaveFilePicker.
  // Where unsupported, the row is hidden and manual Export/Import remains
  // the only path.
  // ---------------------------------------------------------------------
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(LINK_DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(LINK_STORE_NAME);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbSet(key, value) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(LINK_STORE_NAME, "readwrite");
        tx.objectStore(LINK_STORE_NAME).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(LINK_STORE_NAME, "readonly");
        const req = tx.objectStore(LINK_STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDelete(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(LINK_STORE_NAME, "readwrite");
        tx.objectStore(LINK_STORE_NAME).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Checks (and if allowed, silently upgrades) permission on a stored file
  // handle. requestPermission() only succeeds with an actual UI prompt when
  // called from within a user-gesture handler (a click) — calling it from
  // page load without a gesture will just fail quietly, which is fine here
  // since we fall back to asking the user to click "Reconnect".
  function queryHandlePermission(handle) {
    return handle.queryPermission({ mode: "readwrite" });
  }

  function requestHandlePermission(handle) {
    return handle.requestPermission({ mode: "readwrite" });
  }

  function setAutoSaveStatus(text, isWarning) {
    if (!autoSaveStatusEl) return;
    autoSaveStatusEl.textContent = text;
    autoSaveStatusEl.style.color = isWarning ? "#d93025" : "";
  }

  function refreshLinkButtonLabel(permissionState) {
    if (!linkFileBtn) return;
    if (!linkedFileHandle) {
      linkFileBtn.textContent = "Link File for Auto-Save";
    } else if (permissionState === "granted") {
      linkFileBtn.textContent = "Unlink Auto-Save File";
    } else {
      linkFileBtn.textContent = "Reconnect Auto-Save File";
    }
  }

  function scheduleAutoSave() {
    if (!linkedFileHandle) return;
    autoSavePending = true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(writeLinkedFileNow, AUTOSAVE_DEBOUNCE_MS);
  }

  function writeLinkedFileNow() {
    if (!linkedFileHandle || autoSaveInFlight) return;
    autoSaveInFlight = true;
    autoSavePending = false;

    // Runs after every attempt (success or failure) to release the
    // in-flight lock and retry if another change queued up meanwhile.
    // Without this on the failure paths, a failed write could silently
    // swallow a pending change until the user happened to edit again.
    function finishAttempt() {
      autoSaveInFlight = false;
      if (autoSavePending) scheduleAutoSave();
    }

    queryHandlePermission(linkedFileHandle).then(function (state) {
      if (state !== "granted") {
        refreshLinkButtonLabel(state);
        setAutoSaveStatus("⚠️ Reconnect needed to keep auto-saving to " + linkedFileHandle.name, true);
        finishAttempt();
        return;
      }
      const payload = buildExportPayload();
      const json = JSON.stringify(payload, null, 2);
      linkedFileHandle.createWritable().then(function (writable) {
        return writable.write(json).then(function () { return writable.close(); });
      }).then(function () {
        setAutoSaveStatus("🔗 Auto-saved to " + linkedFileHandle.name + " · " + new Date().toLocaleTimeString());
        finishAttempt();
      }).catch(function (err) {
        console.error("Auto-save write failed", err);
        setAutoSaveStatus("⚠️ Auto-save failed — see browser console", true);
        finishAttempt();
      });
    }).catch(function (err) {
      console.error("Auto-save permission check failed", err);
      finishAttempt();
    });
  }

  function linkNewFile() {
    window.showSaveFilePicker({
      suggestedName: "reading-hours-data.json",
      types: [{ description: "JSON file", accept: { "application/json": [".json"] } }]
    }).then(function (handle) {
      linkedFileHandle = handle;
      return idbSet(LINK_KEY, handle);
    }).then(function () {
      refreshLinkButtonLabel("granted");
      showToast("Linked — auto-saving to " + linkedFileHandle.name);
      writeLinkedFileNow();
    }).catch(function (err) {
      if (err && err.name === "AbortError") return; // user closed the picker
      console.error("Link file failed", err);
      showToast("Could not link a file");
    });
  }

  function unlinkFile() {
    linkedFileHandle = null;
    idbDelete(LINK_KEY).then(function () {
      refreshLinkButtonLabel(null);
      setAutoSaveStatus("Not linked — using browser storage only");
      showToast("Unlinked. Data still auto-saves in this browser.");
    });
  }

  function reconnectFile() {
    requestHandlePermission(linkedFileHandle).then(function (state) {
      refreshLinkButtonLabel(state);
      if (state === "granted") {
        setAutoSaveStatus("🔗 Reconnected to " + linkedFileHandle.name);
        writeLinkedFileNow();
      } else {
        setAutoSaveStatus("⚠️ Permission denied for " + linkedFileHandle.name, true);
      }
    }).catch(function (err) {
      console.error("Reconnect failed", err);
      showToast("Could not reconnect the file");
    });
  }

  function handleLinkButtonClick() {
    if (!AUTOSAVE_SUPPORTED) {
      showToast("Auto-save to file isn't supported in this browser");
      return;
    }
    if (!linkedFileHandle) {
      linkNewFile();
      return;
    }
    queryHandlePermission(linkedFileHandle).then(function (state) {
      if (state === "granted") {
        unlinkFile();
      } else {
        reconnectFile();
      }
    });
  }

  // On load: restore a previously linked handle (if any) from IndexedDB and
  // report its current permission state. We only *query* permission here
  // (no gesture needed) — actually re-requesting it happens when the user
  // clicks "Reconnect", since that requires a user gesture to show a prompt.
  function restoreLinkedFileOnLoad() {
    if (!autoSaveRow) return;
    if (!AUTOSAVE_SUPPORTED) {
      autoSaveRow.style.display = "none";
      return;
    }
    idbGet(LINK_KEY).then(function (handle) {
      if (!handle) {
        setAutoSaveStatus("Not linked — using browser storage only");
        return;
      }
      linkedFileHandle = handle;
      return queryHandlePermission(handle).then(function (state) {
        refreshLinkButtonLabel(state);
        if (state === "granted") {
          setAutoSaveStatus("🔗 Linked to " + handle.name);
        } else {
          setAutoSaveStatus("⚠️ Click \"Reconnect Auto-Save File\" to resume saving to " + handle.name, true);
        }
      });
    }).catch(function (err) {
      console.warn("Could not restore linked file handle", err);
      setAutoSaveStatus("Not linked — using browser storage only");
    });
  }

  // Splits a single CSV line into fields, respecting double-quoted fields
  // (which may themselves contain commas or escaped "" quotes).
  function parseCsvLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = false; }
        } else {
          current += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        fields.push(current);
        current = "";
      } else {
        current += c;
      }
    }
    fields.push(current);
    return fields;
  }

  // Finds an existing subject by name (case-insensitive), or null.
  function findSubjectByName(name) {
    const lower = String(name || "").trim().toLowerCase();
    if (!lower) return null;
    return subjects.find(function (s) { return s.name.toLowerCase() === lower; }) || null;
  }

  // Finds a subject by name, creating a new one (with a random palette
  // color) if no match exists yet. Used while importing so subject names
  // from a file map onto real subjects in this app.
  function getOrCreateSubjectByName(name) {
    const existing = findSubjectByName(name);
    if (existing) return existing;
    const s = { id: generateId(), name: String(name).trim().slice(0, 40), color: randomNiceColor(), updatedAt: Date.now() };
    subjects.push(s);
    return s;
  }

  // Subject used for legacy imports (old exports with no Subject column)
  // that don't otherwise map onto one of the user's subjects.
  function ensureFallbackSubject() {
    let fb = subjects.find(function (s) { return s.id === "imported-fallback"; });
    if (!fb) {
      fb = { id: "imported-fallback", name: "Imported", color: NEUTRAL_COLOR, updatedAt: Date.now() };
      subjects.push(fb);
    }
    return fb;
  }

  // Parses an uploaded backup file (JSON or CSV) into a
  // { date: [session, ...] } map, silently skipping malformed rows rather
  // than failing the whole import over one bad line. Also restores subjects
  // (with colors) and optionally goalHours when present in a full JSON export.
  //
  // Supported shapes:
  //  - This app's own full JSON export ({ version, subjects, sessions, goalHours })
  //  - This app's CSV export (Date,Subject,Hours,Note)
  //  - Legacy single-number-per-day exports (CSV: Date,Hours,Title; or a
  //    plain {date: hours} JSON map, optionally with a parallel `titles` map)
  //  - An array of {date, hours, title|note, subject?} rows
  function parseImportFile(text, filename) {
    const sessionsOut = {};
    const examResultsOut = [];
    const trimmed = text.trim();
    const looksLikeJson = /\.json$/i.test(filename || "") || trimmed.startsWith("{") || trimmed.startsWith("[");
    let importedGoal = null;
    let importedMilestones = null;

    // Validates and normalizes a milestonesAwarded object from an import
    // file into { total: [numbers], streak: [numbers] }, discarding
    // anything malformed. Returns null if the shape isn't usable at all.
    function normalizeMilestones(m) {
      if (!m || typeof m !== "object") return null;
      const toNumberArray = function (arr) {
        return Array.isArray(arr) ? arr.filter(function (n) { return typeof n === "number" && !isNaN(n); }) : [];
      };
      return { total: toNumberArray(m.total), streak: toNumberArray(m.streak) };
    }

    function addSession(date, subjectName, hours, note, subjectId, createdAt) {
      if (!isValidDateStr(date)) return;
      const h = parseFloat(hours);
      if (isNaN(h) || h < 0 || h > 24) return;

      let subj;
      if (subjectId && subjects.some(function (s) { return s.id === subjectId; })) {
        subj = subjects.find(function (s) { return s.id === subjectId; });
      } else if (subjectName) {
        subj = getOrCreateSubjectByName(subjectName);
      } else {
        subj = ensureFallbackSubject();
      }

      if (!sessionsOut[date]) sessionsOut[date] = [];
      sessionsOut[date].push({
        id: generateId(),
        subjectId: subj.id,
        hours: roundTo(h, 2),
        note: note ? String(note).slice(0, 200) : "",
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now()
      });
    }

    // Exam results only come from this app's own full JSON export today
    // (no CSV format defined for them yet), so this only needs to handle
    // that one shape — unlike addSession above, which also has to cope
    // with several legacy/loose formats.
    function addExamResultRow(date, subjectName, percentage, examName, subjectId, createdAt, highestScore) {
      if (!isValidDateStr(date)) return;
      const pct = parseFloat(percentage);
      if (isNaN(pct) || pct < 0 || pct > 100) return;

      // Older exported files (pre-Highest Score) and legacy stored data
      // simply won't have this field — default to null rather than
      // throwing, same treatment as a missing examName/createdAt above.
      let highest = null;
      if (highestScore !== null && highestScore !== undefined && highestScore !== "") {
        const h = parseFloat(highestScore);
        if (!isNaN(h) && h >= 0 && h <= 100) highest = roundTo(h, 2);
      }

      let subj;
      if (subjectId && subjects.some(function (s) { return s.id === subjectId; })) {
        subj = subjects.find(function (s) { return s.id === subjectId; });
      } else if (subjectName) {
        subj = getOrCreateSubjectByName(subjectName);
      } else {
        subj = ensureFallbackSubject();
      }

      examResultsOut.push({
        id: generateId(),
        subjectId: subj.id,
        examName: examName ? String(examName).slice(0, 60) : "",
        percentage: roundTo(pct, 2),
        highestScore: highest,
        date: date,
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now()
      });
    }

    // Merge subjects from a full JSON export, preserving colors. Matches by
    // id first, then by name; creates new subjects as needed.
    function importSubjectsList(list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (s) {
        if (!s || !s.name) return;
        const name = String(s.name).trim().slice(0, 40);
        const color = s.color || randomNiceColor();
        const id = s.id || generateId();

        const byId = subjects.find(function (x) { return x.id === id; });
        if (byId) {
          byId.name = name;
          byId.color = color;
          byId.updatedAt = Date.now();
          return;
        }
        const byName = findSubjectByName(name);
        if (byName) {
          byName.color = color;
          byName.updatedAt = Date.now();
          return;
        }
        subjects.push({ id: id, name: name, color: color, updatedAt: Date.now() });
      });
    }

    if (looksLikeJson) {
      const parsed = JSON.parse(trimmed);

      if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
        // This app's own full export shape (v2 sessions-only, v3+ also
        // includes examResults — both handled the same way here since
        // parsed.examResults is simply absent/undefined on a v2 file).
        if (parsed.subjects) importSubjectsList(parsed.subjects);
        if (typeof parsed.goalHours === "number" && parsed.goalHours > 0 && parsed.goalHours <= 24) {
          importedGoal = parsed.goalHours;
        }
        importedMilestones = normalizeMilestones(parsed.milestonesAwarded);
        Object.keys(parsed.sessions).forEach(function (date) {
          if (!isValidDateStr(date)) return;
          (parsed.sessions[date] || []).forEach(function (sess) {
            addSession(
              date,
              sess.subjectName || sess.subject,
              sess.hours,
              sess.note,
              sess.subjectId,
              sess.createdAt
            );
          });
        });
        if (Array.isArray(parsed.examResults)) {
          parsed.examResults.forEach(function (r) {
            addExamResultRow(
              r.date,
              r.subjectName || r.subject,
              r.percentage,
              r.examName,
              r.subjectId,
              r.createdAt,
              r.highestScore
            );
          });
        }
      } else if (Array.isArray(parsed)) {
        parsed.forEach(function (row) {
          if (!row) return;
          addSession(row.date, row.subject || row.subjectName, row.hours, row.note || row.title);
        });
      } else if (parsed && typeof parsed === "object") {
        // Legacy {data, titles} shape or a plain {date: hours} map.
        const source = (parsed.data && typeof parsed.data === "object") ? parsed.data : parsed;
        // Avoid treating our own payload keys as dates if sessions was missing.
        Object.keys(source).forEach(function (date) {
          if (!isValidDateStr(date)) return;
          addSession(date, null, source[date], parsed.titles ? parsed.titles[date] : null);
        });
      }
    } else {
      const lines = trimmed.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });

      // Decide the column format once, from the header row if present,
      // rather than guessing per-row from cell content (which misfires on
      // purely numeric subject names like "2024"). Every real data row's
      // first column is a YYYY-MM-DD date, so the most reliable header
      // check is simply "does the first field fail to parse as a date" —
      // this avoids false positives from a note/subject that happens to
      // contain the word "hours" or "subject" (the old keyword-sniffing
      // approach could misfire on those).
      let isNewFormat = null;
      const firstCols = parseCsvLine(lines[0] || "");
      const hasHeader = !isValidDateStr((firstCols[0] || "").trim());
      if (hasHeader) {
        isNewFormat = /subject/i.test(firstCols.join(","));
      }

      lines.forEach(function (line, idx) {
        if (idx === 0 && hasHeader) return; // skip header row

        const cols = parseCsvLine(line);
        if (isNewFormat === null) isNewFormat = cols.length >= 4;

        const date = (cols[0] || "").trim();

        if (isNewFormat) {
          addSession(date, cols[1], cols[2], cols[3]);
        } else {
          addSession(date, null, cols[1], cols[2]);
        }
      });
    }

    return { sessions: sessionsOut, examResults: examResultsOut, goalHours: importedGoal, milestonesAwarded: importedMilestones };
  }

  // Applies parsed import data: either merges it into the existing sessions
  // + exam results (appending to each), or replaces everything. Optionally
  // restores goalHours from a full JSON export.
  function performImport(parsed, replace) {
    const parsedSessions = parsed.sessions || parsed;
    const parsedExamResults = Array.isArray(parsed.examResults) ? parsed.examResults : [];
    if (replace) {
      sessionsData = {};
      examResults = [];
    }
    Object.keys(parsedSessions).forEach(function (date) {
      if (!sessionsData[date]) sessionsData[date] = [];
      sessionsData[date] = sessionsData[date].concat(parsedSessions[date]);
    });

    examResults = examResults.concat(parsedExamResults);

    if (typeof parsed.goalHours === "number" && parsed.goalHours > 0 && parsed.goalHours <= 24) {
      goalHours = roundTo(parsed.goalHours, 2);
      saveGoalHours(goalHours);
    }

    // Milestones already earned are never taken away — even on "Replace
    // All" — so restoring an older backup can't cause a badge toast to
    // fire again for something this device already achieved. Union rather
    // than overwrite/replace.
    if (parsed.milestonesAwarded && typeof parsed.milestonesAwarded === "object") {
      const importedTotal = Array.isArray(parsed.milestonesAwarded.total) ? parsed.milestonesAwarded.total : [];
      const importedStreak = Array.isArray(parsed.milestonesAwarded.streak) ? parsed.milestonesAwarded.streak : [];
      milestonesAwarded.total = Array.from(new Set(milestonesAwarded.total.concat(importedTotal)));
      milestonesAwarded.streak = Array.from(new Set(milestonesAwarded.streak.concat(importedStreak)));
      saveMilestones(milestonesAwarded);
    }

    const sessionCount = Object.keys(parsedSessions).reduce(function (s, d) { return s + parsedSessions[d].length; }, 0);
    const examCount = parsedExamResults.length;
    const parts = [];
    if (sessionCount) parts.push(sessionCount + (sessionCount === 1 ? " session" : " sessions"));
    if (examCount) parts.push(examCount + (examCount === 1 ? " result" : " results"));
    const summary = parts.length ? parts.join(" and ") : "0 sessions";

    exitEditMode();
    exitExamEditMode();
    refreshAll();
    refreshPerformance();
    showToast((replace ? "Data replaced — " : "Data merged — ") + summary + " imported");
  }

  // Confirms with the user (via the shared modal, extended with a Merge
  // option) before applying an import, consistent with the confirmation
  // already required for "Clear All Data" and individual deletes.
  function openImportModal(parsed) {
    const parsedSessions = parsed.sessions || parsed;
    const parsedExamResults = Array.isArray(parsed.examResults) ? parsed.examResults : [];
    const sessionCount = Object.keys(parsedSessions).reduce(function (s, d) { return s + parsedSessions[d].length; }, 0);
    const examCount = parsedExamResults.length;
    const parts = [];
    if (sessionCount) parts.push(sessionCount + (sessionCount === 1 ? " session" : " sessions"));
    if (examCount) parts.push(examCount + (examCount === 1 ? " result" : " results"));
    const summary = parts.length ? parts.join(" and ") : "0 sessions";
    openModal(
      "Import data",
      "Found " + summary + " in the selected file. " +
        "Merge adds these to your existing entries. Replace All deletes your current data first.",
      "Replace All",
      function () { performImport(parsed, true); closeModal(); },
      null,
      { label: "Merge", onClick: function () { performImport(parsed, false); closeModal(); } }
    );
  }

  importBtn.addEventListener("click", function () { importFile.click(); });

  importFile.addEventListener("change", function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const parsed = parseImportFile(String(ev.target.result), file.name);
        const parsedSessions = parsed.sessions || {};
        const parsedExamResults = Array.isArray(parsed.examResults) ? parsed.examResults : [];
        const count = Object.keys(parsedSessions).reduce(function (s, d) { return s + parsedSessions[d].length; }, 0) + parsedExamResults.length;
        if (count === 0) {
          showToast("No valid entries found in that file.", true);
        } else {
          // Parsing may have created/updated subjects (with colors); persist
          // those immediately so they show up correctly however the user
          // proceeds from here.
          saveSubjects(subjects);
          renderAllSubjectLists();
          populateSubjectSelect(subjectSelectInput.value);
          openImportModal(parsed);
        }
      } catch (err) {
        console.error("Import failed", err);
        showToast("Couldn't read that file — check it's a valid export.", true);
      }
      importFile.value = ""; // allow re-selecting the same file later
    };
    reader.onerror = function () {
      showToast("Couldn't read that file.", true);
      importFile.value = "";
    };
    reader.readAsText(file);
  });

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  addBtn.addEventListener("click", addEntry);
  saveEditBtn.addEventListener("click", saveEdit);
  cancelEditBtn.addEventListener("click", exitEditMode);
  clearBtn.addEventListener("click", openClearModal);

  // Single delegated listener for the entries list: handles day-header
  // expand/collapse plus each row's edit/delete buttons. Wired once here
  // instead of renderEntriesList() re-attaching three separate listener
  // sets (day-header, edit-btn, delete-btn) to every element on every
  // render — the cost of that scaled with total sessions logged, not just
  // how many changed.
  if (entriesList) {
    entriesList.addEventListener("click", function (e) {
      const editBtn = e.target.closest(".session-edit-btn");
      if (editBtn) { startEditSession(editBtn.dataset.date, editBtn.dataset.id); return; }
      const deleteBtn = e.target.closest(".session-delete-btn");
      if (deleteBtn) { deleteSession(deleteBtn.dataset.date, deleteBtn.dataset.id); return; }
      const dayHeader = e.target.closest(".day-header");
      if (dayHeader) {
        const d = dayHeader.dataset.date;
        const sessionsEl = dayHeader.nextElementSibling;
        const toggleIcon = dayHeader.querySelector(".day-toggle");
        const nowExpanded = !expandedDates.has(d);
        if (nowExpanded) { expandedDates.add(d); } else { expandedDates.delete(d); }
        // Toggle classes directly (rather than calling renderEntriesList())
        // so the grid-based expand/collapse transition on .day-sessions can
        // actually play — rebuilding the DOM would just snap straight to
        // the end state with no prior state to animate from.
        if (sessionsEl) sessionsEl.classList.toggle("show", nowExpanded);
        if (toggleIcon) toggleIcon.classList.toggle("expanded", nowExpanded);
      }
    });
  }

  // Performance section (exam results) wiring — mirrors the Study form's
  // wiring immediately above.
  examAddBtn.addEventListener("click", addExamResult);
  examSaveEditBtn.addEventListener("click", saveExamEdit);
  examCancelEditBtn.addEventListener("click", exitExamEditMode);
  examClearBtn.addEventListener("click", openClearExamModal);

  function handleExamEnterKey(e) {
    if (e.key === "Enter") {
      if (editingExamResult) { saveExamEdit(); } else { addExamResult(); }
    }
  }
  examScoreInput.addEventListener("keydown", handleExamEnterKey);
  examDateInput.addEventListener("keydown", handleExamEnterKey);
  examNameInput.addEventListener("keydown", handleExamEnterKey);

  // Single delegated listener for the exam results list, wired once here
  // instead of re-attaching per-row listeners on every renderExamResultsList()
  // call. Rows themselves are plain innerHTML (no listeners to leak), and
  // clicks bubble up to this one handler regardless of how many results
  // are logged.
  if (examResultsList) {
    examResultsList.addEventListener("click", function (e) {
      const editBtn = e.target.closest(".exam-edit-btn");
      if (editBtn) { startEditExamResult(editBtn.dataset.id); return; }
      const deleteBtn = e.target.closest(".exam-delete-btn");
      if (deleteBtn) { deleteExamResult(deleteBtn.dataset.id); return; }
    });
  }

  function toggleLocalBackupSection() {
    const isOpen = localBackupContent.style.display !== "none";
    localBackupContent.style.display = isOpen ? "none" : "block";
    localBackupChevron.classList.toggle("expanded", !isOpen);
    localBackupToggle.setAttribute("aria-expanded", String(!isOpen));
  }
  // localBackupToggle is a native <button>, so Enter/Space already trigger
  // this click listener via the browser's built-in button activation
  // behavior — no separate keydown handler needed.
  localBackupToggle.addEventListener("click", toggleLocalBackupSection);
  modalCancelBtn.addEventListener("click", cancelModal);
  modalConfirmBtn.addEventListener("click", function () {
    if (typeof pendingConfirmAction === "function") pendingConfirmAction();
  });
  modalMergeBtn.addEventListener("click", function () {
    if (typeof pendingSecondaryAction === "function") pendingSecondaryAction();
  });
  // Tapping the dark backdrop (outside the box) also cancels
  confirmOverlay.addEventListener("click", function (e) {
    if (e.target === confirmOverlay) cancelModal();
  });

  // Escape key closes the modal (same as Cancel), and Tab is trapped
  // inside the dialog while it's open so keyboard focus can't leak out
  // to the page behind it.
  document.addEventListener("keydown", function (e) {
    if (!confirmOverlay.classList.contains("show")) return;

    if (e.key === "Escape") {
      cancelModal();
      return;
    }

    if (e.key === "Tab") {
      const focusable = getFocusableModalElements();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  exportBtn.addEventListener("click", exportData);
  if (linkFileBtn) linkFileBtn.addEventListener("click", handleLinkButtonClick);

  // Enter submits from either field: adds a new session, or saves changes
  // when in edit mode.
  function handleEnterKey(e) {
    if (e.key === "Enter") {
      if (editingSession) { saveEdit(); } else { addEntry(); }
    }
  }
  hoursInput.addEventListener("keydown", handleEnterKey);
  dateInput.addEventListener("keydown", handleEnterKey);
  noteInput.addEventListener("keydown", handleEnterKey);

  // Daily goal: gear icon reveals an inline editor; Save validates and
  // persists, Cancel just hides the row again without changing anything.
  goalEditBtn.addEventListener("click", function () {
    goalInput.value = goalHours;
    goalEditRow.classList.add("show");
    goalInput.focus();
  });

  goalCancelBtn.addEventListener("click", function () {
    goalEditRow.classList.remove("show");
  });

  goalSaveBtn.addEventListener("click", function () {
    const value = parseFloat(goalInput.value);
    if (isNaN(value) || value <= 0) {
      showToast("Enter a valid goal greater than 0.", true);
      return;
    }
    if (value > 24) {
      showToast("Daily goal can't exceed 24 hours.", true);
      return;
    }

    goalHours = roundTo(value, 2);
    saveGoalHours(goalHours);
    goalEditRow.classList.remove("show");
    refreshAll();
    showToast("Daily goal updated");
  });

  // Dismissing the streak-risk banner only silences it for the rest of
  // today (tracked in sessionStorage), not permanently.
  streakRiskDismiss.addEventListener("click", function () {
    sessionStorage.setItem(DISMISS_KEY, toISODate(new Date()));
    streakRiskBanner.classList.remove("show");
  });

  // Re-check the streak-risk banner once a minute, so it can appear on its
  // own as 6 PM passes without requiring the user to interact with the app.
  setInterval(updateStreakRiskBanner, 60000);

  // ---------------------------------------------------------------------
  // Light/dark theme toggle
  //
  // Three effective states:
  //  - No stored preference yet: theme follows the OS/browser's
  //    prefers-color-scheme, live (if the system theme changes while the
  //    app is open, the app follows along).
  //  - Stored preference ("light" or "dark"): the user's explicit choice
  //    always wins, regardless of what the system is set to, until they
  //    tap the toggle again.
  //
  // This is a per-device display preference (like the existing chart-type
  // choice's local half), not part of the reading data itself, so it's
  // intentionally NOT included in export/cloud sync — signing in on
  // another device keeps that device's own theme.
  // ---------------------------------------------------------------------
  const THEME_KEY = "readingHoursTheme";
  const prefersDarkMql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function getStoredTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return (v === "light" || v === "dark") ? v : null;
    } catch (e) {
      return null;
    }
  }

  function resolveTheme() {
    const stored = getStoredTheme();
    if (stored) return stored;
    return (prefersDarkMql && prefersDarkMql.matches) ? "dark" : "light";
  }

  // Applies a theme to the DOM + button icon, and re-renders the chart so
  // its colors (grid lines, line stroke/fill — see getChartThemeColors())
  // match. Does NOT touch localStorage — used both for the user's explicit
  // choice (via setTheme, below) and for transiently following a system
  // preference change when the user hasn't chosen one of their own.
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if (themeToggleBtn) {
      const goingTo = theme === "dark" ? "light" : "dark";
      themeToggleBtn.innerHTML = theme === "dark"
        ? '<svg class="icon" aria-hidden="true"><use href="#icon-sun"></use></svg>'
        : '<svg class="icon" aria-hidden="true"><use href="#icon-moon"></use></svg>';
      themeToggleBtn.setAttribute("aria-label", "Switch to " + goingTo + " mode");
      themeToggleBtn.title = "Switch to " + goingTo + " mode";
    }
    if (chartInstance) renderChart();
  }

  function setTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* privacy mode etc — theme just won't persist */ }
    applyTheme(theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || resolveTheme();
    setTheme(current === "dark" ? "light" : "dark");
  }

  if (themeToggleBtn) themeToggleBtn.addEventListener("click", toggleTheme);

  // Follow the system theme live, but only while the user hasn't made an
  // explicit choice of their own (a stored preference always wins).
  if (prefersDarkMql) {
    const handleSystemThemeChange = function (e) {
      if (!getStoredTheme()) applyTheme(e.matches ? "dark" : "light");
    };
    if (prefersDarkMql.addEventListener) {
      prefersDarkMql.addEventListener("change", handleSystemThemeChange);
    } else if (prefersDarkMql.addListener) {
      // Safari < 14 fallback
      prefersDarkMql.addListener(handleSystemThemeChange);
    }
  }

  // The small script in <head> already set data-theme on <html> before
  // first paint (avoiding a flash of the wrong theme); this just syncs the
  // toggle button's icon/label to match on startup.
  applyTheme(document.documentElement.getAttribute("data-theme") || resolveTheme());

  // ---------------------------------------------------------------------
  // Bottom nav: switches between the Study and Performance sections.
  // Study holds all existing functionality; Performance is a placeholder
  // for now (exam results + graphs land in a later phase). The last
  // section visited is remembered across reloads, same pattern as the
  // theme/chart-type preferences above.
  // ---------------------------------------------------------------------
  const NAV_SECTION_KEY = "readingHoursActiveSection";
  const VALID_SECTIONS = ["study", "performance"];

  const SECTION_CONTENT = {
    study: {
      title: "Study Hour Tracker",
      subtitle: "Log study sessions by subject and build your streak",
      icon: "icon-book",
      el: studySection
    },
    performance: {
      title: "Performance",
      subtitle: "Track your exam results over time",
      icon: "icon-bars",
      el: performanceSection
    }
  };

  function getSavedSection() {
    try {
      const v = localStorage.getItem(NAV_SECTION_KEY);
      return VALID_SECTIONS.indexOf(v) !== -1 ? v : "study";
    } catch (e) {
      return "study";
    }
  }

  // Slides the pill-shaped highlight behind whichever tab is active.
  // Measured via getBoundingClientRect (rather than a fixed CSS %) so it
  // stays correct regardless of container padding or viewport width.
  function updateNavIndicator(activeBtn) {
    if (!bottomNav || !bottomNavIndicator || !activeBtn) return;
    const navRect = bottomNav.getBoundingClientRect();
    const tabRect = activeBtn.getBoundingClientRect();
    bottomNavIndicator.style.width = tabRect.width + "px";
    bottomNavIndicator.style.transform = "translateX(" + (tabRect.left - navRect.left) + "px)";
  }

  function setActiveSection(section) {
    if (!SECTION_CONTENT[section]) return;

    Object.keys(SECTION_CONTENT).forEach(function (key) {
      SECTION_CONTENT[key].el.classList.toggle("active", key === section);
    });

    if (headerTitleTextEl) headerTitleTextEl.textContent = SECTION_CONTENT[section].title;
    if (headerIconUseEl) headerIconUseEl.setAttribute("href", "#" + SECTION_CONTENT[section].icon);
    if (headerSubtitleEl) headerSubtitleEl.textContent = SECTION_CONTENT[section].subtitle;

    navTabButtons.forEach(function (btn) {
      const isActive = btn.dataset.section === section;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
      if (isActive) updateNavIndicator(btn);
    });

    try { localStorage.setItem(NAV_SECTION_KEY, section); } catch (e) { /* privacy mode etc — just won't persist */ }

    // Chart.js sizes its canvas from the container at render/resize time.
    // If a tab's chart(s) were hidden via display:none while switching
    // away and back, an explicit resize ensures they redraw at the
    // correct dimensions now that the container is visible again.
    if (section === "study" && chartInstance) {
      requestAnimationFrame(function () { chartInstance.resize(); });
    }
    if (section === "performance") {
      requestAnimationFrame(function () {
        if (overallChartInstance) overallChartInstance.resize();
        if (subjectChartInstance) subjectChartInstance.resize();
        if (highestVsChartInstance) highestVsChartInstance.resize();
      });
    }
  }

  navTabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () { setActiveSection(btn.dataset.section); });
  });

  // Keep the sliding indicator aligned with the active tab if the viewport
  // is resized (e.g. orientation change) or fonts finish loading and shift
  // tab widths slightly.
  window.addEventListener("resize", function () {
    const activeBtn = document.querySelector(".nav-tab.active");
    if (activeBtn) updateNavIndicator(activeBtn);
  });

  setActiveSection(getSavedSection());

  populateSubjectSelect(subjects.length ? subjects[0].id : null);
  restoreTimerIfAny();
  setTimerButtons();
  updateTimerDisplay();
  updateTimerPermissionWarning();
  refreshAll();
  setActiveOverallRangeButton();
  // refreshAll() already renders the exam list + both Performance charts
  // (see its body above), so no separate refreshPerformance() call is
  // needed here — that used to re-run the same list/chart render + a
  // second localStorage write + a second pass through cloudChangeListeners
  // immediately after refreshAll() had just done it, doubling startup cost
  // for no visible effect.
  setSubjectChartVisible(loadSubjectChartVisible());
  setHighestVsChartVisible(loadHighestVsChartVisible());
  studySubjectsToggle.setVisible(studySubjectsToggle.loadVisible());
  perfSubjectsToggle.setVisible(perfSubjectsToggle.loadVisible());
  restoreLinkedFileOnLoad();

  // ---------------------------------------------------------------------
  // Public API for the cloud-sync module script (Google Sign-In +
  // Firestore) at the bottom of this page. Everything above stays fully
  // functional on local storage alone, whether or not that script loads,
  // runs, or the user ever signs in.
  // ---------------------------------------------------------------------
  window.ReadingHoursApp = {
    getState: function () {
      return {
        subjects: subjects,
        deletedSubjects: deletedSubjects,
        sessionsData: sessionsData,
        examResults: examResults,
        goalHours: goalHours,
        milestonesAwarded: milestonesAwarded,
        chartType: currentChartType
      };
    },
    // Replaces local state wholesale (used when pulling a cloud copy on
    // sign-in) and persists it back to localStorage + re-renders. Does NOT
    // itself notify cloud listeners (callers manage that with a guard) so
    // pulling from the cloud can't immediately bounce right back to it.
    setState: function (state) {
      if (state.subjects) subjects = state.subjects;
      if (state.deletedSubjects) deletedSubjects = state.deletedSubjects;
      if (state.sessionsData) sessionsData = state.sessionsData;
      if (Array.isArray(state.examResults)) examResults = state.examResults;
      if (typeof state.goalHours === "number" && state.goalHours > 0 && state.goalHours <= 24) goalHours = state.goalHours;
      if (state.milestonesAwarded) milestonesAwarded = state.milestonesAwarded;
      if (state.chartType && VALID_CHART_TYPES.indexOf(state.chartType) !== -1) {
        currentChartType = state.chartType;
        saveChartType(currentChartType);
        setActiveChartTypeButton();
      }
      exitEditMode();
      exitExamEditMode();
      expandedDates = new Set();
      saveSubjects(subjects);
      saveDeletedSubjects(deletedSubjects);
      saveSessions(sessionsData);
      saveExamResults(examResults);
      saveGoalHours(goalHours);
      saveMilestones(milestonesAwarded);
      renderStats();
      renderAllSubjectLists();
      populateSubjectSelect(subjects.length ? subjects[0].id : null);
      renderEntriesList();
      renderExamResultsList();
      renderChart();
      renderGoalProgress();
      updateStreakRiskBanner();
    },
    onCloudChange: function (callback) {
      if (typeof callback === "function") cloudChangeListeners.push(callback);
    }
  };

})();
