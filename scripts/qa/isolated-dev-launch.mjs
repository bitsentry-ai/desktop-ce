#!/usr/bin/env node
/**
 * Launches a desktop dev app against a fresh, temporary profile and proves the isolation at runtime before anything
 * may interact with it. Every check fails closed: on any missing or unexpected evidence the launcher stops the
 * instance it started and exits non-zero, so a QA driver never reaches a window that is using a real profile.
 *
 * Usage: node scripts/qa/isolated-dev-launch.mjs [--target ce|pro] [--repo <checkout>] [--port <cdp-port>] [--exec <command>]
 *        [--reuse-profile <dir>] [--allow-force-close]
 *
 * --target ce (the default) launches Desktop CE from a desktop-ce checkout. --target pro launches Desktop Pro and
 * needs --repo pointing at a monorepo checkout, where desktop-ce is the apps/desktop-ce submodule.
 *
 * Every launch uses a new, empty temporary profile and marks it as launcher-created. --reuse-profile <dir> relaunches such a
 * profile (for example after a forced close) and is refused for anything else: the folder must carry this launcher's
 * marker for the same target, sit canonically inside the temporary directory, be owned by the current user, hold no
 * unsafe links and not be in use. --allow-force-close lets the QA command end the app on purpose by creating the file
 * named in QA_FORCE_CLOSE_FILE; the launcher then kills only its own app process group and treats the exit as expected.
 *
 * Without --exec the instance stays up after READY until Ctrl-C. With --exec the command runs only after every check
 * passed, with QA_CDP_URL and QA_USER_DATA_DIR in its environment, and the instance stops when it exits.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEPARATOR = '--';
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const MOCK_KEYCHAIN = '--use-mock-keychain';
const SQLITE_LOG_PATTERN = /Initializing SQLite at (\S+)/;
const STARTUP_TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const ACTIVE_PROFILE_WINDOW_MS = 10_000;
const PROFILE_PREFIX = 'bitsentry-qa-';
const CONTROL_PREFIX = 'bitsentry-qactl-';
const MARKER_NAME = '.bitsentry-qa-profile.json';
const LOCK_NAME = '.bitsentry-qa-launcher.lock';
const MARKER_KIND = 'bitsentry-isolated-qa-profile';
const MAX_MARKER_BYTES = 4096;
const MAX_PROFILE_ENTRIES = 200_000;
// Chromium's own single-instance links, the only symbolic links a profile may hold (top level only).
const CHROMIUM_SINGLETONS = Object.freeze(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);

// Every folder an unisolated CE or Pro build, packaged or dev, may fall back to inside the platform config root.
export const PROFILE_FOLDER_NAMES = Object.freeze([
  '@bitsentry-ce/desktop',
  '@bitsentry/desktop',
  'BitSentry Desktop',
  'BitSentry Desktop Pro',
  'BitSentry',
  'Electron',
]);

// The dev app each target runs from <repo>/apps/desktop, and where that checkout keeps the plugin SDK build.
export const TARGETS = Object.freeze({
  ce: Object.freeze({
    packageName: '@bitsentry-ce/desktop',
    sdkDist: Object.freeze(['packages', 'plugin-sdk', 'dist']),
    sdkBuild: 'pnpm --filter @bitsentry/plugin-sdk build',
  }),
  pro: Object.freeze({
    packageName: '@bitsentry/desktop',
    sdkDist: Object.freeze(['apps', 'desktop-ce', 'packages', 'plugin-sdk', 'dist']),
    sdkBuild: 'pnpm --dir apps/desktop-ce --filter @bitsentry/plugin-sdk build',
  }),
});

/**
 * Resolves the dev app directory for a target. Throws unless <repo>/apps/desktop is exactly that target's package and
 * its plugin SDK build exists, so a wrong --repo or --target can never launch the other product.
 */
export function resolveTarget(target, repo) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`unknown --target ${String(target)}; expected ce or pro`);
  const { packageName, sdkDist, sdkBuild } = TARGETS[target];
  const desktopDir = path.join(repo, 'apps', 'desktop');
  const manifest = path.join(desktopDir, 'package.json');
  let name;
  try {
    name = JSON.parse(readFileSync(manifest, 'utf8'))?.name;
  } catch (error) {
    throw new Error(`cannot read ${manifest} (${String(error?.code ?? error)})`);
  }
  if (name !== packageName) {
    throw new Error(`--target ${target} needs apps/desktop to be ${packageName}, but ${repo} has ${String(name)}`);
  }
  const sdkDistDir = path.join(repo, ...sdkDist);
  if (!existsSync(sdkDistDir)) {
    throw new Error(`${sdkDist.join('/')} is missing; run \`${sdkBuild}\` once in this checkout`);
  }
  return { desktopDir, sdkDistDir };
}

export function platformConfigRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

export function profileRoots(configRoot = platformConfigRoot()) {
  return PROFILE_FOLDER_NAMES.map((name) => path.join(configRoot, name));
}

export function isolationSwitches(userDataDir, port) {
  return [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${String(port)}`, MOCK_KEYCHAIN];
}

/**
 * The pnpm arguments for the desktop dev script. pnpm forwards script arguments verbatim, including `--`, and
 * electron-vite hands everything after its own `--` to Electron. Exactly one separator therefore reaches electron-vite;
 * a second one would reach Electron, and Chromium ignores every switch after it.
 */
export function buildDevArgs(userDataDir, port) {
  return ['run', 'dev', SEPARATOR, ...isolationSwitches(userDataDir, port)];
}

/** Rejects any pnpm argument list that does not carry exactly one separator directly before the isolation switches. */
export function validateDevArgs(args, userDataDir, port) {
  const expected = isolationSwitches(userDataDir, port);
  const separators = args.filter((arg) => arg === SEPARATOR).length;
  if (separators !== 1) return `expected exactly one "--" before the Electron switches, found ${String(separators)}`;
  const tail = args.slice(args.indexOf(SEPARATOR) + 1);
  if (tail.length !== expected.length || tail.some((arg, index) => arg !== expected[index])) {
    return `the arguments after "--" must be exactly: ${expected.join(' ')}`;
  }
  return null;
}

/** The rules every profile directory follows, fresh or reused: splittable from argv, inside the temp folder, clear of real profiles. */
function validateProfilePath(resolved, roots, tempRoot) {
  if (/\s/.test(resolved)) return 'the user-data directory path must not contain whitespace';
  if (!isInside(resolved, tempRoot)) return 'the user-data directory must be inside the system temporary directory';
  for (const root of roots) {
    if (isInside(resolved, root) || isInside(root, resolved)) return `the user-data directory overlaps a profile folder: ${root}`;
  }
  return null;
}

/** Refuses a profile directory that could alias a real profile, already holds data, or cannot be split safely from argv. */
export function validateUserDataDir(userDataDir, roots = profileRoots(), tempRoot = realpathSync(os.tmpdir())) {
  const resolved = path.resolve(userDataDir);
  const refusal = validateProfilePath(resolved, roots, tempRoot);
  if (refusal !== null) return refusal;
  if (existsSync(resolved) && readdirSync(resolved).length > 0) return 'the user-data directory must be new and empty';
  return null;
}

const currentUid = () => process.getuid?.() ?? -1;

/** Binds a new profile to this launcher: a random nonce, the target, the owner, and where the folder really is. */
export function writeProfileMarker(userDataDir, target, uid = currentUid()) {
  const dir = canonical(userDataDir);
  const stats = statSync(dir, { bigint: true });
  const marker = {
    schema: 1,
    kind: MARKER_KIND,
    target,
    nonce: randomBytes(16).toString('hex'),
    uid,
    dir,
    dev: String(stats.dev),
    ino: String(stats.ino),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, MARKER_NAME), `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
  return marker;
}

/**
 * Reads and checks a profile's launcher marker. The folder name alone proves nothing: the marker must be a regular file
 * this user owns, well formed, for the same target, and written for this very folder (same path, device and inode), so
 * a marker copied from another folder never validates.
 */
export function inspectProfileMarker(resolved, { target, uid = currentUid() } = {}) {
  const markerPath = path.join(resolved, MARKER_NAME);
  let stats;
  try {
    stats = lstatSync(markerPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { refusal: 'the folder has no launcher marker, so it was not created by this launcher' };
    return { refusal: `cannot inspect the launcher marker (${String(error?.code ?? error)})` };
  }
  if (!stats.isFile()) return { refusal: 'the launcher marker is not a regular file' };
  if (stats.size > BigInt(MAX_MARKER_BYTES)) return { refusal: 'the launcher marker is too large' };
  if (Number(stats.uid) !== uid) return { refusal: 'the launcher marker is not owned by the current user' };
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    return { refusal: 'the launcher marker is not valid JSON' };
  }
  if (marker === null || typeof marker !== 'object' || marker.schema !== 1 || marker.kind !== MARKER_KIND) {
    return { refusal: 'the launcher marker has an unknown format' };
  }
  if (typeof marker.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(marker.nonce)) return { refusal: 'the launcher marker has no valid nonce' };
  if (marker.target !== target) return { refusal: `the profile was created for target ${String(marker.target)}, not ${String(target)}` };
  if (marker.uid !== uid) return { refusal: 'the launcher marker was written for another user' };
  const dirStats = statSync(resolved, { bigint: true });
  if (marker.dir !== resolved || marker.dev !== String(dirStats.dev) || marker.ino !== String(dirStats.ino)) {
    return { refusal: 'the launcher marker was written for a different folder (moved, copied or replaced)' };
  }
  return { marker };
}

/** Whether a process id is alive. Only "no such process" means gone. */
export function pidAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

/** Every process command line on this machine, as `pid command` lines. Fails closed: a failing ps is an error. */
export function listProcessCommands() {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n');
}

/** Why the profile may be in use right now, or null. Reads process lines and Chromium's single-instance link only. */
export function profileInUse(resolved, { commands, isAlive = pidAlive }) {
  const switchText = `--user-data-dir=${resolved}`;
  for (const line of commands) {
    if (parseCommandLine(line).includes(switchText)) return `a running process already uses this profile (${line.trim().split(/\s+/)[0]})`;
  }
  const lockPath = path.join(resolved, 'SingletonLock');
  let target;
  try {
    target = readlinkSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EINVAL') return null;
    return `cannot inspect Chromium's single-instance lock (${String(error?.code ?? error)})`;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return "Chromium's single-instance lock is unreadable";
  return isAlive(pid) ? `Chromium's single-instance lock is held by live process ${String(pid)}` : null;
}

/**
 * Symbolic links inside a profile could redirect the app's writes into a real profile. Only Chromium's own
 * single-instance links at the top level are allowed. Throws if the tree cannot be inspected completely.
 */
export function findUnsafeLinks(directory, limit = MAX_PROFILE_ENTRIES) {
  const unsafe = [];
  let seen = 0;
  const visit = (current, top) => {
    for (const entry of inspectPath(current, () => readdirSync(current, { withFileTypes: true })) ?? []) {
      seen += 1;
      if (seen > limit) throw new Error(`the profile holds more than ${String(limit)} entries and cannot be inspected completely`);
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (!(top && CHROMIUM_SINGLETONS.includes(entry.name))) unsafe.push(path.relative(directory, entryPath));
      } else if (entry.isDirectory()) {
        visit(entryPath, false);
      }
    }
  };
  visit(directory, true);
  return unsafe;
}

/**
 * Refuses to relaunch anything but a profile this launcher created: canonical and inside the temporary folder, clear of
 * real profiles, owned by the current user and not writable by others, carrying a valid marker for the same target,
 * free of unsafe links, and not in use. Returns the reason, or null. The default fresh-empty-profile launch is separate.
 */
export function validateReusableProfile(userDataDir, {
  target,
  roots = profileRoots(),
  tempRoot = realpathSync(os.tmpdir()),
  uid = currentUid(),
  commands = listProcessCommands(),
  isAlive = pidAlive,
} = {}) {
  const resolved = path.resolve(userDataDir);
  const refusal = validateProfilePath(resolved, roots, tempRoot);
  if (refusal !== null) return refusal;
  if (!path.basename(resolved).startsWith(PROFILE_PREFIX)) return `the folder name does not start with ${PROFILE_PREFIX}`;
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    return error?.code === 'ENOENT' ? 'the profile folder does not exist' : `cannot inspect the profile folder (${String(error?.code ?? error)})`;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return 'the profile path must be a real directory, not a link or file';
  if (canonical(resolved) !== resolved) return 'a component of the profile path is a symbolic link; use the canonical path the launcher printed';
  if (stats.uid !== uid) return 'the profile folder is not owned by the current user';
  if ((stats.mode & 0o022) !== 0) return 'the profile folder is writable by group or others';
  const inspected = inspectProfileMarker(resolved, { target, uid });
  if (inspected.refusal !== undefined) return inspected.refusal;
  const links = findUnsafeLinks(resolved);
  if (links.length > 0) return `the profile holds symbolic links: ${links.slice(0, 3).join(', ')}`;
  return profileInUse(resolved, { commands, isAlive });
}

/** Takes the profile for this launcher process. A lock left by a dead launcher is replaced; a live one refuses. */
export function acquireProfileLock(userDataDir, { pid = process.pid, isAlive = pidAlive } = {}) {
  const lockPath = path.join(userDataDir, LOCK_NAME);
  const claim = () => { writeFileSync(lockPath, `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 }); };
  try {
    claim();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let holder;
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'))?.pid;
    } catch {
      throw new Error('the profile lock is unreadable; refusing to take over the profile');
    }
    if (!Number.isInteger(holder) || holder <= 0) throw new Error('the profile lock names no process; refusing to take over the profile');
    if (isAlive(holder)) throw new Error(`the profile is held by launcher process ${String(holder)}`);
    unlinkSync(lockPath);
    claim();
  }
  return () => {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}

/**
 * Checks the live Electron command line: every isolation switch is present exactly once with the expected value, and
 * no bare separator precedes any of them (Chromium stops reading switches at the first one).
 */
export function validateElectronArgv(argv, userDataDir, port) {
  const firstSeparator = argv.indexOf(SEPARATOR);
  for (const expected of isolationSwitches(userDataDir, port)) {
    const name = expected.split('=')[0];
    const matches = argv.filter((arg) => arg === name || arg.startsWith(`${name}=`));
    if (matches.length === 0) return `Electron was started without ${name}`;
    if (matches.length > 1 || matches[0] !== expected) return `Electron got ${matches.join(' ')}, expected ${expected}`;
    if (firstSeparator !== -1 && firstSeparator < argv.indexOf(expected)) {
      return `a "--" precedes ${name}, so Chromium ignores the isolation switches`;
    }
  }
  return null;
}

/** The app's own reported profile and database must both live in the temporary directory this launcher created. */
export function validateRuntimePaths({ reportedUserData, sqlitePath }, userDataDir) {
  const expected = canonical(userDataDir);
  if (reportedUserData === undefined) return 'the app did not report its user-data directory';
  if (canonical(reportedUserData) !== expected) return `the app reports user-data ${reportedUserData}, expected ${userDataDir}`;
  if (sqlitePath === undefined) return 'the app did not report its SQLite path';
  if (!isInside(canonical(sqlitePath), expected)) return `the app opened SQLite at ${sqlitePath}, outside ${userDataDir}`;
  return null;
}

/** Runs a read of `target`: a missing entry gives undefined, any other error throws, so inspection fails closed. */
function inspectPath(target, read) {
  try {
    return read();
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`cannot inspect ${target} (${String(error?.code ?? error)})`);
  }
}

/**
 * Lists files under the given roots modified at or after `sinceMs`. Reads metadata only, never file contents.
 * Only a missing root or an entry removed mid-walk is skipped; any other error (permission, I/O) throws, so an
 * unreadable profile can never pass as unchanged.
 */
export function findChangedFiles(roots, sinceMs, limit = 20) {
  const changed = [];
  const inspect = inspectPath;
  const visit = (directory) => {
    const entries = inspect(directory, () => readdirSync(directory, { withFileTypes: true })) ?? [];
    for (const entry of entries) {
      if (changed.length >= limit) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else {
        const stats = inspect(entryPath, () => statSync(entryPath));
        if (stats !== undefined && stats.mtimeMs >= sinceMs) changed.push(entryPath);
      }
    }
  };
  for (const root of roots) visit(root);
  return changed;
}

/** Whether any process is still in the group. Only "no such process" means gone; anything else counts as alive. */
export function processGroupAlive(pgid, kill = process.kill) {
  try {
    kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

/**
 * Stops every process in the launcher's own process group, including descendants whose leader already exited:
 * SIGTERM, a bounded wait, then SIGKILL and a bounded wait. Throws if the group survives, so callers never report a
 * clean stop that did not happen. Only the negative group id of a group this launcher created is ever signalled.
 */
export async function stopProcessGroup(pgid, { termGraceMs = 10_000, killGraceMs = 5_000, kill = process.kill } = {}) {
  const waitGone = async (ms) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      if (!processGroupAlive(pgid, kill)) return true;
      await sleep(100);
    }
    return !processGroupAlive(pgid, kill);
  };
  const signal = (name) => {
    try {
      kill(-pgid, name);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  if (!processGroupAlive(pgid, kill)) return 'gone';
  signal('SIGTERM');
  if (await waitGone(termGraceMs)) return 'terminated';
  signal('SIGKILL');
  if (await waitGone(killGraceMs)) return 'killed';
  throw new Error(`process group ${String(pgid)} is still running after SIGKILL`);
}

/**
 * Ends the launcher's own process group at once with SIGKILL and no SIGTERM first, like a crash or a force quit, and
 * confirms the group is gone. Throws if it survives. Only the negative group id of a group this launcher created is signalled.
 */
export async function forceKillProcessGroup(pgid, { killGraceMs = 5_000, kill = process.kill } = {}) {
  if (!processGroupAlive(pgid, kill)) return 'gone';
  try {
    kill(-pgid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  for (const deadline = Date.now() + killGraceMs; Date.now() < deadline;) {
    if (!processGroupAlive(pgid, kill)) return 'killed';
    await sleep(100);
  }
  if (!processGroupAlive(pgid, kill)) return 'killed';
  throw new Error(`process group ${String(pgid)} is still running after SIGKILL`);
}

/** Runs `body` while the child's process group is owned, and always stops that whole group afterwards. */
export async function withOwnedGroup(child, body, stopOptions) {
  try {
    return await body();
  } finally {
    await stopProcessGroup(child.pid, stopOptions);
  }
}

const waitUntil = (condition) => new Promise((resolve) => {
  if (condition()) {
    resolve();
    return;
  }
  const watch = setInterval(() => {
    if (!condition()) return;
    clearInterval(watch);
    resolve();
  }, 100);
});

/**
 * Supervises one verified launch from start to stop. The app (`child`, a detached group) and the QA command (its own
 * detached group) are both owned: whichever happens first, the QA command finishing, SIGINT/SIGTERM to the launcher,
 * or the app exiting, both groups are stopped, the QA command's first. An interruption or an app exit while the QA
 * command runs is a failure even if the command later reports success. Never signals any other process group.
 *
 * With `forceClose` ({ requested(), perform() }) the QA command may end the app on purpose once, after the launch was
 * verified: `perform` kills the app group, and that one exit is expected rather than a failure.
 */
export async function runOwnedSession({ child, verifyLaunch, exec, execEnv, stopOptions, forceClose, onReady = () => {}, onDriverStart = () => {} }) {
  const state = { interrupted: false, appExited: child.exitCode !== null || child.signalCode !== null };
  child.once('exit', () => { state.appExited = true; });
  const onSignal = () => { state.interrupted = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const failures = [];
  let exitCode = 0;
  let forcedClose = false;
  try {
    await withOwnedGroup(child, async () => {
      const verdict = await verifyLaunch(state);
      if (verdict !== null) {
        failures.push(verdict);
        return;
      }
      onReady();
      if (exec === undefined) {
        await waitUntil(() => state.interrupted || state.appExited);
        return;
      }
      const driver = spawn(exec, { shell: true, detached: true, stdio: 'inherit', env: execEnv });
      let driverExit;
      driver.once('exit', (code, signal) => { driverExit = { code, signal }; });
      onDriverStart(driver.pid);
      try {
        const wantsForceClose = () => forceClose !== undefined && !forcedClose && forceClose.requested();
        for (;;) {
          await waitUntil(() => driverExit !== undefined || state.interrupted || (state.appExited && !forcedClose) || wantsForceClose());
          if (!wantsForceClose() || driverExit !== undefined || state.interrupted || state.appExited) break;
          forcedClose = true;
          await forceClose.perform();
        }
        if (state.interrupted) failures.push('interrupted while the QA command was running');
        else if (driverExit === undefined) failures.push('the app exited while the QA command was running');
        else if (driverExit.code !== 0) exitCode = driverExit.code ?? 1;
      } finally {
        await stopProcessGroup(driver.pid, stopOptions);
      }
    }, stopOptions);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return forcedClose ? { failures, exitCode, forcedClose } : { failures, exitCode };
}

/** Parses a NUL-separated /proc cmdline or a whitespace-separated `ps` command line into arguments. */
export function parseCommandLine(raw) {
  const separator = raw.includes('\0') ? '\0' : /\s+/;
  return raw.split(separator).filter((part) => part.length > 0);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function parseOptions(rawArgv) {
  // Tolerate the one separator `pnpm run <script> -- <options>` forwards; the options themselves never contain one.
  const argv = rawArgv[0] === SEPARATOR ? rawArgv.slice(1) : rawArgv;
  const options = {
    target: 'ce',
    repo: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
    port: 9339,
    exec: undefined,
    reuseProfile: undefined,
    allowForceClose: false,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--allow-force-close') {
      options.allowForceClose = true;
      index -= 1;
      continue;
    }
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--target') options.target = value;
    else if (flag === '--repo') options.repo = path.resolve(value);
    else if (flag === '--port') options.port = Number(value);
    else if (flag === '--exec') options.exec = value;
    else if (flag === '--reuse-profile') options.reuseProfile = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Object.hasOwn(TARGETS, options.target)) throw new Error(`unknown --target ${options.target}; expected ce or pro`);
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('invalid --port');
  if (options.reuseProfile !== undefined && !path.isAbsolute(options.reuseProfile)) throw new Error('--reuse-profile needs the absolute profile path the launcher printed');
  return options;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => { resolve(false); });
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolve(true); }); });
  });
}

function listenerPid(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = Number(out.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function parentPid(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return undefined;
  }
}

function isDescendant(pid, ancestor) {
  let current = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < 32; depth += 1) {
    if (current === ancestor) return true;
    current = parentPid(current);
  }
  return false;
}

function commandLine(pid) {
  const procPath = `/proc/${String(pid)}/cmdline`;
  if (existsSync(procPath)) return parseCommandLine(readFileSync(procPath, 'utf8'));
  return parseCommandLine(execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
}

/** The user-data folder the app reported. A report older than this launch (a reused profile keeps the last one) does not count. */
export function readReportedUserData(userDataDir, sinceMs) {
  try {
    const reportPath = path.join(userDataDir, 'diagnostics', 'startup-diagnostics.json');
    if (statSync(reportPath).mtimeMs < sinceMs) return undefined;
    const artifact = JSON.parse(readFileSync(reportPath, 'utf8'));
    return typeof artifact?.paths?.userData === 'string' ? artifact.paths.userData : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform === 'win32') throw new Error('the runtime checks need lsof and ps; use macOS or Linux');
  const { desktopDir } = resolveTarget(options.target, options.repo);
  console.log(`[isolated-launch] target ${options.target} (${TARGETS[options.target].packageName}) at ${desktopDir}`);
  if (!(await portIsFree(options.port))) throw new Error(`port ${String(options.port)} is already in use`);

  const roots = profileRoots();
  // Another BitSentry or Electron app writing to a standard profile would make the after-launch check ambiguous.
  const busy = findChangedFiles(roots, Date.now() - ACTIVE_PROFILE_WINDOW_MS, 3);
  if (busy.length > 0) {
    throw new Error(`a standard profile folder is in use by another app (recent writes: ${busy.join(', ')}); close it first`);
  }
  const reused = options.reuseProfile !== undefined;
  let userDataDir;
  let releaseProfile = () => {};
  let controlDir;
  try {
    if (reused) {
      // Not resolved through links on purpose: the validation refuses a path that goes through one.
      userDataDir = path.resolve(options.reuseProfile);
      const refusal = validateReusableProfile(userDataDir, { target: options.target, roots });
      if (refusal !== null) throw new Error(refusal);
      releaseProfile = acquireProfileLock(userDataDir);
    } else {
      userDataDir = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), PROFILE_PREFIX)));
    }
    const args = buildDevArgs(userDataDir, options.port);
    const preflight = (reused ? null : validateUserDataDir(userDataDir, roots)) ?? validateDevArgs(args, userDataDir, options.port);
    if (preflight !== null) throw new Error(preflight);
    const marker = reused ? inspectProfileMarker(userDataDir, { target: options.target }).marker : writeProfileMarker(userDataDir, options.target);

    let forceCloseFile;
    if (options.allowForceClose) {
      controlDir = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), CONTROL_PREFIX)));
      forceCloseFile = path.join(controlDir, 'force-close');
    }
    const launchedAtMs = Date.now() - 1000;
    const verifyProfilesUntouched = () => {
      const changed = findChangedFiles(roots, launchedAtMs);
      return changed.length === 0 ? null : `profile folders changed since launch: ${changed.join(', ')}`;
    };
    console.log(`[isolated-launch] profile ${userDataDir} (${reused ? 'reused' : 'new'}, marker ${marker.nonce.slice(0, 8)})`);
    console.log('[isolated-launch] note: the dev build appends to its own electron-log file in the platform log folder');
    const env = { ...process.env, BITSENTRY_USER_DATA_DIR: userDataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn('pnpm', args, { cwd: desktopDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let sqlitePath;
    let pending = '';
    const onOutput = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      const lines = (pending + text).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) sqlitePath ??= SQLITE_LOG_PATTERN.exec(line)?.[1];
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    const verifyLaunch = async (state) => {
      for (const deadline = Date.now() + STARTUP_TIMEOUT_MS; Date.now() < deadline;) {
        if (state.interrupted) return 'interrupted before the app was verified';
        if (state.appExited) return 'the app exited before it could be verified';
        const untouched = verifyProfilesUntouched();
        if (untouched !== null) return untouched;
        const pid = listenerPid(options.port);
        const reportedUserData = readReportedUserData(userDataDir, launchedAtMs);
        if (pid !== undefined && reportedUserData !== undefined && sqlitePath !== undefined) {
          if (!isDescendant(pid, child.pid)) return `port ${String(options.port)} is served by a process this launcher did not start`;
          return validateElectronArgv(commandLine(pid), userDataDir, options.port)
            ?? validateRuntimePaths({ reportedUserData, sqlitePath }, userDataDir)
            ?? verifyProfilesUntouched();
        }
        await sleep(POLL_MS);
      }
      return 'timed out waiting for the app to report its profile, database and CDP port';
    };

    const cdpUrl = `http://127.0.0.1:${String(options.port)}`;
    const execEnv = { ...process.env, QA_CDP_URL: cdpUrl, QA_USER_DATA_DIR: userDataDir, QA_PROFILE_MODE: reused ? 'reused' : 'new' };
    if (forceCloseFile !== undefined) execEnv.QA_FORCE_CLOSE_FILE = forceCloseFile;
    const { failures, exitCode, forcedClose } = await runOwnedSession({
      child,
      verifyLaunch,
      exec: options.exec,
      execEnv,
      forceClose: forceCloseFile === undefined ? undefined : {
        requested: () => existsSync(forceCloseFile),
        perform: async () => {
          console.log(`[isolated-launch] FORCE-CLOSE requested by the QA command; killing only the app process group ${String(child.pid)} with SIGKILL`);
          console.log(`[isolated-launch] FORCE-CLOSE ${await forceKillProcessGroup(child.pid)}; this exit is expected`);
        },
      },
      onReady: () => { console.log(`[isolated-launch] READY ${cdpUrl} (argv, user-data, SQLite and profile folders verified)`); },
    });
    // The app and the QA command are both fully stopped here, so this is the final word on the profile folders.
    try {
      const after = verifyProfilesUntouched();
      if (after !== null) failures.push(after);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
    console.log(`[isolated-launch] DONE profile ${userDataDir} kept for relaunch with --reuse-profile${forcedClose ? ' (the app was force-closed on purpose)' : ''}`);
    process.exitCode = exitCode;
  } finally {
    releaseProfile();
    // Only the control folder this launcher just created, never anything the QA command made elsewhere.
    if (controlDir !== undefined) rmSync(controlDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[isolated-launch] REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
