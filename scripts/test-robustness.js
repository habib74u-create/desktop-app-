// scripts/test-robustness.js
'use strict';

/**
 * Post-build robustness checks.
 * Usage: node scripts/test-robustness.js <path-to-app-binary-or-app>
 *
 * On macOS, pass the .app; the script resolves Contents/MacOS/<name>.
 * On Windows, pass the .exe.
 * On Linux, pass the AppImage or unpacked binary.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/test-robustness.js <app-path>');
  process.exit(2);
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

check('app binary exists', () => {
  if (!fs.existsSync(target)) throw new Error(`not found: ${target}`);
});

check('ffmpeg binary is bundled and executable', () => {
  const resources = resolveResourcesDir(target);
  const ffmpeg = path.join(resources, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!fs.existsSync(ffmpeg)) throw new Error(`missing: ${ffmpeg}`);
  if (process.platform !== 'win32') {
    fs.accessSync(ffmpeg, fs.constants.X_OK);
  }
  const out = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' });
  if (!/ffmpeg version/i.test(out)) throw new Error('ffmpeg -version failed');
});

check('sounds are bundled', () => {
  const resources = resolveResourcesDir(target);
  const sound = path.join(resources, 'sounds', 'confetti-pop.mp3');
  if (!fs.existsSync(sound)) throw new Error(`missing: ${sound}`);
  const size = fs.statSync(sound).size;
  if (size < 1024) throw new Error(`sound suspiciously small: ${size} bytes`);
});

check('app.asar present', () => {
  const resources = resolveResourcesDir(target);
  const asar = path.join(resources, 'app.asar');
  if (!fs.existsSync(asar)) throw new Error(`missing: ${asar}`);
});

check('no source maps shipped', () => {
  const resources = resolveResourcesDir(target);
  const found = findFirst(resources, (p) => p.endsWith('.map'));
  if (found) throw new Error(`found source map: ${found}`);
});

check('app launches and stays alive >5s', async () => {
  const bin = resolveExecutable(target);
  const child = spawn(bin, ['--no-sandbox', '--disable-gpu'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const exitedEarly = new Promise((_, rej) =>
    child.once('exit', (code) => rej(new Error(`app exited early with code ${code}\n${stderr}`)))
  );

  await Promise.race([
    new Promise((res) => setTimeout(res, 5000)),
    exitedEarly,
  ]);

  child.kill('SIGTERM');
  await new Promise((res) => child.once('exit', res));

  if (/FATAL|Uncaught|cannot find module/i.test(stderr)) {
    throw new Error(`fatal error in stderr:\n${stderr}`);
  }
});

check('local Fastify server responds on /health (if enabled)', async () => {
  // Only run if your app exposes a health endpoint and honors JARVIS_PORT
  const port = process.env.JARVIS_PORT || 43117;
  await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      res.resume();
      resolve();
    });
    req.on('error', () => reject(new Error('health endpoint unreachable')));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
});

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    process.stdout.write(`[test] ${name} ... `);
    try {
      await fn();
      console.log('PASS');
    } catch (err) {
      console.log('FAIL');
      console.error(`       ${err.message}`);
      failed++;
    }
  }
  console.log(`\n[test] ${checks.length - failed}/${checks.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function resolveResourcesDir(target) {
  if (target.endsWith('.app')) {
    return path.join(target, 'Contents', 'Resources');
  }
  // Windows / Linux unpacked
  const dir = path.dirname(target);
  const candidates = [
    path.join(dir, 'resources'),
    path.join(dir, '..', 'resources'),
    path.join(dir, '..', '..', 'resources'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'app.asar'))) return c;
  }
  throw new Error(`could not locate resources dir near ${target}`);
}

function resolveExecutable(target) {
  if (target.endsWith('.app')) {
    const name = path.basename(target, '.app');
    return path.join(target, 'Contents', 'MacOS', name);
  }
  return target;
}

function findFirst(root, predicate) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (predicate(full)) return full;
    }
  }
  return null;
}