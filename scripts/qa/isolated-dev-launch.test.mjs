// Pure checks only: nothing here starts the app, so a malformed launch can never reach a real profile.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  buildDevArgs,
  findChangedFiles,
  parseCommandLine,
  platformConfigRoot,
  profileRoots,
  validateDevArgs,
  validateElectronArgv,
  validateRuntimePaths,
  validateUserDataDir,
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
