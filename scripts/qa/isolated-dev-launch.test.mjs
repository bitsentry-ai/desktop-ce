// Pure checks only: nothing here starts the app, so a malformed launch can never reach a real profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  buildDevArgs,
  findChangedFiles,
  parseCommandLine,
  platformConfigRoot,
  processGroupAlive,
  profileRoots,
  runOwnedSession,
  stopProcessGroup,
  validateDevArgs,
  validateElectronArgv,
  validateRuntimePaths,
  validateUserDataDir,
  withOwnedGroup,
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
