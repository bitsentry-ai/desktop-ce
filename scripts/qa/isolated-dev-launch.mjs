#!/usr/bin/env node
/**
 * Launches the Desktop CE dev app (the `desktop:dev` chain) against a fresh, temporary profile and proves the
 * isolation at runtime before anything may interact with it. Every check fails closed: on any missing or unexpected
 * evidence the launcher stops the instance it started and exits non-zero, so a QA driver never reaches a window that
 * is using a real profile.
 *
 * Usage: node scripts/qa/isolated-dev-launch.mjs [--repo <checkout>] [--port <cdp-port>] [--exec <command>]
 *
 * Without --exec the instance stays up after READY until Ctrl-C. With --exec the command runs only after every check
 * passed, with QA_CDP_URL and QA_USER_DATA_DIR in its environment, and the instance stops when it exits.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEPARATOR = '--';
const MOCK_KEYCHAIN = '--use-mock-keychain';
const SQLITE_LOG_PATTERN = /Initializing SQLite at (\S+)/;
const STARTUP_TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const ACTIVE_PROFILE_WINDOW_MS = 10_000;

// Every folder an unisolated CE or Pro build, packaged or dev, may fall back to inside the platform config root.
export const PROFILE_FOLDER_NAMES = Object.freeze([
  '@bitsentry-ce/desktop',
  '@bitsentry/desktop',
  'BitSentry Desktop',
  'BitSentry Desktop Pro',
  'BitSentry',
  'Electron',
]);

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

/** Refuses a profile directory that could alias a real profile, already holds data, or cannot be split safely from argv. */
export function validateUserDataDir(userDataDir, roots = profileRoots(), tempRoot = realpathSync(os.tmpdir())) {
  const resolved = path.resolve(userDataDir);
  if (/\s/.test(resolved)) return 'the user-data directory path must not contain whitespace';
  if (!isInside(resolved, tempRoot)) return 'the user-data directory must be inside the system temporary directory';
  for (const root of roots) {
    if (isInside(resolved, root) || isInside(root, resolved)) return `the user-data directory overlaps a profile folder: ${root}`;
  }
  if (existsSync(resolved) && readdirSync(resolved).length > 0) return 'the user-data directory must be new and empty';
  return null;
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

/** Lists files under the given roots modified at or after `sinceMs`. Reads metadata only, never file contents. */
export function findChangedFiles(roots, sinceMs, limit = 20) {
  const changed = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (changed.length >= limit) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else {
        try {
          if (statSync(entryPath).mtimeMs >= sinceMs) changed.push(entryPath);
        } catch {
          // A file that vanished mid-walk is not a write into the profile.
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return changed;
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

function parseOptions(rawArgv) {
  // Tolerate the one separator `pnpm run <script> -- <options>` forwards; the options themselves never contain one.
  const argv = rawArgv[0] === SEPARATOR ? rawArgv.slice(1) : rawArgv;
  const options = { repo: path.resolve(fileURLToPath(new URL('../..', import.meta.url))), port: 9339, exec: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--repo') options.repo = path.resolve(value);
    else if (flag === '--port') options.port = Number(value);
    else if (flag === '--exec') options.exec = value;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('invalid --port');
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

function readReportedUserData(userDataDir) {
  try {
    const artifact = JSON.parse(readFileSync(path.join(userDataDir, 'diagnostics', 'startup-diagnostics.json'), 'utf8'));
    return typeof artifact?.paths?.userData === 'string' ? artifact.paths.userData : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const desktopDir = path.join(options.repo, 'apps', 'desktop');
  const fail = (message) => {
    console.error(`[isolated-launch] REFUSED: ${message}`);
    process.exitCode = 1;
  };

  if (!existsSync(path.join(options.repo, 'packages', 'plugin-sdk', 'dist'))) {
    fail('packages/plugin-sdk/dist is missing; run `pnpm --filter @bitsentry/plugin-sdk build` once in this checkout');
    return;
  }
  if (!(await portIsFree(options.port))) {
    fail(`port ${String(options.port)} is already in use`);
    return;
  }

  const roots = profileRoots();
  // Another BitSentry or Electron app writing to a standard profile would make the after-launch check ambiguous.
  const busy = findChangedFiles(roots, Date.now() - ACTIVE_PROFILE_WINDOW_MS, 3);
  if (busy.length > 0) {
    fail(`a standard profile folder is in use by another app (recent writes: ${busy.join(', ')}); close it first`);
    return;
  }
  const userDataDir = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'bitsentry-qa-')));
  const args = buildDevArgs(userDataDir, options.port);
  const preflight = validateUserDataDir(userDataDir, roots) ?? validateDevArgs(args, userDataDir, options.port);
  if (preflight !== null) {
    fail(preflight);
    return;
  }

  const launchedAtMs = Date.now() - 1000;
  console.log(`[isolated-launch] profile ${userDataDir}`);
  console.log('[isolated-launch] note: the dev build appends to its own electron-log file in the platform log folder');
  const env = { ...process.env, BITSENTRY_USER_DATA_DIR: userDataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn('pnpm', args, {
    cwd: desktopDir,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
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
  let exited = false;
  child.once('exit', () => { exited = true; });
  const stop = () => {
    if (exited) return;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const verifyProfilesUntouched = () => {
    const changed = findChangedFiles(roots, launchedAtMs);
    return changed.length === 0 ? null : `profile folders changed since launch: ${changed.join(', ')}`;
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let verdict = 'timed out waiting for the app to report its profile, database and CDP port';
  while (Date.now() < deadline && !exited) {
    const untouched = verifyProfilesUntouched();
    if (untouched !== null) {
      verdict = untouched;
      break;
    }
    const pid = listenerPid(options.port);
    const reportedUserData = readReportedUserData(userDataDir);
    if (pid !== undefined && reportedUserData !== undefined && sqlitePath !== undefined) {
      verdict = isDescendant(pid, child.pid)
        ? validateElectronArgv(commandLine(pid), userDataDir, options.port)
          ?? validateRuntimePaths({ reportedUserData, sqlitePath }, userDataDir)
          ?? verifyProfilesUntouched()
        : `port ${String(options.port)} is served by a process this launcher did not start`;
      break;
    }
    await sleep(POLL_MS);
  }
  if (exited && verdict.startsWith('timed out')) verdict = 'the app exited before it could be verified';
  if (verdict !== null) {
    stop();
    fail(verdict);
    return;
  }

  const cdpUrl = `http://127.0.0.1:${String(options.port)}`;
  console.log(`[isolated-launch] READY ${cdpUrl} (argv, user-data, SQLite and profile folders verified)`);
  if (options.exec !== undefined) {
    const qa = spawn(options.exec, { shell: true, stdio: 'inherit', env: { ...process.env, QA_CDP_URL: cdpUrl, QA_USER_DATA_DIR: userDataDir } });
    const code = await new Promise((resolve) => { qa.once('exit', resolve); });
    const after = verifyProfilesUntouched();
    stop();
    if (after !== null) fail(after);
    else if (code !== 0) process.exitCode = code ?? 1;
    return;
  }
  await new Promise((resolve) => { child.once('exit', resolve); });
  const after = verifyProfilesUntouched();
  if (after !== null) fail(after);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
