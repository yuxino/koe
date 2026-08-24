# Koe Lightweight Install Design

## Goal

Make the source archive usable by a non-developer on an Apple Silicon Mac without shipping Swift build caches or the Whisper model. The supported first release path is macOS 15 or newer with ego-lite. The only unavoidable browser action is loading the unpacked extension once.

## Approaches considered

1. **Build the Helper on the user's Mac.** This keeps Git small, but requires Swift 6, Xcode 26, network access, and a matching SDK. It remains available as the developer fallback, not the default install path.
2. **Ship one precompiled Helper with a small installer.** This adds about 2.8 MB uncompressed to Git, removes Xcode and terminal knowledge from the user path, and keeps the 626 MB Whisper model as a first-use download. This is the selected approach.
3. **Ship a signed and notarized PKG/DMG.** This is the final public-distribution shape, but it requires a Developer ID identity and notarization credentials that are not present on this machine. The lightweight installer must not pretend to provide that trust level.

## Distribution layout

The repository contains `Install Koe.command` and a checked-in Apple Silicon Helper at `helper/bin/macos-arm64/koe-helper`. A packaging script builds a strict allow-list ZIP containing only:

- `Install Koe.command`
- `Koe Extension/` with the Manifest V3 runtime files and three extension icons
- `Resources/koe-helper`, its checksum, and release metadata
- concise install instructions and third-party notices

The package never copies `helper/.build`, `.swiftpm`, Git history, tests, plans, or model data. The package test rejects unexpected files and archives larger than 10 MB.

## Extension identity

`manifest.json` receives a public development `key`, which gives unpacked copies a stable ID across extraction paths. The corresponding private key is deliberately not stored or claimed as a future store signing identity. The installer derives the extension ID directly from the public key and compares it with the checked-in expected ID before writing any Native Messaging configuration.

This changes the ID of existing development installs once. Existing users remove the old unpacked Koe entry, load the directory again, and rerun the installer. Non-secret preferences can be restored from the native mirror; a DashScope key stored under the old browser-extension origin must be entered again.

## Installer behavior

The installer runs without `sudo`, Swift, Xcode, or an API key. It:

1. validates Apple Silicon and macOS 15 or newer;
2. locates either the repository payload or the release-bundle payload;
3. validates the Helper checksum, executable format, minimum OS, and code-signature structure;
4. copies it into an immutable, versioned directory under `~/Library/Application Support/Koe/versions/`;
5. writes exact-origin Native Messaging manifests for Chrome and ego-lite using temporary files and atomic renames;
6. starts the Helper with an empty input stream and validates its framed `ready` response;
7. stops only older Helper processes whose exact command path is inside Koe's install directory;
8. opens ego-lite's extension page and prints the remaining load-unpacked action.

Test-only destination overrides are accepted only when `KOE_INSTALLER_TEST=1`; production paths cannot be redirected through arbitrary environment variables. The installer never removes quarantine metadata, requests `sudo`, or runs destructive workspace cleanup.

## Trust boundary

The checked-in Helper is an ad-hoc-signed preview binary. Its SHA-256 checksum protects against accidental corruption inside the bundle, not against a compromised repository. A fully frictionless public release still requires a Developer ID-signed and Apple-notarized app, PKG, or DMG. The README states this honestly while keeping the current Git-based preview install short.

## Verification

Automated checks cover stable ID derivation, private-key exclusion, source and release layouts, checksum failures, clean install, idempotent reinstall, Native Messaging manifest contents, framed Helper readiness, and maximum archive size. The existing JavaScript and Swift core regression suites remain required before push.
