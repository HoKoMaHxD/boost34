import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const runtime = fileURLToPath(new URL('../scripts/reader-runtime.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reader setup '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const python = join(directory, 'python mock.cjs');
  await writeFile(python, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const calls = path.join(__dirname, 'calls');
if (process.env.BOT_TOKEN || process.env.READER_TOKEN || process.env.FIXTURE_SECRET) process.exit(9);
const args = process.argv.slice(2);
fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
const marker = path.join(__dirname, 'installed');
if (args.includes('pip')) {
  if (fs.existsSync(path.join(__dirname, 'fail'))) process.exit(2);
  fs.writeFileSync(marker, 'installed'); process.exit(0);
}
if (args.some(x => x.endsWith('/reader/check.py') || x.endsWith('\\\\reader\\\\check.py'))) {
  const ok = fs.existsSync(marker);
  console.log(JSON.stringify({code:ok ? 'OK' : 'READER_PACKAGE_MISSING',offline_check:ok ? 'ok':'failed'}));
  process.exit(ok ? 0 : 1);
}
process.exit(8);
`, { mode: 0o700 });
  const env = { ...process.env, PYTHON_BIN: python, PROFILE_SOURCE: 'discord.py-self',
    BOT_TOKEN: 'fixture-bot-secret', READER_TOKEN: 'fixture-reader-secret', FIXTURE_SECRET: 'fixture-other-secret' };
  return { directory, env, run: (mode = 'ensure', overrides = {}) => execute(process.execPath, [runtime, mode], { env: { ...env, ...overrides } }),
    calls: async () => (await readFile(join(directory, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('automatic setup fixes a missing package once in the selected interpreter and never passes tokens', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.match(result.stdout, /READER_AUTO_SETUP/);
  assert.match(result.stdout, /"offline_check":"ok"/);
  assert.doesNotMatch(result.stderr, /READER_SETUP_UNAVAILABLE/);
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].slice(0, 3), ['-m', 'pip', 'install']);
  const again = await f.run();
  assert.doesNotMatch(again.stdout, /READER_AUTO_SETUP/);
  assert.equal((await f.calls()).length, 4);
});

test('automatic setup skips external mode and an unconfigured reader', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const overrides of [{ PROFILE_SOURCE: 'dcdn' }, { READER_TOKEN: '' }]) {
    const result = await f.run('ensure', overrides);
    assert.match(result.stdout, /READER_SETUP_SKIPPED/);
  }
  await assert.rejects(readFile(join(f.directory, 'calls')), { code: 'ENOENT' });
});

test('installation failure does not block Snow/ping startup or loop installations', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'fail'), 'fail');
  const result = await f.run();
  assert.match(result.stderr, /READER_SETUP_FAILED/);
  assert.match(result.stderr, /READER_SETUP_UNAVAILABLE/);
  assert.equal((await f.calls()).filter(args => args.includes('pip')).length, 1);
});

test('manual check returns failure while missing Python in automatic setup reports a clear cause', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('check'), error => error.code === 1 && /READER_CHECK_FAILED/.test(error.stderr));
  const result = await f.run('ensure', { PYTHON_BIN: '/no-such-python-interpreter' });
  assert.match(result.stderr, /READER_PYTHON_MISSING/);
  assert.match(result.stderr, /READER_SETUP_UNAVAILABLE/);
});
