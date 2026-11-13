// Pure checks only: nothing here starts the app, so a malformed launch can never reach a real profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  acquireProfileLock,
  buildDevArgs,
  findChangedFiles,
  findUnsafeLinks,
  forceKillProcessGroup,
  inspectProfileMarker,
  parseCommandLine,
  parseOptions,
  pidAlive,
  platformConfigRoot,
  prepareProfile,
  processGroupAlive,
  profileInUse,
  profileRoots,
  readReportedUserData,
  resolveTarget,
  runOwnedSession,
  stopProcessGroup,
  TARGETS,
  validateDevArgs,
  validateElectronArgv,
  validateReusableProfile,
  validateRuntimePaths,
  validateUserDataDir,
  withOwnedGroup,
  writeProfileMarker,
} from './isolated-dev-launch.mjs';

const tempRoot = realpathSync(os.tmpdir());
const sandbox = mkdtempSync(path.join(tempRoot, 'isolated-launch-test-'));
after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const profile = path.join(sandbox, 'profile');
const port = 9339;
const switches = [`--user-data-dir=${profile}`, `--remote-debugging-port=${String(port)}`, '--use-mock-keychain'];
const electron = ['/x/Electron.app/Contents/MacOS/Electron', '/x/apps/desktop'];

test('the dev launch passes exactly one separator before the isolation switches', () => {
  const args = buildDevArgs(profile, port);
  assert.deepEqual(args, ['run', 'dev', '--', ...switches]);
  assert.equal(validateDevArgs(args, profile, port), null);
});

test('a doubled separator is refused before anything is spawned', () => {
  assert.match(validateDevArgs(['run', 'dev', '--', '--', ...switches], profile, port), /exactly one "--"/);
  assert.match(validateDevArgs(['run', 'dev', ...switches], profile, port), /exactly one "--"/);
  assert.match(validateDevArgs(['run', 'dev', '--', ...switches.slice(1)], profile, port), /must be exactly/);
});

test('a live Electron command line is accepted only with every switch ahead of any separator', () => {
  assert.equal(validateElectronArgv([...electron, ...switches], profile, port), null);
  assert.match(validateElectronArgv([...electron, '--', ...switches], profile, port), /Chromium ignores/);
  assert.match(validateElectronArgv([...electron, switches[1], switches[2]], profile, port), /without --user-data-dir/);
  assert.match(
    validateElectronArgv([...electron, '--user-data-dir=/other', switches[1], switches[2]], profile, port),
    /expected --user-data-dir=/,
  );
  assert.match(validateElectronArgv([...electron, ...switches, switches[0]], profile, port), /expected --user-data-dir=/);
  assert.match(validateElectronArgv([...electron, switches[0], switches[1]], profile, port), /without --use-mock-keychain/);
});

test('ps and /proc command lines parse into the same arguments', () => {
  assert.deepEqual(parseCommandLine(`${[...electron, ...switches].join(' ')}\n`), [...electron, ...switches]);
  assert.deepEqual(parseCommandLine(`${[...electron, ...switches].join('\0')}\0`), [...electron, ...switches]);
});

test('the app must report the temporary profile and keep SQLite inside it', () => {
  const database = path.join(profile, 'bitsentry.db');
  assert.equal(validateRuntimePaths({ reportedUserData: profile, sqlitePath: database }, profile), null);
  assert.match(validateRuntimePaths({ reportedUserData: undefined, sqlitePath: database }, profile), /did not report its user-data/);
  assert.match(
    validateRuntimePaths({ reportedUserData: '/Users/me/Library/Application Support/@bitsentry-ce/desktop', sqlitePath: database }, profile),
    /expected/,
  );
  assert.match(validateRuntimePaths({ reportedUserData: profile, sqlitePath: undefined }, profile), /did not report its SQLite/);
  assert.match(
    validateRuntimePaths({ reportedUserData: profile, sqlitePath: '/Users/me/Library/Application Support/BitSentry Desktop/bitsentry.db' }, profile),
    /outside/,
  );
});

test('a profile directory that could alias a real profile is refused', () => {
  const configRoot = path.join(sandbox, 'config');
  const roots = profileRoots(configRoot);
  assert.equal(validateUserDataDir(path.join(sandbox, 'fresh'), roots, tempRoot), null);
  assert.match(validateUserDataDir(path.join(configRoot, '@bitsentry-ce/desktop'), roots, tempRoot), /overlaps a profile folder/);
  assert.match(validateUserDataDir(configRoot, roots, tempRoot), /overlaps a profile folder/);
  assert.match(validateUserDataDir('/not/temporary', roots, tempRoot), /temporary directory/);
  assert.match(validateUserDataDir(path.join(sandbox, 'has space'), roots, tempRoot), /whitespace/);
  const used = path.join(sandbox, 'used');
  mkdirSync(used);
  writeFileSync(path.join(used, 'bitsentry.db'), '');
  assert.match(validateUserDataDir(used, roots, tempRoot), /new and empty/);
});

test('profile roots cover the dev, packaged CE and Pro folders on each platform', () => {
  assert.equal(platformConfigRoot('darwin', {}, '/h'), '/h/Library/Application Support');
  assert.equal(platformConfigRoot('linux', {}, '/h'), '/h/.config');
  assert.equal(platformConfigRoot('linux', { XDG_CONFIG_HOME: '/x' }, '/h'), '/x');
  const names = profileRoots('/c').map((root) => path.relative('/c', root));
  for (const name of ['@bitsentry-ce/desktop', 'BitSentry Desktop', 'BitSentry Desktop Pro', 'Electron']) {
    assert.ok(names.includes(name), name);
  }
});

test('a file written into a profile folder after launch is reported, older files are not', () => {
  const root = path.join(sandbox, 'fake-profile');
  mkdirSync(path.join(root, 'Local Storage'), { recursive: true });
  const old = path.join(root, 'Preferences');
  writeFileSync(old, '{}');
  const past = new Date(Date.now() - 60_000);
  utimesSync(old, past, past);
  const launchedAt = Date.now() - 1000;
  assert.deepEqual(findChangedFiles([root, path.join(sandbox, 'missing')], launchedAt), []);
  const fresh = path.join(root, 'Local Storage', '000003.log');
  writeFileSync(fresh, 'x');
  assert.deepEqual(findChangedFiles([root], launchedAt), [fresh]);
});

/** Replaces one fs function for the duration of `body`, including the module's named ESM import of it. */
function withPatchedFs(name, replacement, body) {
  const original = fs[name];
  fs[name] = replacement(original);
  syncBuiltinESMExports();
  try {
    return body();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}

const fsError = (code) => Object.assign(new Error(code), { code });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('an unreadable profile folder refuses instead of passing as unchanged', () => {
  const locked = path.join(sandbox, 'locked-profile');
  mkdirSync(path.join(locked, 'Local Storage'), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    if (process.getuid?.() !== 0) assert.throws(() => findChangedFiles([locked], 0), /cannot inspect .*EACCES/);
  } finally {
    chmodSync(locked, 0o700);
  }
  const denied = path.join(sandbox, 'denied-profile');
  mkdirSync(denied);
  withPatchedFs('readdirSync', (original) => (target, ...rest) => {
    if (target === denied) throw fsError('EPERM');
    return original(target, ...rest);
  }, () => {
    assert.throws(() => findChangedFiles([denied], 0), /cannot inspect .*EPERM/);
  });
  withPatchedFs('statSync', (original) => (target, ...rest) => {
    if (path.basename(target) === 'Preferences') throw fsError('EIO');
    return original(target, ...rest);
  }, () => {
    const root = path.join(sandbox, 'io-profile');
    mkdirSync(root);
    writeFileSync(path.join(root, 'Preferences'), '{}');
    assert.throws(() => findChangedFiles([root], 0), /cannot inspect .*EIO/);
  });
});

test('an absent profile root or an entry removed mid-walk is not a change', () => {
  const root = path.join(sandbox, 'racing-profile');
  mkdirSync(root);
  writeFileSync(path.join(root, 'vanished.log'), 'x');
  writeFileSync(path.join(root, 'written.log'), 'x');
  withPatchedFs('statSync', (original) => (target, ...rest) => {
    if (path.basename(target) === 'vanished.log') throw fsError('ENOENT');
    return original(target, ...rest);
  }, () => {
    assert.deepEqual(findChangedFiles([path.join(sandbox, 'never-created'), root], 0), [path.join(root, 'written.log')]);
  });
});

/** Starts a detached synthetic process group whose leader prints the pid of a descendant it keeps in the group. */
function startGroup(leaderScript) {
  const leader = spawn(process.execPath, ['-e', leaderScript], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const descendant = new Promise((resolve) => {
    leader.stdout.once('data', (chunk) => { resolve(Number(chunk.toString().trim())); });
  });
  return { leader, descendant };
}

const IGNORE_TERM_CHILD = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a descendant that ignores SIGTERM is killed and the whole group is confirmed gone', async () => {
  const { leader, descendant } = startGroup(`
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_TERM_CHILD)}], { stdio: 'ignore' });
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const descendantPid = await descendant;
  assert.equal(processGroupAlive(leader.pid), true);
  assert.equal(await stopProcessGroup(leader.pid, { termGraceMs: 300, killGraceMs: 3000 }), 'killed');
  assert.equal(processGroupAlive(leader.pid), false);
  assert.equal(alive(descendantPid), false);
});

test('a descendant left behind after its leader exited is still stopped', async () => {
  const { leader, descendant } = startGroup(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    child.unref();
    process.stdout.write(String(child.pid) + '\\n', () => process.exit(0));
  `);
  const descendantPid = await descendant;
  await new Promise((resolve) => { if (leader.exitCode === null) leader.once('exit', resolve); else resolve(); });
  assert.equal(processGroupAlive(leader.pid), true);
  assert.equal(await stopProcessGroup(leader.pid, { termGraceMs: 3000, killGraceMs: 3000 }), 'terminated');
  assert.equal(alive(descendantPid), false);
  assert.equal(processGroupAlive(leader.pid), false);
});

test('an inspection error inside the owned section still stops the group', async () => {
  const { leader, descendant } = startGroup(`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const descendantPid = await descendant;
  await assert.rejects(
    withOwnedGroup(leader, () => { throw new Error('ps failed while reading the Electron command line'); }, { termGraceMs: 3000 }),
    /ps failed/,
  );
  assert.equal(processGroupAlive(leader.pid), false);
  assert.equal(alive(descendantPid), false);
});

// A command line the shell runs as a QA driver that never finishes and ignores SIGTERM.
const HANGING_DRIVER = `"${process.execPath}" -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`;
const startApp = (script) => spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
const fastStop = { termGraceMs: 300, killGraceMs: 3000 };

test('SIGTERM to the launcher alone stops a hanging driver and the app, and exits non-zero', async () => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, 'isolated-dev-launch.mjs')).href;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { runOwnedSession } from ${JSON.stringify(moduleUrl)};
    const app = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_TERM_CHILD)}], { detached: true, stdio: 'ignore' });
    const result = await runOwnedSession({
      child: app,
      verifyLaunch: async () => null,
      exec: ${JSON.stringify(HANGING_DRIVER)},
      execEnv: process.env,
      stopOptions: { termGraceMs: 300, killGraceMs: 3000 },
      onDriverStart: (driver) => { console.log(JSON.stringify({ app: app.pid, driver })); },
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.failures.length > 0 ? 1 : result.exitCode;
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = [];
  harness.stdout.on('data', (chunk) => { lines.push(...chunk.toString().trim().split('\n')); });
  for (const deadline = Date.now() + 10_000; lines.length === 0 && Date.now() < deadline;) await sleep(50);
  const { app, driver } = JSON.parse(lines[0]);
  assert.equal(processGroupAlive(app), true);
  assert.equal(processGroupAlive(driver), true);
  const startedStop = Date.now();
  harness.kill('SIGTERM');
  const code = await new Promise((resolve) => { harness.once('exit', resolve); });
  assert.ok(Date.now() - startedStop < 10_000, 'the launcher must exit within the bounded stop time');
  assert.notEqual(code, 0);
  assert.match(lines.at(-1), /interrupted while the QA command was running/);
  assert.equal(processGroupAlive(driver), false);
  assert.equal(processGroupAlive(app), false);
});

test('the app exiting while the driver hangs fails the run and stops the driver group', async () => {
  let driverPid;
  const result = await runOwnedSession({
    child: startApp('setTimeout(() => process.exit(0), 400)'),
    verifyLaunch: async () => null,
    exec: HANGING_DRIVER,
    execEnv: process.env,
    stopOptions: fastStop,
    onDriverStart: (pid) => { driverPid = pid; },
  });
  assert.deepEqual(result.failures, ['the app exited while the QA command was running']);
  assert.equal(processGroupAlive(driverPid), false);
});

test('a failing driver gives a non-zero exit and both groups are stopped', async () => {
  const app = startApp(IGNORE_TERM_CHILD);
  let driverPid;
  const result = await runOwnedSession({
    child: app,
    verifyLaunch: async () => null,
    exec: `"${process.execPath}" -e "process.exit(7)"`,
    execEnv: process.env,
    stopOptions: fastStop,
    onDriverStart: (pid) => { driverPid = pid; },
  });
  assert.deepEqual(result, { failures: [], exitCode: 7 });
  assert.equal(processGroupAlive(driverPid), false);
  assert.equal(processGroupAlive(app.pid), false);
});

test('a successful driver exits zero and both groups are stopped', async () => {
  const app = startApp('setInterval(() => {}, 1000)');
  let driverPid;
  const result = await runOwnedSession({
    child: app,
    verifyLaunch: async () => null,
    exec: `"${process.execPath}" -e "process.exit(0)"`,
    execEnv: process.env,
    stopOptions: fastStop,
    onDriverStart: (pid) => { driverPid = pid; },
  });
  assert.deepEqual(result, { failures: [], exitCode: 0 });
  assert.equal(processGroupAlive(driverPid), false);
  assert.equal(processGroupAlive(app.pid), false);
});

/** A fake checkout whose apps/desktop is `packageName`, with the plugin SDK build at each of `sdkDists`. */
function fakeCheckout(name, packageName, sdkDists) {
  const repo = path.join(sandbox, name);
  mkdirSync(path.join(repo, 'apps', 'desktop'), { recursive: true });
  if (packageName !== undefined) {
    writeFileSync(path.join(repo, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: packageName }));
  }
  for (const dist of sdkDists) mkdirSync(path.join(repo, ...dist), { recursive: true });
  return repo;
}
const ceSdk = ['packages', 'plugin-sdk', 'dist'];
const proSdk = ['apps', 'desktop-ce', 'packages', 'plugin-sdk', 'dist'];

test('the target defaults to ce and only ce or pro is accepted', () => {
  const scriptCheckout = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  // Reuse and forced close are off unless asked for: the default launch is still a fresh, empty profile.
  assert.deepEqual(parseOptions([]), { target: 'ce', repo: scriptCheckout, port: 9339, exec: undefined, reuseProfile: undefined, allowForceClose: false });
  assert.equal(parseOptions(['--', '--target', 'pro', '--repo', '/m']).target, 'pro');
  assert.equal(parseOptions(['--target', 'pro', '--repo', '/m']).repo, path.resolve('/m'));
  assert.throws(() => parseOptions(['--target', 'Pro']), /unknown --target Pro/);
  assert.throws(() => parseOptions(['--target', 'dashboard']), /unknown --target dashboard/);
  assert.throws(() => parseOptions(['--target']), /missing value for --target/);
  assert.throws(() => resolveTarget('toString', sandbox), /unknown --target toString/);
});

test('ce resolves the desktop-ce checkout app and its own plugin SDK build', () => {
  const repo = fakeCheckout('ce-checkout', '@bitsentry-ce/desktop', [ceSdk]);
  assert.deepEqual(resolveTarget('ce', repo), {
    desktopDir: path.join(repo, 'apps', 'desktop'),
    sdkDistDir: path.join(repo, ...ceSdk),
  });
});

test('pro resolves the monorepo app and the plugin SDK build inside the desktop-ce submodule', () => {
  const repo = fakeCheckout('monorepo-checkout', '@bitsentry/desktop', [proSdk]);
  assert.deepEqual(resolveTarget('pro', repo), {
    desktopDir: path.join(repo, 'apps', 'desktop'),
    sdkDistDir: path.join(repo, ...proSdk),
  });
});

test('a checkout whose app is the other product is refused for either target', () => {
  const ce = fakeCheckout('ce-only', '@bitsentry-ce/desktop', [ceSdk, proSdk]);
  const pro = fakeCheckout('pro-only', '@bitsentry/desktop', [ceSdk, proSdk]);
  assert.throws(() => resolveTarget('pro', ce), /--target pro needs apps\/desktop to be @bitsentry\/desktop.*has @bitsentry-ce\/desktop/);
  assert.throws(() => resolveTarget('ce', pro), /--target ce needs apps\/desktop to be @bitsentry-ce\/desktop.*has @bitsentry\/desktop/);
  const unnamed = fakeCheckout('unnamed', undefined, [ceSdk]);
  writeFileSync(path.join(unnamed, 'apps', 'desktop', 'package.json'), '{}');
  assert.throws(() => resolveTarget('ce', unnamed), /has undefined/);
});

test('a missing or unreadable app manifest is refused', () => {
  assert.throws(() => resolveTarget('ce', fakeCheckout('no-manifest', undefined, [ceSdk])), /cannot read .*package\.json \(ENOENT\)/);
  const broken = fakeCheckout('broken-manifest', undefined, [ceSdk]);
  writeFileSync(path.join(broken, 'apps', 'desktop', 'package.json'), '{');
  assert.throws(() => resolveTarget('ce', broken), /cannot read .*package\.json/);
});

test('each target needs its own plugin SDK build, not the other layout', () => {
  const proWithCeLayout = fakeCheckout('pro-ce-layout', '@bitsentry/desktop', [ceSdk]);
  assert.throws(
    () => resolveTarget('pro', proWithCeLayout),
    /apps\/desktop-ce\/packages\/plugin-sdk\/dist is missing; run `pnpm --dir apps\/desktop-ce --filter @bitsentry\/plugin-sdk build`/,
  );
  const ceWithProLayout = fakeCheckout('ce-pro-layout', '@bitsentry-ce/desktop', [proSdk]);
  assert.throws(
    () => resolveTarget('ce', ceWithProLayout),
    /^Error: packages\/plugin-sdk\/dist is missing; run `pnpm --filter @bitsentry\/plugin-sdk build`/,
  );
});

test('the ce target names this checkout app, and the Pro dev profile stays a guarded root', () => {
  const scriptCheckout = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(scriptCheckout, 'apps', 'desktop', 'package.json'), 'utf8'));
  assert.equal(manifest.name, TARGETS.ce.packageName);
  const configRoot = path.join(sandbox, 'config-pro');
  const roots = profileRoots(configRoot);
  assert.ok(roots.includes(path.join(configRoot, TARGETS.pro.packageName)));
  assert.match(validateUserDataDir(path.join(configRoot, '@bitsentry/desktop'), roots, tempRoot), /overlaps a profile folder/);
});

// ---- Relaunching a launcher-created profile (Task 732) ----

const uid = process.getuid?.() ?? -1;
const realRoots = [path.join(sandbox, 'config', '@bitsentry-ce/desktop'), path.join(sandbox, 'config', 'Electron')];
/** A profile this launcher would have created: a fresh private folder in the temp area plus its marker. */
function makeProfile(target = 'ce') {
  const dir = realpathSync(mkdtempSync(path.join(sandbox, 'bitsentry-qa-')));
  writeProfileMarker(dir, target);
  return dir;
}
const reusable = (dir, extra = {}) => validateReusableProfile(dir, { target: 'ce', roots: realRoots, tempRoot, commands: [], isAlive: () => false, ...extra });

test('reuse and forced close are explicit options, and reuse needs the absolute printed path', () => {
  const options = parseOptions(['--reuse-profile', '/tmp/bitsentry-qa-x', '--allow-force-close', '--port', '9400']);
  assert.equal(options.reuseProfile, '/tmp/bitsentry-qa-x');
  assert.equal(options.allowForceClose, true);
  assert.equal(options.port, 9400);
  assert.equal(parseOptions(['--allow-force-close']).allowForceClose, true);
  assert.throws(() => parseOptions(['--reuse-profile', 'relative/bitsentry-qa-x']), /absolute profile path/);
  assert.throws(() => parseOptions(['--reuse-profile']), /missing value for --reuse-profile/);
});

test('a profile with the launcher marker for the same target is accepted for reuse', () => {
  const dir = makeProfile();
  assert.equal(reusable(dir), null);
  assert.match(inspectProfileMarker(dir, { target: 'ce' }).marker.nonce, /^[0-9a-f]{32}$/);
});

test('a folder name alone is not provenance: a populated bitsentry-qa-* folder without the marker is refused untouched', () => {
  const dir = realpathSync(mkdtempSync(path.join(sandbox, 'bitsentry-qa-')));
  writeFileSync(path.join(dir, 'bitsentry.db'), 'someone else data');
  assert.match(reusable(dir), /no launcher marker/);
  assert.deepEqual(readdirSync(dir), ['bitsentry.db']);
});

test('reuse is refused outside the temporary folder, over a real profile, for a missing folder or another name', () => {
  assert.match(reusable('/not/temporary/bitsentry-qa-x'), /inside the system temporary directory/);
  assert.match(reusable(path.join(realRoots[0], 'bitsentry-qa-x')), /overlaps a profile folder/);
  assert.match(reusable(path.join(sandbox, 'bitsentry-qa-missing')), /does not exist/);
  const renamed = makeProfile();
  const other = path.join(sandbox, 'plain-folder');
  renameSync(renamed, other);
  assert.match(reusable(other), /does not start with bitsentry-qa-/);
  assert.match(reusable(path.join(sandbox, 'has space', 'bitsentry-qa-x')), /whitespace/);
});

test('a marker for another target, another folder, or a moved folder is refused', () => {
  const pro = makeProfile('pro');
  assert.match(reusable(pro), /created for target pro, not ce/);

  const a = makeProfile();
  const b = makeProfile();
  fs.copyFileSync(path.join(a, '.bitsentry-qa-profile.json'), path.join(b, '.bitsentry-qa-profile.json'));
  assert.match(reusable(b), /different folder/);

  const moved = path.join(sandbox, 'bitsentry-qa-moved');
  renameSync(a, moved);
  assert.match(reusable(moved), /different folder/);
});

test('a link, group-writable or foreign-owned profile folder is refused', () => {
  const dir = makeProfile();
  const link = path.join(sandbox, 'bitsentry-qa-link');
  symlinkSync(dir, link);
  assert.match(reusable(link), /not a link or file/);

  const viaLinkedParent = path.join(sandbox, 'parent-link');
  symlinkSync(sandbox, viaLinkedParent);
  assert.match(reusable(path.join(viaLinkedParent, path.basename(dir))), /symbolic link/);

  chmodSync(dir, 0o770);
  assert.match(reusable(dir), /writable by group or others/);
  chmodSync(dir, 0o700);
  assert.equal(reusable(dir), null);

  assert.match(reusable(dir, { uid: uid + 1 }), /not owned by the current user/);
});

test('a broken, oversized or linked marker is refused', () => {
  const marker = (dir) => path.join(dir, '.bitsentry-qa-profile.json');
  const broken = makeProfile();
  writeFileSync(marker(broken), '{not json');
  assert.match(reusable(broken), /not valid JSON/);

  const unknown = makeProfile();
  writeFileSync(marker(unknown), JSON.stringify({ schema: 2, kind: 'other' }));
  assert.match(reusable(unknown), /unknown format/);

  const large = makeProfile();
  writeFileSync(marker(large), 'x'.repeat(5000));
  assert.match(reusable(large), /too large/);

  const linked = makeProfile();
  const real = marker(linked);
  const copy = path.join(sandbox, 'marker-copy.json');
  renameSync(real, copy);
  symlinkSync(copy, real);
  assert.match(reusable(linked), /not a regular file/);
});

test('symbolic links inside a profile are refused, except Chromium single-instance links at the top level', () => {
  const dir = makeProfile();
  symlinkSync('fake-host-999999', path.join(dir, 'SingletonLock'));
  symlinkSync('/tmp/.org.chromium.fake/SingletonSocket', path.join(dir, 'SingletonSocket'));
  assert.deepEqual(findUnsafeLinks(dir), []);
  assert.equal(reusable(dir), null);

  mkdirSync(path.join(dir, 'Local Storage'));
  symlinkSync(realRoots[0], path.join(dir, 'Local Storage', 'leveldb'));
  assert.match(reusable(dir), /links that could redirect its writes: Local Storage\/leveldb/);

  const nested = makeProfile();
  mkdirSync(path.join(nested, 'Cache'));
  symlinkSync('x', path.join(nested, 'Cache', 'SingletonLock'));
  assert.deepEqual(findUnsafeLinks(nested), ['Cache/SingletonLock']);
  assert.throws(() => findUnsafeLinks(nested, 1), /cannot be inspected completely/);
});

test('a profile in use is refused: a running process, a live single-instance lock, or a live launcher lock', async () => {
  const dir = makeProfile();
  const running = `4242 /x/Electron.app/Contents/MacOS/Electron /x/apps/desktop --user-data-dir=${dir} --remote-debugging-port=9339`;
  assert.match(reusable(dir, { commands: [running] }), /running process already uses this profile \(4242\)/);
  // A folder whose name merely starts the same is not this profile.
  assert.equal(reusable(dir, { commands: [`${running}-other`.replace(`--user-data-dir=${dir}`, `--user-data-dir=${dir}-other`)] }), null);

  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    symlinkSync(`fake-host-${String(holder.pid)}`, path.join(dir, 'SingletonLock'));
    assert.match(validateReusableProfile(dir, { target: 'ce', roots: realRoots, tempRoot, commands: [] }), /held by live process/);
  } finally {
    holder.kill('SIGKILL');
    await new Promise((resolve) => { holder.once('exit', resolve); });
  }
  // The holder is gone, like after a forced close: Chromium cleans such a stale lock itself.
  assert.equal(validateReusableProfile(dir, { target: 'ce', roots: realRoots, tempRoot, commands: [] }), null);
  assert.equal(pidAlive(holder.pid), false);

  const unreadable = makeProfile();
  symlinkSync('no-pid-here', path.join(unreadable, 'SingletonLock'));
  assert.match(reusable(unreadable), /unreadable/);
  assert.match(profileInUse(unreadable, { commands: [] }), /unreadable/);
});

test('the launcher lock refuses a second launcher, is released, and replaces a stale one', () => {
  const dir = makeProfile();
  const release = acquireProfileLock(dir, { pid: process.pid, isAlive: () => true });
  assert.ok(existsSync(path.join(dir, '.bitsentry-qa-launcher.lock')));
  assert.throws(() => acquireProfileLock(dir, { pid: 1, isAlive: () => true }), /held by launcher process/);
  release();
  assert.equal(existsSync(path.join(dir, '.bitsentry-qa-launcher.lock')), false);
  release();

  writeFileSync(path.join(dir, '.bitsentry-qa-launcher.lock'), JSON.stringify({ pid: 999_999 }));
  const again = acquireProfileLock(dir, { pid: process.pid, isAlive: () => false });
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.bitsentry-qa-launcher.lock'), 'utf8')).pid, process.pid);
  again();

  writeFileSync(path.join(dir, '.bitsentry-qa-launcher.lock'), 'garbage');
  assert.throws(() => acquireProfileLock(dir), /unreadable/);
});

test('a new launch still refuses a populated folder, even one the launcher marked', () => {
  const dir = makeProfile();
  assert.match(validateUserDataDir(dir, realRoots, tempRoot), /new and empty/);
});

test('only an app report written at or after the actual start counts, even one written a moment earlier', () => {
  const dir = makeProfile();
  mkdirSync(path.join(dir, 'diagnostics'));
  const report = path.join(dir, 'diagnostics', 'startup-diagnostics.json');
  const startedAt = Date.now();
  const stamp = (offsetMs) => { writeFileSync(report, JSON.stringify({ paths: { userData: dir } })); const at = new Date(startedAt + offsetMs); utimesSync(report, at, at); };
  stamp(-60_000);
  assert.equal(readReportedUserData(dir, startedAt), undefined);
  // The previous session's report, written half a second before this launch, must not pass either.
  stamp(-500);
  assert.equal(readReportedUserData(dir, startedAt), undefined);
  stamp(-1);
  assert.equal(readReportedUserData(dir, startedAt), undefined);
  // utimes takes float seconds, so keep a few ms clear of the boundary on either side.
  stamp(5);
  assert.equal(readReportedUserData(dir, startedAt), dir);
  stamp(50);
  assert.equal(readReportedUserData(dir, startedAt), dir);
  assert.equal(readReportedUserData(path.join(sandbox, 'no-such-profile'), startedAt), undefined);
});

test('a hard-linked file in a profile is refused without reading or changing the file it aliases', () => {
  const dir = makeProfile();
  const sentinel = path.join(sandbox, 'outside-sentinel.db');
  writeFileSync(sentinel, 'outside data that must never be touched');
  const before = fs.statSync(sentinel).mtimeMs;
  linkSync(sentinel, path.join(dir, 'bitsentry.db'));
  assert.match(reusable(dir), /links that could redirect its writes: bitsentry\.db \(hard link, 2 links\)/);
  assert.deepEqual(findUnsafeLinks(dir), ['bitsentry.db (hard link, 2 links)']);
  assert.equal(readFileSync(sentinel, 'utf8'), 'outside data that must never be touched');
  assert.equal(fs.statSync(sentinel).mtimeMs, before);
  // The same inside a subfolder.
  const nested = makeProfile();
  mkdirSync(path.join(nested, 'IndexedDB'));
  linkSync(sentinel, path.join(nested, 'IndexedDB', 'data.ldb'));
  assert.deepEqual(findUnsafeLinks(nested), ['IndexedDB/data.ldb (hard link, 3 links)']);
  // Once the alias is gone the profile is accepted again.
  fs.unlinkSync(path.join(dir, 'bitsentry.db'));
  assert.equal(reusable(dir), null);
});

test('a hard-linked launcher marker is refused before its content is read', () => {
  const dir = makeProfile();
  const marker = path.join(dir, '.bitsentry-qa-profile.json');
  // Not even valid JSON: a refusal for the hard link, not for the content, shows the content was never read.
  writeFileSync(marker, '{garbage');
  linkSync(marker, path.join(sandbox, 'marker-alias.json'));
  assert.match(reusable(dir), /launcher marker is a hard link/);
  assert.match(inspectProfileMarker(dir, { target: 'ce' }).refusal, /hard link/);
});

test('a profile prepared for a fresh launch holds the launcher lock before its marker exists, and blocks a reuse', () => {
  const order = [];
  const writes = fs.writeFileSync;
  withPatchedFs('writeFileSync', (original) => (target, ...rest) => {
    order.push(path.basename(String(target)));
    return original(target, ...rest);
  }, () => {
    const tmp = realpathSync(mkdtempSync(path.join(sandbox, 'prepare-tmp-')));
    const fresh = prepareProfile({ target: 'ce' }, { roots: realRoots, tmp, commands: [] });
    try {
      assert.equal(fresh.reused, false);
      assert.deepEqual(order, ['.bitsentry-qa-launcher.lock', '.bitsentry-qa-profile.json']);
      const lock = JSON.parse(readFileSync(path.join(fresh.userDataDir, '.bitsentry-qa-launcher.lock'), 'utf8'));
      assert.equal(lock.pid, process.pid);
      // A second launcher cannot take the profile while this one holds it, even before any app runs.
      assert.throws(() => prepareProfile({ target: 'ce', reuseProfile: fresh.userDataDir }, { roots: realRoots, tmp, commands: [] }), /held by launcher process/);
      assert.equal(existsSync(path.join(fresh.userDataDir, '.bitsentry-qa-profile.json')), true);
      fresh.release();
      assert.equal(existsSync(path.join(fresh.userDataDir, '.bitsentry-qa-launcher.lock')), false);
      const again = prepareProfile({ target: 'ce', reuseProfile: fresh.userDataDir }, { roots: realRoots, tmp, commands: [] });
      assert.equal(again.reused, true);
      assert.equal(again.marker.nonce, fresh.marker.nonce);
      assert.equal(existsSync(path.join(again.userDataDir, '.bitsentry-qa-launcher.lock')), true);
      again.release();
    } finally {
      fresh.release();
    }
  });
  assert.equal(fs.writeFileSync, writes);
});

test('preparing a profile leaves nothing locked when it is refused or fails', () => {
  const tmp = realpathSync(mkdtempSync(path.join(sandbox, 'prepare-fail-')));
  const stranger = path.join(tmp, 'bitsentry-qa-stranger');
  mkdirSync(stranger, { mode: 0o700 });
  assert.throws(() => prepareProfile({ target: 'ce', reuseProfile: stranger }, { roots: realRoots, tmp, commands: [] }), /no launcher marker/);
  assert.deepEqual(readdirSync(stranger), []);

  withPatchedFs('writeFileSync', (original) => (target, ...rest) => {
    if (path.basename(String(target)) === '.bitsentry-qa-profile.json') throw fsError('ENOSPC');
    return original(target, ...rest);
  }, () => {
    assert.throws(() => prepareProfile({ target: 'ce' }, { roots: realRoots, tmp, commands: [] }), /ENOSPC/);
  });
  for (const name of readdirSync(tmp)) {
    assert.equal(existsSync(path.join(tmp, name, '.bitsentry-qa-launcher.lock')), false, `${name} stays locked`);
  }
});

test('a forced kill ends the whole group at once with no SIGTERM first', async () => {
  const termFile = path.join(sandbox, 'term-seen');
  const app = startApp(`
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(termFile)}, 'term'); process.exit(0); });
    setInterval(() => {}, 1000);
  `);
  await sleep(500);
  assert.equal(processGroupAlive(app.pid), true);
  assert.equal(await forceKillProcessGroup(app.pid), 'killed');
  assert.equal(processGroupAlive(app.pid), false);
  assert.equal(existsSync(termFile), false, 'the app must not get a chance to shut down gracefully');
  assert.equal(await forceKillProcessGroup(app.pid), 'gone');
});

const FORCE_DRIVER = (requestFile, after = 400) => `"${process.execPath}" -e "require('node:fs').writeFileSync(${JSON.stringify(requestFile).replaceAll('"', '\\"')}, 'now'); setTimeout(() => process.exit(0), ${String(after)})"`;

test('the QA command can force-close the verified app once, and that exit is expected', async () => {
  const request = path.join(sandbox, 'force-close-ok');
  const app = startApp('setInterval(() => {}, 1000)');
  let driverPid;
  const result = await runOwnedSession({
    child: app,
    verifyLaunch: async () => null,
    exec: FORCE_DRIVER(request),
    execEnv: process.env,
    stopOptions: fastStop,
    forceClose: { requested: () => existsSync(request), perform: () => forceKillProcessGroup(app.pid) },
    onDriverStart: (pid) => { driverPid = pid; },
  });
  assert.deepEqual(result, { failures: [], exitCode: 0, forcedClose: true });
  assert.equal(processGroupAlive(app.pid), false);
  assert.equal(processGroupAlive(driverPid), false);
});

test('a force-close request is honoured even when the QA command exits at once after making it', async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = path.join(sandbox, `force-close-immediate-${String(attempt)}`);
    const termFile = path.join(sandbox, `term-immediate-${String(attempt)}`);
    const app = startApp(`process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(termFile)}, 'term'); process.exit(0); }); setInterval(() => {}, 1000)`);
    await sleep(300);
    const result = await runOwnedSession({
      child: app,
      verifyLaunch: async () => null,
      // The command creates the request and ends in the same instant, before any poll can see the request first.
      exec: `"${process.execPath}" -e "require('node:fs').writeFileSync(${JSON.stringify(request).replaceAll('"', '\\"')}, 'now')"`,
      execEnv: process.env,
      stopOptions: fastStop,
      forceClose: { requested: () => existsSync(request), perform: () => forceKillProcessGroup(app.pid) },
    });
    assert.deepEqual(result, { failures: [], exitCode: 0, forcedClose: true });
    assert.equal(existsSync(termFile), false, 'the app must be force-closed, not shut down gracefully by the cleanup');
    assert.equal(processGroupAlive(app.pid), false);
  }
});

test('a force-close request that could not be performed fails the run instead of passing quietly', async () => {
  const app = startApp('process.exit(0)');
  await new Promise((resolve) => { app.once('exit', resolve); });
  const result = await runOwnedSession({
    child: app,
    verifyLaunch: async () => null,
    exec: `"${process.execPath}" -e "process.exit(0)"`,
    execEnv: process.env,
    stopOptions: fastStop,
    forceClose: { requested: () => true, perform: async () => { throw new Error('must not run on a dead app'); } },
  });
  assert.ok(result.failures.some((failure) => /force close that was not performed/.test(failure)), JSON.stringify(result));
  assert.equal(result.forcedClose, undefined);
});

test('a force-close request cannot excuse an unexpected app exit, an interrupted run or a failed verification', async () => {
  const early = path.join(sandbox, 'force-close-late');
  const crashed = await runOwnedSession({
    child: startApp('setTimeout(() => process.exit(0), 300)'),
    verifyLaunch: async () => null,
    exec: `"${process.execPath}" -e "setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(early).replaceAll('"', '\\"')}, 'now'); }, 1200); setInterval(() => {}, 1000)"`,
    execEnv: process.env,
    stopOptions: fastStop,
    forceClose: { requested: () => existsSync(early), perform: async () => { throw new Error('must not run'); } },
  });
  assert.deepEqual(crashed.failures, ['the app exited while the QA command was running']);

  const refused = await runOwnedSession({
    child: startApp('setInterval(() => {}, 1000)'),
    verifyLaunch: async () => 'port 9339 is served by a process this launcher did not start',
    exec: FORCE_DRIVER(path.join(sandbox, 'never')),
    execEnv: process.env,
    stopOptions: fastStop,
    forceClose: { requested: () => true, perform: async () => { throw new Error('must not run'); } },
  });
  assert.deepEqual(refused, { failures: ['port 9339 is served by a process this launcher did not start'], exitCode: 0 });
});

test('a failing driver after a forced close keeps its exit code and still stops everything', async () => {
  const request = path.join(sandbox, 'force-close-fail');
  const app = startApp('setInterval(() => {}, 1000)');
  const result = await runOwnedSession({
    child: app,
    verifyLaunch: async () => null,
    exec: `"${process.execPath}" -e "require('node:fs').writeFileSync(${JSON.stringify(request).replaceAll('"', '\\"')}, 'now'); setTimeout(() => process.exit(5), 400)"`,
    execEnv: process.env,
    stopOptions: fastStop,
    forceClose: { requested: () => existsSync(request), perform: () => forceKillProcessGroup(app.pid) },
  });
  assert.deepEqual(result, { failures: [], exitCode: 5, forcedClose: true });
  assert.equal(processGroupAlive(app.pid), false);
});

// A hermetic end-to-end run of the real launcher against a fake Electron-like app. HOME, XDG_CONFIG_HOME and TMPDIR point
// into the sandbox, so no real profile folder is read and every profile the launcher makes lives in the sandbox.
const hasTool = (name) => { try { return fs.readdirSync('/').length > 0 && process.env.PATH.split(path.delimiter).some((dir) => existsSync(path.join(dir, name))); } catch { return false; } };
const e2e = { skip: !hasTool('pnpm') || !hasTool('lsof') || process.platform === 'win32' ? 'needs pnpm and lsof on a POSIX system' : false, timeout: 180_000 };
const freePort = () => new Promise((resolve) => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => { resolve(port); }); }); });

function writeFakeApp() {
  const root = path.join(sandbox, 'e2e');
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'apps', 'desktop'), { recursive: true });
  mkdirSync(path.join(repo, 'packages', 'plugin-sdk', 'dist'), { recursive: true });
  mkdirSync(path.join(root, 'home', '.config'), { recursive: true });
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const dev = path.join(root, 'fake-dev.cjs');
  const electron = path.join(root, 'fake-electron.cjs');
  writeFileSync(path.join(repo, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@bitsentry-ce/desktop', scripts: { dev: `node ${dev}` } }));
  // Like electron-vite: drops its own "--" and starts the app with the switches.
  writeFileSync(dev, `
    const { spawn } = require('node:child_process');
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    const child = spawn(process.execPath, [${JSON.stringify(electron)}, ...args], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
  `);
  // Like Chromium and the app: a single-instance link that only a graceful exit removes, a report and database line after
  // startup, and a growing history that a forced close leaves behind.
  writeFileSync(electron, `
    const fs = require('node:fs');
    const net = require('node:net');
    const path = require('node:path');
    const arg = (name) => process.argv.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
    const dir = arg('--user-data-dir');
    const port = Number(arg('--remote-debugging-port'));
    const lock = path.join(dir, 'SingletonLock');
    try {
      const holder = Number(/-(\\d+)$/.exec(fs.readlinkSync(lock))?.[1]);
      try { process.kill(holder, 0); process.exit(1); } catch (error) { if (error.code !== 'ESRCH') process.exit(1); }
      fs.unlinkSync(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync('fake-host-' + process.pid, lock);
    const history = path.join(dir, 'history.log');
    const graceful = () => { fs.appendFileSync(history, 'graceful-exit\\n'); fs.unlinkSync(lock); process.exit(0); };
    process.on('SIGTERM', graceful);
    process.on('SIGINT', graceful);
    setTimeout(() => {
      fs.mkdirSync(path.join(dir, 'diagnostics'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'diagnostics', 'startup-diagnostics.json'), JSON.stringify({ paths: { userData: dir } }));
      console.log('[database] Initializing SQLite at ' + path.join(dir, 'bitsentry.db'));
      net.createServer().listen(port, '127.0.0.1');
      let n = fs.existsSync(history) ? fs.readFileSync(history, 'utf8').split('\\n').filter(Boolean).length : 0;
      setInterval(() => fs.appendFileSync(history, 'message ' + String(++n) + '\\n'), 100);
    }, 1200);
  `);
  const first = path.join(root, 'driver-first.cjs');
  const second = path.join(root, 'driver-second.cjs');
  writeFileSync(first, `
    const fs = require('node:fs');
    const history = require('node:path').join(process.env.QA_USER_DATA_DIR, 'history.log');
    const lock = require('node:path').join(process.env.QA_USER_DATA_DIR, '.bitsentry-qa-launcher.lock');
    fs.writeFileSync(process.env.QA_LOCK_SEEN, fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : 'missing');
    const poll = () => {
      const lines = fs.existsSync(history) ? fs.readFileSync(history, 'utf8').split('\\n').filter(Boolean).length : 0;
      if (lines < 4) return setTimeout(poll, 100);
      fs.writeFileSync(process.env.QA_FORCE_CLOSE_FILE, 'now');
      setTimeout(() => process.exit(0), 800);
    };
    poll();
  `);
  writeFileSync(second, `
    const fs = require('node:fs');
    const path = require('node:path');
    if (process.env.QA_PROFILE_MODE !== 'reused') process.exit(3);
    const lines = fs.readFileSync(path.join(process.env.QA_USER_DATA_DIR, 'history.log'), 'utf8').split('\\n').filter(Boolean);
    fs.writeFileSync(path.join(${JSON.stringify(root)}, 'recovered.json'), JSON.stringify({ count: lines.length, graceful: lines.includes('graceful-exit') }));
  `);
  return { root, repo, first, second };
}

function runLauncher(args, root) {
  const launcher = path.resolve(import.meta.dirname, 'isolated-dev-launch.mjs');
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home', '.config'), APPDATA: path.join(root, 'home', '.config'), TMPDIR: path.join(root, 'tmp') };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args], { env: { ...env, QA_LOCK_SEEN: path.join(root, 'lock-seen.txt') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => { resolve({ code, output, pid: child.pid }); });
  });
}

test('end to end: force close mid-run, then relaunch the same launcher-created profile and find the history', e2e, async () => {
  const { root, repo, first, second } = writeFakeApp();
  const portOne = await freePort();
  const forced = await runLauncher(['--repo', repo, '--port', String(portOne), '--allow-force-close', '--exec', `node ${first}`], root);
  assert.equal(forced.code, 0, forced.output);
  assert.match(forced.output, /profile \S+ \(new, marker [0-9a-f]{8}\)/);
  // A fresh launch holds the exclusive profile lock while the app and the QA command run.
  assert.equal(JSON.parse(readFileSync(path.join(root, 'lock-seen.txt'), 'utf8')).pid, forced.pid);
  assert.match(forced.output, /READY /);
  assert.match(forced.output, /FORCE-CLOSE requested by the QA command; killing only the app process group/);
  assert.match(forced.output, /FORCE-CLOSE killed; this exit is expected/);
  assert.match(forced.output, /DONE profile \S+ kept for relaunch with --reuse-profile \(the app was force-closed on purpose\)/);
  const profile = /profile (\S+) \(new/.exec(forced.output)[1];
  assert.ok(profile.startsWith(realpathSync(path.join(root, 'tmp'))), 'the profile lives in the sandboxed temporary folder');
  const history = readFileSync(path.join(profile, 'history.log'), 'utf8').split('\n').filter(Boolean);
  assert.ok(history.length >= 4);
  assert.equal(history.includes('graceful-exit'), false, 'the app was killed, not shut down');
  assert.ok(fs.lstatSync(path.join(profile, 'SingletonLock')).isSymbolicLink(), 'the single-instance link of the killed app is left behind, as after a real crash');
  assert.equal(existsSync(path.join(profile, '.bitsentry-qa-launcher.lock')), false);
  assert.equal(readdirSync(realpathSync(path.join(root, 'tmp'))).some((name) => name.startsWith('bitsentry-qactl-')), false, 'the control folder is removed');

  const portTwo = await freePort();
  const relaunched = await runLauncher(['--repo', repo, '--port', String(portTwo), '--reuse-profile', profile, '--exec', `node ${second}`], root);
  assert.equal(relaunched.code, 0, relaunched.output);
  assert.match(relaunched.output, new RegExp(`profile ${profile} \\(reused, marker [0-9a-f]{8}\\)`));
  assert.match(relaunched.output, /READY /);
  const recovered = JSON.parse(readFileSync(path.join(root, 'recovered.json'), 'utf8'));
  assert.ok(recovered.count >= history.length, 'the relaunched app sees the history the killed one wrote');
  assert.equal(recovered.graceful, false);
  assert.equal(existsSync(path.join(profile, '.bitsentry-qa-launcher.lock')), false);
  // Nothing outside the sandbox was written: the real profile folders the launcher guards are the sandboxed ones, and empty.
  assert.deepEqual(readdirSync(path.join(root, 'home', '.config')), []);
});

test('end to end: the launcher refuses to relaunch anything that is not a launcher-created profile, and touches nothing', e2e, async () => {
  const { root, repo, second } = writeFakeApp();
  const tmp = realpathSync(path.join(root, 'tmp'));
  const stranger = path.join(tmp, 'bitsentry-qa-stranger');
  mkdirSync(stranger, { mode: 0o700 });
  writeFileSync(path.join(stranger, 'bitsentry.db'), 'not created by the launcher');
  const refused = await runLauncher(['--repo', repo, '--port', String(await freePort()), '--reuse-profile', stranger, '--exec', `node ${second}`], root);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /REFUSED: the folder has no launcher marker/);
  assert.deepEqual(readdirSync(stranger), ['bitsentry.db']);

  const marked = realpathSync(mkdtempSync(path.join(tmp, 'bitsentry-qa-')));
  writeProfileMarker(marked, 'ce');
  const relative = await runLauncher(['--repo', repo, '--reuse-profile', path.relative(process.cwd(), marked)], root);
  assert.notEqual(relative.code, 0);
  assert.match(relative.output, /absolute profile path/);
  assert.equal(existsSync(path.join(marked, '.bitsentry-qa-launcher.lock')), false);
});
