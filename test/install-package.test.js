const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const expectedExtensionId = "dajnahkneeemkfndhdbanekjhmndgmej";
const expectedProtocolVersion = 1;
const runtimeExtensionFiles = [
  "assets/koe-avatar-16.png",
  "assets/koe-avatar-48.png",
  "assets/koe-avatar-128.png",
  "background.js",
  "content.js",
  "manifest.json",
  "media-discovery.js",
  "offscreen.html",
  "offscreen.js",
  "pcm-worklet.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "preferences.js",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js"
];

function extensionIdFromKey(key) {
  assert.strictEqual(typeof key, "string", "manifest.key must be a string");
  const publicKey = Buffer.from(key, "base64");
  assert(publicKey.length > 0, "manifest.key must decode as Base64");
  assert.strictEqual(publicKey.toString("base64"), key, "manifest.key must use canonical Base64");
  const prefix = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
  return prefix.replace(/[0-9a-f]/g, (digit) => "abcdefghijklmnop"[parseInt(digit, 16)]);
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function filesBelow(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory()
      ? filesBelow(path.join(directory, entry.name), relative)
      : [relative];
  });
}

function readReadyFrame(executable) {
  const result = spawnSync(executable, [], { input: Buffer.alloc(0), maxBuffer: 2 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, result.stderr.toString("utf8"));
  assert(result.stdout.length >= 4, "Helper must return a framed ready response");
  const length = result.stdout.readUInt32LE(0);
  assert(length > 0 && length <= 1024 * 1024, "ready frame length must be valid");
  assert(result.stdout.length >= length + 4, "ready frame must not be truncated");
  return JSON.parse(result.stdout.subarray(4, length + 4).toString("utf8"));
}

function hasQuarantine(file) {
  return spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", file]).status === 0;
}

function installerEnvironment(roots, systemVersion) {
  return {
    ...process.env,
    KOE_INSTALLER_TEST: "1",
    KOE_INSTALL_BASE: roots.installBase,
    KOE_CHROME_HOST_ROOT: roots.chromeHostRoot,
    KOE_EGO_HOST_ROOT: roots.egoHostRoot,
    KOE_LAUNCH_AGENT_ROOT: roots.launchAgentRoot,
    KOE_EGO_USER_DATA_ROOT: roots.egoUserDataRoot,
    KOE_SKIP_BROWSER_OPEN: "1",
    KOE_SKIP_PROCESS_STOP: "1",
    KOE_TEST_ARCH: "arm64",
    KOE_TEST_OS_VERSION: systemVersion
  };
}

function runInstaller(installer, cwd, roots, systemVersion) {
  return spawnSync(installer, [], {
    cwd,
    env: installerEnvironment(roots, systemVersion),
    encoding: "utf8"
  });
}

function makeInstallRoots(sandbox, name) {
  const base = path.join(sandbox, name);
  return {
    installBase: path.join(base, "Application Support/Koe"),
    chromeHostRoot: path.join(base, "Google Chrome/NativeMessagingHosts"),
    egoHostRoot: path.join(base, "Citro Labs/ego lite/NativeMessagingHosts"),
    launchAgentRoot: path.join(base, "LaunchAgents"),
    egoUserDataRoot: path.join(base, "Citro Labs/ego lite")
  };
}

function assertInstalled(roots, expectedDigest, expectedTranslation) {
  const hostName = "app.yuxino.koe.helper.json";
  const paths = [
    path.join(roots.chromeHostRoot, hostName),
    path.join(roots.egoHostRoot, hostName)
  ];
  let installedHelper = "";
  for (const hostManifestPath of paths) {
    const host = JSON.parse(fs.readFileSync(hostManifestPath, "utf8"));
    assert.strictEqual(host.name, "app.yuxino.koe.helper");
    assert.strictEqual(host.type, "stdio");
    assert.deepStrictEqual(host.allowed_origins, [`chrome-extension://${expectedExtensionId}/`]);
    assert(path.isAbsolute(host.path));
    assert(host.path.startsWith(`${roots.installBase}${path.sep}`));
    assert.strictEqual(digest(host.path), expectedDigest);
    installedHelper = host.path;
  }
  assert(fs.statSync(installedHelper).mode & 0o111, "installed Helper must be executable");
  const ready = readReadyFrame(installedHelper);
  assert.deepStrictEqual(
    { type: ready.type, protocolVersion: ready.protocolVersion, nativeTranslation: ready.nativeTranslation },
    { type: "ready", protocolVersion: expectedProtocolVersion, nativeTranslation: expectedTranslation }
  );
  const installedExtension = path.join(roots.installBase, "Extension");
  assert.deepStrictEqual(filesBelow(installedExtension).sort(), [...runtimeExtensionFiles].sort());
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedExtension, "manifest.json"), "utf8"));
  assert.strictEqual(extensionIdFromKey(installedManifest.key), expectedExtensionId);
  assert.strictEqual(installedManifest.version, manifest.version);
  for (const relativePath of runtimeExtensionFiles) {
    assert.strictEqual(fs.lstatSync(path.join(installedExtension, relativePath)).isSymbolicLink(), false,
      `installed extension file must not be a symlink: ${relativePath}`);
  }
  const checksumPath = path.join(roots.installBase, "extension.sha256");
  const checksums = new Map(fs.readFileSync(checksumPath, "utf8").trim().split("\n").map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    assert(match, `invalid extension checksum line: ${line}`);
    return [match[2], match[1]];
  }));
  assert.deepStrictEqual([...checksums.keys()].sort(), [...runtimeExtensionFiles].sort());
  for (const relativePath of runtimeExtensionFiles) {
    assert.strictEqual(digest(path.join(installedExtension, relativePath)), checksums.get(relativePath));
  }

  const installedAutoloader = path.join(roots.installBase, "ensure-ego-extension.zsh");
  const installedDisable = path.join(roots.installBase, "Disable Koe Auto-Load.command");
  for (const executable of [installedAutoloader, installedDisable]) {
    assert(fs.statSync(executable).mode & 0o111, `${path.basename(executable)} must be executable`);
  }
  const launchAgentPath = path.join(roots.launchAgentRoot, "app.yuxino.koe.autoload.plist");
  const launchAgent = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", launchAgentPath], {
    encoding: "utf8"
  }));
  assert.strictEqual(launchAgent.Label, "app.yuxino.koe.autoload");
  const singletonLock = path.join(roots.egoUserDataRoot, "SingletonLock");
  const singletonSocket = path.join(roots.egoUserDataRoot, "SingletonSocket");
  assert.deepStrictEqual(launchAgent.ProgramArguments,
    ["/bin/zsh", installedAutoloader, singletonLock, singletonSocket]);
  assert.strictEqual(launchAgent.KeepAlive?.PathState?.[singletonSocket], true);
  assert.strictEqual(launchAgent.RunAtLoad, undefined);
  assert.strictEqual(launchAgent.StartInterval, undefined);
  assert.strictEqual(launchAgent.WatchPaths, undefined);
  assert.strictEqual(launchAgent.ProcessType, "Background");
  assert.strictEqual(launchAgent.LimitLoadToSessionType, "Aqua");
  assert.strictEqual(launchAgent.ThrottleInterval, 10);
  return installedHelper;
}

assert.strictEqual(extensionIdFromKey(manifest.key), expectedExtensionId);
assert.match(expectedExtensionId, /^[a-p]{32}$/);
assert.match(manifest.version, /^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$/);

const trackedFiles = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
assert(!trackedFiles.some((file) => /(^|\/)(key|private|extension).*\.pem$/i.test(file)), "private keys must not be tracked");
assert(!trackedFiles.some((file) => file.startsWith("helper/.build/")), "Swift build caches must not be tracked");
execFileSync("git", ["check-ignore", "-q", "helper/.build/placeholder"], { cwd: root });

const helperVariants = {
  "macos-arm64": { minimumMacOS: "15.0", nativeTranslation: false, linksTranslation: false },
  "macos26-arm64": { minimumMacOS: "26.0", nativeTranslation: true, linksTranslation: true }
};
for (const [variant, contract] of Object.entries(helperVariants)) {
  const helperPath = path.join(root, "helper/bin", variant, "koe-helper");
  const checksumPath = `${helperPath}.sha256`;
  assert(fs.existsSync(helperPath), `${variant} payload must be checked in`);
  assert(fs.statSync(helperPath).mode & 0o111, `${variant} payload must be executable`);
  assert(fs.statSync(helperPath).size < 2.5 * 1024 * 1024, `${variant} stripped payload must stay below 2.5 MiB`);
  const expectedDigest = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  assert.match(expectedDigest, /^[0-9a-f]{64}$/);
  assert.strictEqual(digest(helperPath), expectedDigest, `${variant} checksum must match`);
  assert.match(execFileSync("/usr/bin/file", [helperPath], { encoding: "utf8" }), /Mach-O 64-bit executable arm64/);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", helperPath]);
  const signature = spawnSync("/usr/bin/codesign", ["-dvv", helperPath], { encoding: "utf8" });
  assert.strictEqual(signature.status, 0, signature.stderr);
  assert.match(`${signature.stdout}${signature.stderr}`, /Identifier=koe-helper/);
  const libraries = execFileSync("/usr/bin/otool", ["-L", helperPath], { encoding: "utf8" });
  assert.strictEqual(libraries.includes("/Translation.framework/"), contract.linksTranslation);
  const ready = readReadyFrame(helperPath);
  assert.deepStrictEqual(
    { type: ready.type, protocolVersion: ready.protocolVersion, nativeTranslation: ready.nativeTranslation },
    { type: "ready", protocolVersion: expectedProtocolVersion, nativeTranslation: contract.nativeTranslation }
  );
  contract.path = helperPath;
  contract.digest = expectedDigest;
  contract.bytes = fs.statSync(helperPath).size;
}

const installerPath = path.join(root, "Install Koe.command");
const packageScript = path.join(root, "scripts/package-release.sh");
const payloadUpdater = path.join(root, "scripts/update-helper-payload.sh");
const autoloaderPath = path.join(root, "release/ensure-ego-extension.zsh");
const disableAutoloadPath = path.join(root, "release/Disable Koe Auto-Load.command");
for (const executable of [installerPath, packageScript, payloadUpdater, autoloaderPath, disableAutoloadPath]) {
  assert(fs.existsSync(executable), `${path.basename(executable)} must exist`);
  assert(fs.statSync(executable).mode & 0o111, `${path.basename(executable)} must be executable`);
}
const autoloaderSource = fs.readFileSync(autoloaderPath, "utf8");
assert.match(autoloaderSource, /taskName = 'koe extension restore ' \+ egoPid/);
assert.match(autoloaderSource, /completeTaskSpace\(taskId, \{ keep: false \}\)/,
  "the loader must close its isolated restore task after verification");
assert.match(autoloaderSource, /target\.ownership === 'user'/,
  "the loader must never complete a user-owned task");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "koe-install-package-test-"));
try {
  const distRoot = path.join(sandbox, "dist with spaces");
  const packaged = spawnSync(packageScript, [], {
    cwd: root,
    env: { ...process.env, KOE_DIST_DIR: distRoot, KOE_CODESIGN_IDENTITY: "" },
    encoding: "utf8"
  });
  assert.strictEqual(packaged.status, 0, `${packaged.stdout}\n${packaged.stderr}`);

  const bundleName = `Koe-${manifest.version}-macOS-arm64`;
  const builtBundleRoot = path.join(distRoot, bundleName);
  const zipPath = path.join(distRoot, `${bundleName}.zip`);
  const extensionFiles = runtimeExtensionFiles.map((file) => `Koe Extension/${file}`);
  const helperFiles = Object.keys(helperVariants).flatMap((variant) => [
    `Resources/${variant}/koe-helper`,
    `Resources/${variant}/koe-helper.sha256`
  ]);
  const expectedPackageFiles = [
    "Install Koe.command",
    "README.txt",
    "Resources/Disable Koe Auto-Load.command",
    "Resources/ensure-ego-extension.zsh",
    "Resources/release.json",
    "THIRD_PARTY_NOTICES.md",
    "licenses/Apache-2.0.txt",
    "licenses/argmax-oss-swift-MIT.txt",
    ...helperFiles,
    ...extensionFiles
  ].sort();
  assert.deepStrictEqual(filesBelow(builtBundleRoot).sort(), expectedPackageFiles);
  assert(fs.existsSync(zipPath));
  assert(fs.statSync(zipPath).size < 10 * 1024 * 1024, "release ZIP must stay below 10 MiB");
  const zipListing = execFileSync("/usr/bin/unzip", ["-Z1", zipPath], { encoding: "utf8" });
  assert(!/(^|\/)(\.build|\.swiftpm|\.git|test|docs)(\/|$)/m.test(zipListing));
  assert(!/(626MB|\.mlmodel|__MACOSX|\/\._|\.DS_Store)/i.test(zipListing));

  const releaseMetadata = JSON.parse(fs.readFileSync(path.join(builtBundleRoot, "Resources/release.json"), "utf8"));
  const expectedHelpers = Object.fromEntries(Object.entries(helperVariants).map(([variant, contract]) => [variant, {
    architecture: "arm64",
    minimumMacOS: contract.minimumMacOS,
    nativeTranslation: contract.nativeTranslation,
    sha256: contract.digest,
    bytes: contract.bytes,
    developerIdSigned: false
  }]));
  assert.deepStrictEqual(releaseMetadata, {
    version: manifest.version,
    extensionId: expectedExtensionId,
    helpers: expectedHelpers,
    developerIdSigned: false,
    notarized: false
  });

  const extractRoot = path.join(sandbox, "解压目录 with spaces");
  fs.mkdirSync(extractRoot, { recursive: true });
  execFileSync("/usr/bin/ditto", ["-x", "-k", zipPath, extractRoot]);
  const releaseRoot = path.join(extractRoot, bundleName);
  const releaseInstaller = path.join(releaseRoot, "Install Koe.command");
  assert(fs.statSync(releaseInstaller).mode & 0o111, "extracted installer must be executable");
  assert(fs.statSync(path.join(releaseRoot, "Resources/ensure-ego-extension.zsh")).mode & 0o111,
    "extracted autoloader must be executable");
  assert(fs.statSync(path.join(releaseRoot, "Resources/Disable Koe Auto-Load.command")).mode & 0o111,
    "extracted disable command must be executable");
  for (const variant of Object.keys(helperVariants)) {
    assert(fs.statSync(path.join(releaseRoot, "Resources", variant, "koe-helper")).mode & 0o111,
      `${variant} must stay executable after ZIP extraction`);
  }

  const roots15 = makeInstallRoots(sandbox, "macOS 15 install");
  const first15 = runInstaller(releaseInstaller, releaseRoot, roots15, "15.0");
  assert.strictEqual(first15.status, 0, `${first15.stdout}\n${first15.stderr}`);
  assert.match(first15.stdout, /兼容 Helper/);
  assert.match(first15.stdout, /自动恢复启动项与受管扩展已完成离线校验/);
  assertInstalled(roots15, helperVariants["macos-arm64"].digest, false);
  fs.writeFileSync(path.join(roots15.installBase, "Extension/stale-development-file.js"), "stale");
  const disabledLaunchAgent = path.join(roots15.launchAgentRoot, "app.yuxino.koe.autoload.plist.disabled");
  fs.copyFileSync(path.join(roots15.launchAgentRoot, "app.yuxino.koe.autoload.plist"), disabledLaunchAgent);
  const second15 = runInstaller(releaseInstaller, releaseRoot, roots15, "15.0");
  assert.strictEqual(second15.status, 0, `${second15.stdout}\n${second15.stderr}`);
  assert.match(second15.stdout, /已经是最新版本/);
  assertInstalled(roots15, helperVariants["macos-arm64"].digest, false);
  assert(!fs.existsSync(path.join(roots15.installBase, "Extension/stale-development-file.js")),
    "reinstall must remove files outside the extension runtime allow-list");
  assert.strictEqual(fs.existsSync(disabledLaunchAgent), false,
    "reinstall must clear the obsolete disabled LaunchAgent backup");
  assert.strictEqual(fs.readdirSync(path.join(roots15.installBase, "versions")).length, 1);

  const quarantinedPayload = path.join(releaseRoot, "Resources/macos26-arm64/koe-helper");
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Koe Test;", quarantinedPayload]);
  assert(hasQuarantine(quarantinedPayload), "the quarantine fixture must be present");
  const roots26 = makeInstallRoots(sandbox, "macOS 26 install");
  const first26 = runInstaller(releaseInstaller, releaseRoot, roots26, "26.0");
  assert.strictEqual(first26.status, 0, `${first26.stdout}\n${first26.stderr}`);
  assert.match(first26.stdout, /已启用 macOS 26 本机中文翻译/);
  assert.match(first26.stdout, /已允许通过完整性校验的 Koe Helper/);
  let installed26 = assertInstalled(roots26, helperVariants["macos26-arm64"].digest, true);
  assert(!hasQuarantine(installed26), "quarantine must be removed from the installed Helper");

  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Koe Test;", installed26]);
  const requarantine = runInstaller(releaseInstaller, releaseRoot, roots26, "26.0");
  assert.strictEqual(requarantine.status, 0, `${requarantine.stdout}\n${requarantine.stderr}`);
  assert.match(requarantine.stdout, /已经是最新版本/);
  assert(!hasQuarantine(installed26), "a verified existing Helper must recover from quarantine");

  fs.writeFileSync(installed26, "corrupt");
  fs.chmodSync(installed26, 0o644);
  const repaired = runInstaller(releaseInstaller, releaseRoot, roots26, "26.0");
  assert.strictEqual(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  installed26 = assertInstalled(roots26, helperVariants["macos26-arm64"].digest, true);
  const versionEntries = fs.readdirSync(path.join(roots26.installBase, "versions"));
  assert.strictEqual(versionEntries.length, 1, "repair must not nest or leak staging directories");
  assert(!versionEntries.some((entry) => /^\.(install|replaced)/.test(entry)));
  const latestAfterRepair = runInstaller(releaseInstaller, releaseRoot, roots26, "26.0");
  assert.strictEqual(latestAfterRepair.status, 0, `${latestAfterRepair.stdout}\n${latestAfterRepair.stderr}`);
  assert.match(latestAfterRepair.stdout, /已经是最新版本/);

  const invalidRoot = path.join(sandbox, "invalid version release");
  fs.cpSync(releaseRoot, invalidRoot, { recursive: true });
  const invalidManifestPath = path.join(invalidRoot, "Koe Extension/manifest.json");
  const invalidManifest = JSON.parse(fs.readFileSync(invalidManifestPath, "utf8"));
  invalidManifest.version = "../../../escaped";
  fs.writeFileSync(invalidManifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`);
  const invalidRoots = makeInstallRoots(sandbox, "invalid version install");
  const invalidInstall = runInstaller(path.join(invalidRoot, "Install Koe.command"), invalidRoot, invalidRoots, "26.0");
  assert.notStrictEqual(invalidInstall.status, 0, "path-like manifest versions must be rejected");
  assert.match(invalidInstall.stderr, /版本格式无效/);
  assert(!filesBelow(sandbox).some((file) => /(^|\/)escaped-[0-9a-f]{12}\//.test(file)));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("install and payload regression PASS");
