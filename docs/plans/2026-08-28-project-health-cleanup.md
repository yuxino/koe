# Koe Project Health and Debt Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use the repository's normal verification commands and keep all work on the current `main` checkout.

**Goal:** Audit Koe's extension, Helper, Native Messaging installer, release package, and documentation; then fix the highest-value bounded issues without broad stress testing or unrelated cleanup.

**Architecture:** Preserve the current extension/Helper protocol and manual-start product model. Establish a clean Git and test baseline, rank concrete findings by user impact and release risk, add focused regressions before behavior changes, and keep release artifacts generated from the existing explicit allow-list.

**Tech Stack:** Manifest V3 JavaScript, Node.js regression scripts, Swift Package Manager, zsh installer and release scripts, macOS Native Messaging.

---

### Task 1: Establish the protected baseline

**Files:**
- Inspect: `manifest.json`
- Inspect: `helper/Package.swift`
- Inspect: `Install Koe.command`
- Inspect: `scripts/package-release.sh`

**Steps:**

1. Confirm the current branch, worktree status, local `HEAD`, and `origin/main` SHA.
2. Record tracked and ignored generated files without deleting anything.
3. Run every `test/*.test.js` script and record failures.
4. Run `swift run --package-path helper koe-helper-core-checks` and `swift test --package-path helper`.
5. Run the release packager and validate the resulting ZIP layout.

### Task 2: Audit runtime and release contracts

**Files:**
- Inspect: `background.js`, `content.js`, `offscreen.js`, `popup.js`, `sidepanel.js`, `preferences.js`, `media-discovery.js`
- Inspect: `helper/Sources/KoeHelper/**`
- Inspect: `helper/Sources/KoeHelperCore/**`
- Inspect: `Install Koe.command`, `helper/scripts/install-ego-lite.sh`, `scripts/*.sh`
- Inspect: `README.md`, `README_ZH.md`, `helper/README.md`, `release/README.txt`

**Steps:**

1. Search for TODO/FIXME/HACK markers, unreachable paths, stale version strings, and orphaned runtime files.
2. Trace extension start/stop/session ownership and Native Messaging request/response boundaries.
3. Compare extension ID, host names, protocol versions, Helper payload hashes, install locations, and release allow-list entries.
4. Compare user-visible documentation with current runtime behavior and platform limitations.
5. Rank findings as user-impacting bugs, release blockers, or confirmed dead material; do not remove uncertain items.

### Task 3: Fix the highest-priority bounded findings

**Files:**
- Modify only the runtime, test, installer, packaging, or documentation files implicated by confirmed findings.
- Test under `test/*.test.js` or `helper/Sources/KoeHelperCoreChecks/main.swift` as appropriate.

**Steps:**

1. Add a focused regression that demonstrates each selected defect.
2. Run the focused test and confirm it fails for the intended reason.
3. Implement the smallest compatible fix without changing unrelated product behavior.
4. Rerun the focused test and adjacent contract tests.
5. Remove code or files only when repository-wide references and release/runtime allow-lists prove they are unused.

### Task 4: Verify the repaired repository

**Files:** all task-related changes.

**Steps:**

1. Run all JavaScript regression scripts.
2. Run Swift Helper core checks and package tests.
3. Run installer/package contract validation without changing the user's installed browser profile.
4. If runtime browser proof is necessary, use only ego-lite for a short, ordinary flow and verify the target tab before capture.
5. Run `git diff --check`, inspect staged paths, and confirm no unrelated changes are included.

### Task 5: Deliver on `main`

**Files:** all validated task-related changes.

**Steps:**

1. Stage only this task's files and inspect `git diff --cached --name-status`.
2. Commit the verified cleanup on the current `main` branch.
3. Fetch and ensure `origin/main` has not diverged before pushing.
4. Push `main`, compare local `HEAD` with `git ls-remote origin refs/heads/main`, and report remaining worktree state.
