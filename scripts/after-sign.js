// scripts/after-sign.js
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * electron-builder afterSign hook.
 * @param {import('electron-builder').AfterSignContext} context
 */
exports.default = async function afterSign(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  if (electronPlatformName !== 'darwin') {
    console.log(`[after-sign] skipping non-macOS platform (${electronPlatformName})`);
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const entitlementsPath = path.join(
    packager.projectDir,
    'certificates',
    'entitlements.mac.plist'
  );

  console.log(`\n[after-sign] verifying ${appPath}`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[after-sign] app bundle not found: ${appPath}`);
  }

  // ---- 1. Verify the signature -----------------------------------------
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'inherit',
    });
    console.log('[after-sign] ✓ codesign verify passed');
  } catch (err) {
    throw new Error(`[after-sign] codesign verify FAILED: ${err.message}`);
  }

  // ---- 2. Dump entitlements and confirm critical ones ------------------
  let entitlementsDump = '';
  try {
    entitlementsDump = execFileSync(
      'codesign',
      ['-d', '--entitlements', ':-', appPath],
      { encoding: 'utf8' }
    );
  } catch (err) {
    // codesign writes the plist to stderr; capture it
    entitlementsDump = err.stderr ? err.stderr.toString() : '';
  }

  const required = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.device.audio-input',
  ];

  for (const key of required) {
    if (!entitlementsDump.includes(key)) {
      console.warn(`[after-sign] ⚠ missing entitlement: ${key}`);
    } else {
      console.log(`[after-sign] ✓ entitlement present: ${key}`);
    }
  }

  // ---- 3. Check if a notarization ticket is already stapled ------------
  try {
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
    console.log('[after-sign] ✓ notarization ticket is stapled');
  } catch {
    console.log('[after-sign] ℹ no stapled ticket yet — notarization will run separately');
  }

  // ---- 4. Gatekeeper assessment ----------------------------------------
  try {
    execFileSync('spctl', ['-a', '-vvv', '-t', 'exec', appPath], { stdio: 'inherit' });
    console.log('[after-sign] ✓ Gatekeeper accepted');
  } catch {
    console.log('[after-sign] ℹ Gatekeeper rejected (expected before notarization)');
  }

  console.log('[after-sign] done\n');
};