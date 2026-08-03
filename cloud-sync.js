  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
  import {
    getAuth, GoogleAuthProvider, signInWithPopup, signInWithCredential,
    signOut, onAuthStateChanged
  } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
  import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

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

  // One Tap (Google Identity Services) — an additional, optional way to
  // sign in that can appear automatically as a small native prompt, without
  // needing a popup. The regular "Sign in with Google" button (using
  // signInWithPopup below) keeps working exactly as before regardless of
  // whether One Tap is available/loaded/dismissed — this is purely an
  // added convenience layered on top, never a replacement.
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
    if (currentUid) return; // never prompt while already signed in
    const gsi = window.google && window.google.accounts && window.google.accounts.id;
    if (!gsi) return; // library hasn't loaded yet; harmless no-op
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
      gsi.prompt(); // no-op if the browser doesn't support it or the user
                     // recently dismissed it — safe to call freely.
    } catch (e) {
      console.warn("One Tap prompt failed", e);
    }
  }

  const signInBtn = document.getElementById("cloudSignInBtn");
  const signOutBtn = document.getElementById("cloudSignOutBtn");
  const cloudUserEl = document.getElementById("cloudUser");
  const cloudUserPhoto = document.getElementById("cloudUserPhoto");
  const cloudUserName = document.getElementById("cloudUserName");
  const cloudStatus = document.getElementById("cloudStatus");

  let currentUid = null;
  let pushTimer = null;
  let pushListenerRegistered = false; // guards against onAuthStateChanged
                                       // firing more than once per session
                                       // (e.g. sign out then back in) and
                                       // stacking duplicate listeners.
  let applyingRemoteState = false; // true while setState() is applying a
                                    // cloud pull, so that re-render doesn't
                                    // immediately queue a push right back.
  const PUSH_DEBOUNCE_MS = 1000;

  function setStatus(text, isWarning) {
    cloudStatus.textContent = text;
    cloudStatus.style.color = isWarning ? "#d93025" : "";
  }

  function queuePush() {
    if (!currentUid || applyingRemoteState) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushToCloud, PUSH_DEBOUNCE_MS);
  }

  function pushToCloud() {
    if (!currentUid || !window.ReadingHoursApp) return;
    const state = window.ReadingHoursApp.getState();
    setDoc(doc(db, "users", currentUid), state)
      .then(function () {
        setStatus("☁️ Synced " + new Date().toLocaleTimeString());
      })
      .catch(function (err) {
        console.error("Cloud sync (push) failed", err);
        setStatus("⚠️ Sync failed — will retry on next change", true);
      });
  }

  function syncOnSignIn(uid) {
    const ref = doc(db, "users", uid);
    setStatus("☁️ Connecting…");
    getDoc(ref).then(function (snap) {
      if (snap.exists()) {
        applyingRemoteState = true;
        window.ReadingHoursApp.setState(snap.data());
        applyingRemoteState = false;
        setStatus("☁️ Loaded your synced data");
      } else {
        const state = window.ReadingHoursApp.getState();
        return setDoc(ref, state).then(function () {
          setStatus("☁️ Backed up this device's data to your account");
        });
      }
    }).catch(function (err) {
      console.error("Cloud sync (initial) failed", err);
      setStatus("⚠️ Couldn't reach the cloud — still saved on this device", true);
    });
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
      setStatus("Signed out — using this device's storage only");
      tryShowOneTap();
    }
  });

  // Retry showing One Tap once the Google Identity Services script finishes
  // loading, in case it loads after the initial auth-state check above.
  window.addEventListener("load", function () {
    setTimeout(tryShowOneTap, 300);
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
