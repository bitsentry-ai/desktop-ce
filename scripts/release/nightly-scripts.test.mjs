// Offline checks for the CE nightly scripts: git, date, node, pnpm, npx, codesign, hdiutil, unzip and gh are
// stubs, so nothing here builds, signs, uploads or publishes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '0.1.0-nightly.20261118';
const record = (name) => `printf '%s' "${name}" >> "$CALL_LOG"; for a in "$@"; do printf ' %s' "$a" >> "$CALL_LOG"; done; printf '\\n' >> "$CALL_LOG"`;
const STUBS = {
  git: 'case "$1" in tag) printf \'%s\' "${GIT_TAGS-}";; merge-base) exit "${GIT_ANCESTOR:-0}";; rev-list) echo "${GIT_COUNT:-0}";; esac',
  date: 'echo 20261118',
  node: 'case "$1" in *verify-update-manifest.js) exit "${VERIFY_EXIT:-0}";; esac',
  pnpm: '',
  npx: 'printf \'after_sign=%s\\n\' "$DESKTOP_ENABLE_AFTER_SIGN" >> "$CALL_LOG"',
  codesign: 'printf \'%b\' "${CODESIGN_OUT-}" >&2',
  hdiutil: '',
  unzip: '',
  shasum: 'echo sums',
  gh: '',
};

function run(script, env, { cwd = '', files = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ce-nightly-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${record(name)}\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  mkdirSync(path.join(root, 'apps/desktop/scripts'), { recursive: true });
  mkdirSync(path.join(root, 'apps/desktop/release/build'), { recursive: true });
  for (const helper of ['create-ci-builder-config.sh', 'normalize-ce-builder-config.sh', 'verify-macos-artifact.sh']) {
    writeFileSync(path.join(root, 'apps/desktop/scripts', helper), `${record(helper)}\n`);
  }
  for (const file of files) writeFileSync(path.join(root, 'apps/desktop', file), 'x');
  cpSync(path.join(repoRoot, 'scripts/release'), path.join(root, 'scripts/release'), { recursive: true });
  const callLog = path.join(root, 'calls.log');
  writeFileSync(callLog, '');
  const output = path.join(root, 'github-output');
  const result = spawnSync('bash', [path.join(root, cwd, script)], {
    cwd: path.join(root, cwd),
    env: { PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: callLog, GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: read(callLog).trimEnd().split('\n').filter(Boolean),
    outputs: Object.fromEntries(read(output).trimEnd().split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2))),
    sums: read(path.join(root, 'apps/desktop/release/build/SHA256SUMS')),
  };
}

const gate = (env) =>
  run('scripts/release/resolve-nightly-gate.sh', { GITHUB_REF_NAME: 'main', GITHUB_RUN_NUMBER: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'abc123', ...env });

test('the change gate names the nightly and skips only when nothing changed since the last nightly tag', () => {
  assert.deepEqual(gate({ GIT_TAGS: '' }).outputs, {
    should_run: 'true',
    nightly_date: '20261118',
    nightly_version: VERSION,
    nightly_tag: 'desktop-nightly-20261118.7.1',
    r2_prefix: 'desktop-ce/nightly/20261118/desktop-nightly-20261118.7.1',
    artifact_version_segment: 'abc123',
  });
  const unchanged = gate({ GIT_TAGS: 'desktop-nightly-20261117.6.1', GIT_COUNT: '0' });
  assert.equal(unchanged.outputs.should_run, 'false');
  assert.match(unchanged.stdout, /No commits changed since desktop-nightly-20261117\.6\.1/);
  assert.equal(gate({ GIT_TAGS: 'desktop-nightly-20261117.6.1', GIT_COUNT: '3' }).outputs.should_run, 'true');
  assert.equal(gate({ GIT_TAGS: 'desktop-nightly-20261117.6.1', GIT_ANCESTOR: '1' }).outputs.should_run, 'true');
});

test('the change gate refuses nightlies from any branch but main', () => {
  const result = gate({ GITHUB_REF_NAME: 'feat/x' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /may only be published from main; received feat\/x/);
  assert.deepEqual(result.outputs, {});
});

const SECRETS = {
  R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd',
  MAC_CSC_LINK: 'link', MAC_CSC_KEY_PASSWORD: 'kpw', MAC_CSC_PASSWORD: '',
  APPLE_ID: 'id', APPLE_APP_PASSWORD: 'pw', APPLE_TEAM_ID: 'team',
};
const preflight = (overrides) => run('scripts/release/check-nightly-release-secrets.sh', { ...SECRETS, ...overrides });

test('the secret preflight requires R2 and signing secrets and all-or-none Apple secrets', () => {
  assert.match(preflight({}).stdout, /Apple notarization is enabled/);
  assert.match(preflight({ APPLE_ID: '', APPLE_APP_PASSWORD: '', APPLE_TEAM_ID: '' }).stdout, /notarization is disabled explicitly/);
  assert.equal(preflight({ MAC_CSC_KEY_PASSWORD: '', MAC_CSC_PASSWORD: 'pw' }).status, 0);
  for (const [overrides, message] of [
    [{ R2_BUCKET: '' }, /Missing required R2 secret: R2_BUCKET/],
    [{ MAC_CSC_LINK: '' }, /refusing to create an unsigned nightly/],
    [{ MAC_CSC_KEY_PASSWORD: '' }, /refusing to create an unsigned nightly/],
    [{ APPLE_TEAM_ID: '' }, /notarization configuration is partial/],
  ]) {
    const result = preflight(overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  assert.doesNotMatch(preflight({ R2_BUCKET: '' }).stderr, /kpw|link/);
});

const pack = (overrides) =>
  run('../../scripts/release/package-nightly-macos.sh', {
    NIGHTLY_VERSION: VERSION, R2_PUBLIC_BASE_URL: 'https://downloads.example', R2_PREFIX: 'desktop-ce/nightly/x',
    APPLE_ID: 'id', APPLE_APP_PASSWORD: 'pw', APPLE_TEAM_ID: 'team', ...overrides,
  }, { cwd: 'apps/desktop' });

test('packaging enables the notarization hook only with all three Apple secrets', () => {
  const full = pack({});
  assert.equal(full.status, 0);
  assert.equal(full.calls.at(-1), 'after_sign=true');
  assert.equal(full.calls.at(-2), 'npx electron-builder build --config electron-builder.ci.yml --mac --arm64 --publish never');
  assert.equal(pack({ APPLE_TEAM_ID: '' }).calls.at(-1), 'after_sign=false');
});

const ARTIFACTS = ['dmg', 'zip', 'dmg.blockmap', 'zip.blockmap'].map((ext) => `release/build/bitsentry-desktop-ce-${VERSION}-macos-aarch64.${ext}`);
const DEVELOPER_ID = 'TeamIdentifier=ABCDE12345\\nAuthority=Developer ID Application: Example (ABCDE12345)\\n';
const verify = (codesign, files = ARTIFACTS) =>
  run('../../scripts/release/verify-nightly-macos-artifact.sh', { NIGHTLY_VERSION: VERSION, CODESIGN_OUT: codesign }, { cwd: 'apps/desktop', files });

test('artifact verification refuses anything but a Developer ID signature before writing checksums', () => {
  const signed = verify(DEVELOPER_ID);
  assert.equal(signed.status, 0);
  assert.equal(signed.sums, 'sums\n');
  for (const [codesign, message] of [
    ['TeamIdentifier=not set\\nAuthority=Developer ID Application: X\\n', /ad-hoc or unsigned nightly/],
    ['Signature=adhoc\\n', /ad-hoc or unsigned nightly/],
    ['TeamIdentifier=ABCDE12345\\nAuthority=Apple Development: X\\n', /non-Developer-ID macOS artifact/],
  ]) {
    const result = verify(codesign);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.sums, '');
  }
  assert.equal(verify(DEVELOPER_ID, ARTIFACTS.slice(0, 3)).status, 1);
});

const upload = (env) =>
  run('../../scripts/release/upload-nightly-artifacts.sh', {
    NIGHTLY_VERSION: VERSION, R2_PREFIX: 'desktop-ce/nightly/x', ARTIFACT_VERSION_SEGMENT: 'abc123', ...env,
  }, { cwd: 'apps/desktop' });

test('R2 upload sends artifacts and the feed under the isolated nightly prefix, after manifest verification', () => {
  const result = upload({});
  assert.equal(result.calls.length, 3);
  assert.match(result.calls[1], /^node scripts\/dist\/upload-r2-artifacts\.js --root release\/build --prefix desktop-ce\/nightly\/x\/macos\/arm64\/abc123 .* --include SHA256SUMS --if-no-files-found error$/);
  assert.equal(result.calls[2], 'node scripts/dist/upload-r2-artifacts.js --root release/build/channel-feed --prefix desktop-ce/nightly/x/macos/arm64 --include latest-mac.yml --if-no-files-found error');
  const blocked = upload({ VERIFY_EXIT: '4' });
  assert.equal(blocked.status, 4);
  assert.equal(blocked.calls.length, 1);
});

test('the nightly is published as a prerelease that is never marked latest', () => {
  const result = run('../../scripts/release/publish-nightly-prerelease.sh', {
    NIGHTLY_TAG: 'desktop-nightly-20261118.7.1', NIGHTLY_VERSION: VERSION, GITHUB_REPOSITORY: 'bitsentry-ai/desktop-ce',
    GITHUB_SHA: 'abc123', R2_PUBLIC_BASE_URL: 'https://downloads.example', R2_PREFIX: 'desktop-ce/nightly/x',
  }, { cwd: 'apps/desktop' });
  assert.equal(result.status, 0);
  assert.match(result.calls[0], /^gh release create desktop-nightly-20261118\.7\.1 .* --target abc123 .* --prerelease --latest=false$/);
});

test('the nightly workflow calls every extracted script', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/desktop-nightly.yml'), 'utf8');
  for (const script of [
    'resolve-nightly-gate.sh', 'check-nightly-release-secrets.sh', 'init-nightly-submodules.sh', 'package-nightly-macos.sh',
    'verify-nightly-macos-artifact.sh', 'upload-nightly-artifacts.sh', 'publish-nightly-prerelease.sh',
  ]) {
    assert.match(workflow, new RegExp(`run: bash (\\.\\./\\.\\./)?scripts/release/${script.replace('.', '\\.')}`), script);
  }
});
