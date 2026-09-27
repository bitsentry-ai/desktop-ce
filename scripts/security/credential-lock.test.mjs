import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withCredentialFileLock } from '../../packages/desktop-cli/dist/runtime/credential-file-lock.js';

const moduleUrl = new URL('../../packages/desktop-cli/dist/runtime/credential-file-lock.js', import.meta.url).href;
function child(filename, crash = false) {
  const source = `
    import { withCredentialFileLock } from ${JSON.stringify(moduleUrl)};
    import { readFile, writeFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    const file = process.argv[1];
    await withCredentialFileLock(file, async () => {
      if (process.argv[2] === 'crash') process.exit(0);
      const count = Number(await readFile(file, 'utf8'));
      await setTimeout(25);
      await writeFile(file, String(count + 1));
    });
  `;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', source, filename, crash ? 'crash' : 'write'], { stdio: 'pipe' });
    let stderr = '';
    childProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    childProcess.on('error', reject);
    childProcess.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('independent processes serialize read/modify/write', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'credential-lock-'));
  const file = path.join(directory, 'plugins.json');
  try {
    await writeFile(file, '0');
    await Promise.all(Array.from({ length: 8 }, () => child(file)));
    assert.equal(await readFile(file, 'utf8'), '8');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a crashed writer leaves a visible lock rather than permitting an unsafe takeover', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'credential-crash-'));
  const file = path.join(directory, 'plugins.json');
  try {
    await writeFile(file, 'original');
    await child(file, true);
    await assert.rejects(withCredentialFileLock(file, async () => {
      await writeFile(file, 'overwritten');
    }), /locked by another process/);
    assert.equal(await readFile(file, 'utf8'), 'original');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
