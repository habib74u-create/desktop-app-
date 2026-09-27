// scripts/after-pack.js
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * electron-builder afterPack hook.
 * Called once per platform/arch combo.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch, packager } = context;
  const projectDir = packager.projectDir;
  const platform = electronPlatformName; // 'win32' | 'darwin' | 'linux'

  console.log(`\n[after-pack] platform=${platform} arch=${arch} out=${appOutDir}`);

  // ---- 1. Locate the .app / unpacked app root ----------------------------
  const appName = packager.appInfo.productFilename; // e.g. "Jarvis"
  const appRoot =
    platform === 'darwin'
      ? path.join(appOutDir, `${appName}.app`)
      : platform === 'win32'
      ? path.join(appOutDir) // resources/ sits beside the .exe
      : path.join(appOutDir);

  const resourcesDir =
    platform === 'darwin'
      ? path.join(appRoot, 'Contents', 'Resources')
      : path.join(appRoot, 'resources');

  console.log(`[after-pack] resources: ${resourcesDir}`);

  // ---- 2. Stage platform-specific ffmpeg --------------------------------
  stageFfmpeg(projectDir, resourcesDir, platform);

  // ---- 3. Remove dev-only artifacts -------------------------------------
  pruneDevArtifacts(resourcesDir);

  // ---- 4. Strip .map files from the packaged app ------------------------
  stripSourceMaps(resourcesDir);

  // ---- 5. Ensure executables keep +x on unix ----------------------------
  if (platform !== 'win32') {
    ensureExecutable(path.join(resourcesDir, 'ffmpeg', 'ffmpeg'));
    ensureExecutable(path.join(resourcesDir, 'ffmpeg', 'ffprobe'));
  }

  // ---- 6. Platform-specific touches -------------------------------------
  if (platform === 'darwin') {
    ensureMacOsMetadata(appRoot, packager);
  }

  console.log(`[after-pack] done\n`);
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function stageFfmpeg(projectDir, resourcesDir, platform) {
  const folder =
    platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';

  const src = path.join(projectDir, 'assets', 'ffmpeg', folder);
  const dst = path.join(resourcesDir, 'ffmpeg');

  if (!fs.existsSync(src)) {
    console.warn(`[after-pack] ⚠ no ffmpeg source at ${src} — skipping`);
    return;
  }

  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });

  for (const file of fs.readdirSync(src)) {
    const s = path.join(src, file);
    const d = path.join(dst, file);
    fs.copyFileSync(s, d);
    if (platform !== 'win32') fs.chmodSync(d, 0o755);
    console.log(`[after-pack]   staged ffmpeg/${file}`);
  }
}

function pruneDevArtifacts(resourcesDir) {
  const appAsarUnpacked = path.join(resourcesDir, 'app.asar.unpacked');
  const junkDirs = ['test', 'tests', '__tests__', 'example', 'examples', '.github'];

  const targets = [resourcesDir, appAsarUnpacked];

  for (const root of targets) {
    if (!fs.existsSync(root)) continue;
    for (const name of junkDirs) {
      walkAndRemove(root, (p) => path.basename(p) === name);
    }
  }
}

function walkAndRemove(root, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (predicate(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`[after-pack]   pruned ${path.relative(root, full)}`);
    } else if (e.isDirectory()) {
      walkAndRemove(full, predicate);
    }
  }
}

function stripSourceMaps(root) {
  walkAndRemove(root, (p) => p.endsWith('.map'));
}

function ensureExecutable(file) {
  if (!fs.existsSync(file)) return;
  const mode = fs.statSync(file).mode;
  fs.chmodSync(file, mode | 0o111);
}

function ensureMacOsMetadata(appRoot, packager) {
  const plist = path.join(appRoot, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return;

  // electron-builder already writes most keys; we just sanity-check LSUIElement
  const info = packager.appInfo;
  console.log(`[after-pack]   macOS app: ${info.productFilename} v${info.version}`);
}
