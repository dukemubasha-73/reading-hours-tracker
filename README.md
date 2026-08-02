# Reading Hours Tracker

A lightweight, installable Progressive Web App for tracking study time and exam performance — works fully offline, syncs across devices if you want it to, and never requires an account to use.

## Features

**Study Tracking**
- Log study sessions by subject, with custom colors and notes
- Built-in timer with pause/resume, accurate even if the app is backgrounded or the OS kills the process
- Daily goal tracking with progress bar and celebration animation
- Study streaks with best-streak history and an end-of-day "streak at risk" reminder
- Bar/line charts of hours over 7/14/30-day ranges, broken down by subject
- Milestone badges for total hours and streak length

**Performance Tracking**
- Log exam/test results by subject with optional exam name
- Overall performance trend chart and per-subject trend chart
- Color-coded score tiers

**Data & Sync**
- Works fully offline — all data stored locally, no account required
- Optional Google sign-in for cross-device sync (Firebase/Firestore)
- Export/import to JSON, plus optional auto-save to a linked local file
- Installable as a home-screen app (PWA) with offline support via service worker

**Polish**
- Light/dark mode (follows system preference or manual toggle)
- Fully responsive, mobile-first design

## Tech Stack
Vanilla JavaScript, Chart.js, Firebase (Auth + Firestore), Service Worker for offline/PWA support — no build step, no framework, single HTML file.
