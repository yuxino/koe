# Koe Lightweight Install Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an Apple Silicon macOS 15+ user download the small repository archive, double-click one installer, load Koe once in ego-lite, and use local subtitles without Xcode.

**Architecture:** Commit only two optimized Helper executables—one macOS 15 compatibility build and one macOS 26 Translation build—never their build directory or model. Give the unpacked extension a stable development ID, select and install one Helper into a versioned per-user directory, register exact Native Messaging origins, and produce a release ZIP from an explicit runtime allow-list.

**Tech Stack:** Manifest V3, zsh/macOS system tools, Swift Helper binary, Node.js regression tests.

---

### Task 1: Lock the extension identity

**Files:**
- Modify: `manifest.json`
- Create: `test/install-package.test.js`

**Steps:**

1. Add a failing test that decodes `manifest.key`, derives the Chrome ID using SHA-256, expects `dajnahkneeemkfndhdbanekjhmndgmej`, and rejects any tracked private key.
2. Run `node test/install-package.test.js`; expect the missing-key assertion to fail.
3. Add the public development key to `manifest.json`.
4. Rerun the test; expect the identity checks to pass.

### Task 2: Add the lightweight Helper payload

**Files:**
- Create: `helper/bin/macos-arm64/koe-helper`
- Create: `helper/bin/macos-arm64/koe-helper.sha256`
- Create: `helper/bin/macos26-arm64/koe-helper`
- Create: `helper/bin/macos26-arm64/koe-helper.sha256`
- Modify: `.gitignore`

**Steps:**

1. Extend the failing test to require both arm64 executables below 10 MB with matching SHA-256 values and to prove `helper/.build` remains ignored.
2. Build the compatibility payload with the macOS 15.4 SDK and native Translation disabled; preserve the macOS 26 payload with Translation linked.
3. Add `dist/` to `.gitignore`.
4. Run the package test; expect all payload assertions to pass.

### Task 3: Implement and test the installer

**Files:**
- Create: `Install Koe.command`
- Modify: `test/install-package.test.js`
- Replace: `helper/scripts/install-ego-lite.sh`

**Steps:**

1. Add failing sandboxed install tests using temporary destinations and `KOE_INSTALLER_TEST=1`.
2. Implement platform, OS-variant selection, checksum, ID, safe version, JSON-manifest, versioned-install, quarantine, exact-process, and Helper-ready protocol checks.
3. Make the legacy script delegate to the root installer and reject the old extension-ID argument.
4. Run release-layout installer tests for macOS 15 and 26 selection, a clean install, idempotent reinstall, corrupt-install repair, and quarantine recovery; expect exact paths and one allowed origin in both manifests.

### Task 4: Build the strict release package

**Files:**
- Create: `scripts/package-release.sh`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `licenses/argmax-oss-swift-MIT.txt`
- Create: `licenses/Apache-2.0.txt`
- Modify: `test/install-package.test.js`

**Steps:**

1. Add a failing package-layout test that rejects source, caches, models, and archives above 10 MB.
2. Implement an explicit 17-file extension allow-list and release metadata generation.
3. Include the relevant third-party license texts with the Helper distribution.
4. Run the package script and inspect the ZIP listing; expect only the documented release layout.

### Task 5: Rewrite user installation documentation

**Files:**
- Modify: `README_ZH.md`
- Modify: `README.md`
- Modify: `helper/README.md`

**Steps:**

1. Put the three-step Git archive install path first.
2. State the approximate download/install sizes, first-use model download, Apple Silicon/macOS support, two-Helper behavior, safe upgrade path, one-time ID migration, and preview-signing limitation.
3. Move Swift/Xcode compilation into a developer fallback section.
4. Remove the obsolete requirement to manually copy an extension ID.

### Task 6: Verify, commit, and push

**Files:** all changed files.

**Steps:**

1. Run `node test/install-package.test.js`.
2. Run every `test/*.test.js` file.
3. Run the checked-in Helper core checks and the packaged installer smoke test.
4. Run `git diff --check`, inspect the tracked-file size, ZIP size, status, and diff.
5. Commit the validated design, implementation, binary payload, tests, and docs.
6. Push `main` to `origin` and verify the remote commit.
