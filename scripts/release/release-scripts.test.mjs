// Offline checks for the CE release scripts: node, npx and gh are stubs that only record their arguments,
// so nothing here builds, signs, uploads or publishes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function stub(dir, name, body = '') {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/bash\nprintf '%s' "${name}" >> "$CALL_LOG"; for a in "$@"; do printf ' %s' "$a" >> "$CALL_LOG"; done; printf '\\n' >> "$CALL_LOG"\n${body}\n`);
  chmodSync(file, 0o755);
}

function run(script, args, env, { cwd = '', nodeFailsOn = '' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ce-release-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(path.join(root, 'apps/desktop/scripts'), { recursive: true });
  cpSync(path.join(repoRoot, 'scripts/release'), path.join(root, 'scripts/release'), { recursive: true });
  for (const helper of ['create-ci-builder-config.sh', 'normalize-ce-builder-config.sh']) {
    writeFileSync(path.join(root, 'apps/desktop/scripts', helper), `printf '%s' "${helper}" >> "$CALL_LOG"; for a in "$@"; do printf ' %s' "$a" >> "$CALL_LOG"; done; printf '\\n' >> "$CALL_LOG"\n`);
  }
  stub(bin, 'node', nodeFailsOn ? `case "$1" in *${nodeFailsOn}) exit 3;; esac` : '');
  stub(bin, 'npx', `printf 'signing after_sign=%s apple_id=%s apple_password=%s team=%s update_url=%s artifact=%s\\n' "$DESKTOP_ENABLE_AFTER_SIGN" "\${APPLE_ID-unset}" "\${APPLE_APP_PASSWORD-unset}" "\${APPLE_TEAM_ID-unset}" "$DESKTOP_UPDATE_BASE_URL" "$DESKTOP_ARTIFACT_NAME" >> "$CALL_LOG"`);
  stub(bin, 'gh', `if [ "$1 $2" = "release view" ]; then exit "\${GH_RELEASE_VIEW_EXIT:-1}"; fi`);
  const callLog = path.join(root, 'calls.log');
  writeFileSync(callLog, '');
  const output = path.join(root, 'github-output');
  const result = spawnSync('bash', [path.join(root, cwd, script), ...args], {
    cwd: path.join(root, cwd),
    env: { PATH: `${bin}:/usr/bin:/bin`, CALL_LOG: callLog, GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    status: result.status,
    stderr: result.stderr,
    calls: read(callLog).trimEnd().split('\n').filter(Boolean),
    outputs: Object.fromEntries(read(output).trimEnd().split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2))),
    body: read(path.join(root, cwd, 'release-body.md')),
  };
}

const metadata = (channel, ref, version = '0.2.0') =>
  run('scripts/release/resolve-ce-release-metadata.sh', [], {
    RELEASE_VERSION: version,
    RELEASE_CHANNEL: channel,
    BASE_URL: 'https://downloads.example',
    GITHUB_REF_NAME: ref,
    GITHUB_SHA: SHA,
  });

test('metadata maps each channel to its prefix and publication flag', () => {
  assert.deepEqual(metadata('stable', 'main').outputs, {
    release_tag: 'desktop-ce-v0.2.0',
    release_version: '0.2.0',
    release_display_version: 'v0.2.0',
    release_channel: 'stable',
    artifact_prefix: 'desktop-ce/releases',
    artifact_version_segment: 'desktop-ce-v0.2.0',
    artifact_base_url: 'https://downloads.example/desktop-ce/releases',
    publish_release_metadata: 'true',
  });
  const beta = metadata('beta', 'feat/a:b@c').outputs;
  assert.equal(beta.artifact_prefix, 'desktop-ce/beta/feat-a-b-c');
  assert.equal(beta.artifact_version_segment, SHA);
  assert.equal(beta.publish_release_metadata, 'true');
  const preview = metadata('preview', 'main').outputs;
  assert.equal(preview.artifact_prefix, 'desktop-ce/previews/main');
  assert.equal(preview.publish_release_metadata, 'false');
});

test('metadata refuses stable releases off main and malformed versions', () => {
  const offMain = metadata('stable', 'feat/a');
  assert.equal(offMain.status, 1);
  assert.match(offMain.stderr, /Stable CE releases can only be published from main/);
  assert.deepEqual(offMain.outputs, {});
  const malformed = metadata('beta', 'main', '1.2');
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid CE release version: 1\.2/);
});

const signing = (skip) =>
  run('../../scripts/release/package-ce-macos.sh', ['arm64', 'aarch64', 'arm64'], {
    ARTIFACT_BASE_URL: 'https://downloads.example/desktop-ce/beta/main',
    SKIP_NOTARIZE_INPUT: skip,
    APPLE_ID: 'id',
    APPLE_APP_PASSWORD: 'password',
    APPLE_TEAM_ID: 'team',
  }, { cwd: 'apps/desktop' });

test('macOS packaging drops Apple credentials and the afterSign hook only when notarization is skipped', () => {
  const skipped = signing('true');
  assert.equal(skipped.status, 0);
  assert.deepEqual(skipped.calls, [
    'create-ci-builder-config.sh electron-builder.ci.yml',
    'normalize-ce-builder-config.sh electron-builder.ci.yml bitsentry-desktop-ce-${version}-macos-aarch64.${ext}',
    'npx electron-builder build --config electron-builder.ci.yml --mac --arm64 --publish never',
    'signing after_sign=false apple_id=unset apple_password=unset team=unset update_url=https://downloads.example/desktop-ce/beta/main/macos/arm64 artifact=bitsentry-desktop-ce-${version}-macos-aarch64.${ext}',
  ]);
  for (const notarize of ['false', '']) {
    assert.match(signing(notarize).calls.at(-1), /^signing after_sign=true apple_id=id apple_password=password team=team /);
  }
});

const releaseEnv = (channel) => ({
  BITSENTRY_RELEASE_CHANNEL: channel,
  ARTIFACT_PREFIX: 'desktop-ce/beta/main',
  ARTIFACT_VERSION_SEGMENT: SHA,
});
const verify = 'node apps/desktop/scripts/dist/verify-update-manifest.js';
const upload = 'node apps/desktop/scripts/dist/upload-r2-artifacts.js';

test('macOS upload publishes the channel feed, or the raw manifest for previews', () => {
  const beta = run('scripts/release/upload-ce-macos-artifacts.sh', ['x64', 'x86_64', '0.2.0'], releaseEnv('beta'));
  const files = ['dmg', 'zip', 'dmg.blockmap', 'zip.blockmap'].map((ext) => `--include bitsentry-desktop-ce-0.2.0-macos-x86_64.${ext}`).join(' ');
  assert.deepEqual(beta.calls, [
    `${verify} --manifest apps/desktop/release/build/channel-feed/latest-mac.yml --artifact-root apps/desktop/release/build --required-artifact-prefix bitsentry-desktop-ce- --required-path-prefix ${SHA}`,
    `${upload} --root apps/desktop/release/build --prefix desktop-ce/beta/main/macos/x64/${SHA} ${files} --if-no-files-found error`,
    `${upload} --root apps/desktop/release/build/channel-feed --prefix desktop-ce/beta/main/macos/x64 --include latest-mac.yml --if-no-files-found error`,
  ]);
  const preview = run('scripts/release/upload-ce-macos-artifacts.sh', ['x64', 'x86_64', '0.2.0'], releaseEnv('preview'));
  assert.equal(preview.calls[0], `${verify} --manifest apps/desktop/release/build/latest-mac.yml --artifact-root apps/desktop/release/build --required-artifact-prefix bitsentry-desktop-ce-`);
  assert.equal(preview.calls[2], `${upload} --root apps/desktop/release/build --prefix desktop-ce/beta/main/macos/x64/${SHA} --include latest-mac.yml --if-no-files-found error`);
});

test('Windows upload verifies the uploaded objects against the feed or versioned prefix', () => {
  const stable = run('scripts/release/upload-ce-windows-artifacts.sh', ['0.2.0'], releaseEnv('stable'));
  assert.equal(stable.calls[2], `node apps/desktop/scripts/dist/verify-r2-artifacts.js --manifest apps/desktop/release/build/channel-feed/latest.yml --object-prefix desktop-ce/beta/main/windows/x64 --exe apps/desktop/release/build/bitsentry-desktop-ce-0.2.0-windows-x86_64.exe --blockmap apps/desktop/release/build/bitsentry-desktop-ce-0.2.0-windows-x86_64.exe.blockmap`);
  assert.equal(stable.calls[3], `${upload} --root apps/desktop/release/build/channel-feed --prefix desktop-ce/beta/main/windows/x64 --include latest.yml --if-no-files-found error`);
  const preview = run('scripts/release/upload-ce-windows-artifacts.sh', ['0.2.0'], releaseEnv('preview'));
  assert.match(preview.calls[2], new RegExp(`--object-prefix desktop-ce/beta/main/windows/x64/${SHA} `));
  assert.equal(preview.calls[3], `${upload} --root apps/desktop/release/build --prefix desktop-ce/beta/main/windows/x64/${SHA} --include latest.yml --if-no-files-found error`);
});

test('Linux upload uses the per-architecture feed manifest', () => {
  const beta = run('scripts/release/upload-ce-linux-artifacts.sh', ['arm64', 'aarch64', 'latest-linux-arm64.yml', '0.2.0'], releaseEnv('beta'));
  assert.deepEqual(beta.calls.slice(1), [
    `${upload} --root apps/desktop/release/build --prefix desktop-ce/beta/main/linux/arm64/${SHA} --include bitsentry-desktop-ce-0.2.0-linux-aarch64.AppImage --if-no-files-found error`,
    `${upload} --root apps/desktop/release/build/channel-feed --prefix desktop-ce/beta/main/linux/arm64 --include latest-linux-arm64.yml --if-no-files-found error`,
  ]);
});

test('uploads stop before any upload when manifest verification fails', () => {
  for (const [script, args] of [
    ['upload-ce-macos-artifacts.sh', ['arm64', 'aarch64', '0.2.0']],
    ['upload-ce-windows-artifacts.sh', ['0.2.0']],
    ['upload-ce-linux-artifacts.sh', ['x64', 'x86_64', 'latest-linux.yml', '0.2.0']],
  ]) {
    const result = run(`scripts/release/${script}`, args, releaseEnv('beta'), { nodeFailsOn: 'verify-update-manifest.js' });
    assert.equal(result.status, 3, script);
    assert.equal(result.calls.length, 1, script);
  }
});

const publish = (channel, releaseExists) =>
  run('scripts/release/publish-ce-release-metadata.sh', [], {
    GITHUB_REPOSITORY: 'bitsentry-ai/desktop-ce',
    GITHUB_SHA: SHA,
    RELEASE_TAG: 'desktop-ce-v0.2.0',
    RELEASE_VERSION: '0.2.0',
    RELEASE_CHANNEL: channel,
    ARTIFACT_BASE_URL: 'https://downloads.example/desktop-ce/releases',
    ARTIFACT_VERSION_SEGMENT: 'desktop-ce-v0.2.0',
    GH_RELEASE_VIEW_EXIT: releaseExists ? '0' : '1',
  });

test('publishing edits an existing release and creates new ones as prereleases unless stable', () => {
  const existing = publish('beta', true);
  assert.equal(existing.calls[1], 'gh release edit desktop-ce-v0.2.0 --repo bitsentry-ai/desktop-ce --title BitSentry Desktop CE 0.2.0 --notes-file release-body.md');
  assert.equal(publish('beta', false).calls[1], `gh release create desktop-ce-v0.2.0 --repo bitsentry-ai/desktop-ce --title BitSentry Desktop CE 0.2.0 --notes-file release-body.md --target ${SHA} --prerelease`);
  const stable = publish('stable', false);
  assert.equal(stable.calls[1], `gh release create desktop-ce-v0.2.0 --repo bitsentry-ai/desktop-ce --title BitSentry Desktop CE 0.2.0 --notes-file release-body.md --target ${SHA}`);
  assert.match(stable.body, /^## BitSentry Desktop CE 0\.2\.0\n\nChannel: stable\n/);
  assert.match(stable.body, /- Linux arm64: https:\/\/downloads\.example\/desktop-ce\/releases\/linux\/arm64\/latest-linux-arm64\.yml\n\nVersioned artifact prefix: desktop-ce-v0\.2\.0\/\n$/);
});

test('the release workflow calls every extracted script', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/desktop-ce-release.yml'), 'utf8');
  for (const script of [
    'resolve-ce-release-metadata.sh',
    'package-ce-macos.sh',
    'upload-ce-macos-artifacts.sh',
    'upload-ce-windows-artifacts.sh',
    'upload-ce-linux-artifacts.sh',
    'publish-ce-release-metadata.sh',
  ]) {
    assert.match(workflow, new RegExp(`run: bash (\\.\\./\\.\\./)?scripts/release/${script.replace('.', '\\.')}`), script);
  }
});

test('package:publish stops with a pointer to the manual release workflow before building anything', () => {
  const desktop = JSON.parse(readFileSync(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8'));
  const root = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(desktop.scripts['package:publish'], 'node scripts/refuse-package-publish.mjs');
  assert.equal(root.scripts['desktop:package:publish'], 'pnpm --filter @bitsentry-ce/desktop run package:publish');
  const result = spawnSync(process.execPath, ['scripts/refuse-package-publish.mjs'], {
    cwd: path.join(repoRoot, 'apps/desktop'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /"Desktop CE Release \(Manual\)" GitHub Actions workflow/);
  assert.match(result.stderr, /\.github\/workflows\/desktop-ce-release\.yml in bitsentry-ai\/desktop-ce/);
  assert.ok(existsSync(path.join(repoRoot, '.github/workflows/desktop-ce-release.yml')));
});
