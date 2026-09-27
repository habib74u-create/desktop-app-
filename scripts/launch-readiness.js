// scripts/launch-readiness.js
'use strict';

/**
 * Pre-flight check. Run before `electron-builder`.
 * Usage: node scripts/launch-readiness.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];

function must(relPath, { type = 'file' } = {}) {
  const p = path.join(ROOT, relPath);
  if (!fs.existsSync(p)) {
    errors.push(`missing ${type}: ${relPath}`);
    return false;
  }
  if (type === 'dir' && !fs.statSync(p).isDirectory()) {
    errors.push(`not a directory: ${relPath}`);
    return false;
  }
  if (type === 'file' && !fs.statSync(p).isFile()) {
    errors.push(`not a file: ${relPath}`);
    return false;
  }
  return true;
}

function warn(msg) { warnings.push(msg); }

/* ---- 1. Required root files -------------------------------------------- */
console.log('==> Checking root files');
must('package.json');
must('package-lock.json');
must('tsconfig.json');
must('webpack.config.js');
must('electron-builder.yml');

/* ---- 2. Source tree ----------------------------------------------------- */
console.log('==> Checking source tree');
const requiredSources = [
  'src/main.ts',
  'src/preload.ts',
  'src/renderer/index.html',
  'src/renderer/index.tsx',
  'src/core/logger.ts',
  'src/services/window-manager.ts',
  'src/ipc/ipc-handlers.ts',
];
for (const s of requiredSources) must(s);

/* ---- 3. Assets ---------------------------------------------------------- */
console.log('==> Checking assets');
must('assets', { type: 'dir' });
must('assets/icon.png');
must('assets/sounds/confetti-pop.mp3');

// Icon size sanity check (electron-builder wants 1024x1024)
const icon = path.join(ROOT, 'assets', 'icon.png');
if (fs.existsSync(icon)) {
  const size = fs.statSync(icon).size;
  if (size < 10_000) warn(`assets/icon.png is only ${size} bytes — likely too small (need 1024x1024)`);
}

// ffmpeg per-platform
for (const plat of ['win', 'mac', 'linux']) {
  const dir = path.join(ROOT, 'assets', 'ffmpeg', plat);
  if (!fs.existsSync(dir)) {
    warn(`assets/ffmpeg/${plat} missing — builds for ${plat} will lack ffmpeg`);
  }
}

/* ---- 4. Certificates ---------------------------------------------------- */
console.log('==> Checking certificates');
must('certificates/entitlements.mac.plist');

/* ---- 5. Build output ---------------------------------------------------- */
console.log('==> Checking build output (dist/)');
if (!fs.existsSync(path.join(ROOT, 'dist'))) {
  errors.push('dist/ missing — run `npm run build` first');
} else {
  must('dist/main.js');
  must('dist/preload.js');
  must('dist/renderer/index.html');
}

/* ---- 6. Native modules built for Electron ------------------------------- */
console.log('==> Checking native modules');
const nativeModules = ['better-sqlite3'];
for (const mod of nativeModules) {
  const modDir = path.join(ROOT, 'node_modules', mod);
  if (!fs.existsSync(modDir)) {
    warn(`native module not installed: ${mod}`);
    continue;
  }
  const buildDir = path.join(modDir, 'build', 'Release');
  if (!fs.existsSync(buildDir)) {
    errors.push(`${mod} not built for Electron — run \`npx electron-rebuild\``);
  }
}

/* ---- 7. binding.gyp (optional) ------------------------------------------ */
if (fs.existsSync(path.join(ROOT, 'binding.gyp'))) {
  const gyp = path.join(ROOT, 'build', 'Release');
  if (!fs.existsSync(gyp)) {
    warn('binding.gyp present but build/Release missing — native build may be stale');
  }
}

/* ---- 8. Node & npm versions -------------------------------------------- */
console.log('==> Checking toolchain');
const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split('.')[0], 10);
if (major < 18) errors.push(`Node ${nodeVersion} is too old — need >= 18`);
else console.log(`    node ${nodeVersion} OK`);

try {
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  console.log(`    npm  ${npmVersion} OK`);
} catch {
  warn('could not determine npm version');
}

/* ---- Report ------------------------------------------------------------- */
console.log('\n================ READINESS REPORT ================');

if (warnings.length) {
  console.log(`\n⚠  ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`   - ${w}`);
}

if (errors.length) {
  console.log(`\n✗  ${errors.length} error(s):`);
  for (const e of errors) console.log(`   - ${e}`);
  console.log('\nLaunch readiness: FAILED\n');
  process.exit(1);
}

console.log('\n✓ Launch readiness: PASSED\n');