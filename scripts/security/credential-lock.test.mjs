import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'credential-runtime-'));
after(() => rm(runtimeDirectory, { recursive: true, force: true }));
const runtimePath = path.join(runtimeDirectory, 'store.mjs');
const storePath = fileURLToPath(new URL('../../packages/desktop-cli/dist/runtime/plugin-credentials-store.js', import.meta.url));
const cipherPath = fileURLToPath(new URL('../../packages/desktop-cli/dist/runtime/keychain-plugin-cipher.js', import.meta.url));

// Bundle the built public store for Node, as the standalone CLI does. Only the
// external OS keychain is replaced; locking, encryption and disk I/O are real.
await build({
  stdin: {
    contents: `
      import { LocalPluginCredentialsStore } from ${JSON.stringify(storePath)};
      import { keychainPluginCredentialCipher } from ${JSON.stringify(cipherPath)};
      export function createStore(directory, crash = false) {
        return new LocalPluginCredentialsStore(directory, () => {
          const cipher = keychainPluginCredentialCipher(directory,
            () => { throw new Error('Legacy fixture is not expected'); },
            () => ({ getPassword: () => '01'.repeat(32), setPassword: () => { throw new Error('Fixture key already exists'); } }));
          return { ...cipher, encrypt(...args) {
            if (crash) process.exit(0);
            // Slow keychain calls make writes overlap without startup timing.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            return cipher.encrypt(...args);
          } };
        });
      }
    `,
    resolveDir: path.dirname(storePath),
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  outfile: runtimePath,
});

const moduleUrl = pathToFileURL(runtimePath).href;
const { createStore } = await import(moduleUrl);

function child(directory, profileId, crash = false) {
  const source = `
    import { createStore } from ${JSON.stringify(moduleUrl)};
    const [directory, profileId, mode] = process.argv.slice(1);
    await createStore(directory, mode === 'crash').set(profileId, { token: 'fixture-token-' + profileId });
  `;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', source, directory, profileId, crash ? 'crash' : 'write'], { stdio: 'pipe' });
    let stderr = '';
    childProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    childProcess.on('error', reject);
    childProcess.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('independent processes preserve every encrypted profile write', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'credential-lock-'));
  try {
    const ids = Array.from({ length: 8 }, (_, index) => `profile-${index}`);
    await Promise.all(ids.map((id) => child(directory, id)));
    const reader = createStore(directory);
    for (const id of ids) {
      assert.deepEqual({ ...await reader.get(id) }, { token: `fixture-token-${id}` });
    }
    assert.doesNotMatch(await readFile(path.join(directory, 'auth', 'plugins.json'), 'utf8'), /fixture-token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a crashed writer preserves encrypted profiles and permits explicit recovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'credential-crash-'));
  const file = path.join(directory, 'auth', 'plugins.json');
  try {
    const store = createStore(directory);
    await store.set('original', { token: 'fixture-original-token' });
    const original = await readFile(file, 'utf8');
    await child(directory, 'interrupted', true);
    await assert.rejects(store.set('retry', { token: 'fixture-retry-token' }), /locked by another process/);
    assert.equal(await readFile(file, 'utf8'), original);

    // The child has exited and no process is using this disposable profile.
    await rm(`${file}.lock`, { recursive: true });
    await store.set('recovered', { token: 'fixture-recovered-token' });
    const reopened = createStore(directory);
    assert.deepEqual({ ...await reopened.get('original') }, { token: 'fixture-original-token' });
    assert.deepEqual({ ...await reopened.get('recovered') }, { token: 'fixture-recovered-token' });
    assert.deepEqual({ ...await reopened.get('interrupted') }, {});
    assert.doesNotMatch(await readFile(file, 'utf8'), /fixture-.*token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
