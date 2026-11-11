import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PythonReaderBridge, PythonProfileReader, createProfileReader, readProfileConfig } from '../src/python-reader.js';
import { ProfileReader, ProfileError, PROFILE_CACHE_MS } from '../src/profile.js';

const worker = fileURLToPath(new URL('./fixtures/fake-reader.py', import.meta.url));
const id = tail => '141947703742562' + tail;
const epoch = Date.parse('2026-11-05T00:00:00Z');
const dates = { premium_since: '2022-01-01T00:00:00Z', premium_guild_since: '2023-06-01T00:00:00Z' };
function fixture(t, options = {}) {
  const logs = [];
  const bridge = new PythonReaderBridge({ token: 'fixture-only-placeholder', worker,
    python: process.env.TEST_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
    logger: { info: value => logs.push(value), warn: value => logs.push(value) },
    startupTimeout: 3000, requestTimeout: 2000, ...options });
  t.after(() => bridge.close());
  return { bridge, logs };
}
function provider(bridge, options = {}) {
  let clock = epoch;
  const reader = new PythonProfileReader({ bridge, cacheFile: null, now: () => clock,
    wait: async ms => { clock += ms; }, logger: { warn() {} }, ...options });
  return { reader, advance: ms => { clock += ms; } };
}

test('reader selection is explicit; personal credentials do not enter bot config', () => {
  const settings = readProfileConfig({ READER_TOKEN: ' fixture-only-placeholder ' });
  assert.equal(settings.source, 'discord.py-self');
  assert.equal(settings.token, 'fixture-only-placeholder');
  assert.ok(createProfileReader(settings, { cacheFile: null }) instanceof PythonProfileReader);
  const external = createProfileReader(readProfileConfig({ PROFILE_SOURCE: ' DCDN ' }), { cacheFile: null });
  assert.ok(external instanceof ProfileReader);
  assert.equal(external.bridge, undefined);
  assert.throws(() => readProfileConfig({ PROFILE_SOURCE: 'auto' }), /PROFILE_SOURCE/);
});

test('bridge starts one child, passes no bot secrets or token argv, and suppresses raw stderr', async t => {
  const previous = { BOT_TOKEN: process.env.BOT_TOKEN, FIXTURE_OTHER_SECRET: process.env.FIXTURE_OTHER_SECRET };
  process.env.BOT_TOKEN = 'fixture-bot-secret'; process.env.FIXTURE_OTHER_SECRET = 'fixture-other-secret';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const { bridge, logs } = fixture(t);
  const first = await bridge.get(id('111'));
  const pid = bridge.child.pid;
  const second = await bridge.get(id('119'));
  assert.deepEqual(first, second);
  assert.equal(bridge.child.pid, pid);
  assert.equal(logs.filter(value => value.includes('READER_READY')).length, 1);
  assert.equal(logs.join().includes('sensitive'), false);
  assert.equal(logs.join().includes('fixture-only-placeholder'), false);
});

test('missing configuration, invalid IDs and missing Python fail without a login loop', async t => {
  const empty = fixture(t, { token: '' }).bridge;
  await assert.rejects(empty.get(id('111')), { code: 'READER_NOT_CONFIGURED' });
  assert.equal(empty.child, null);
  await assert.rejects(empty.get('not-an-id'), { code: 'INVALID_TARGET' });
  const absent = fixture(t, { python: '/no-such-reader-python' }).bridge;
  await assert.rejects(absent.get(id('111')), { code: 'READER_PYTHON_MISSING' });
  const child = absent.child;
  await assert.rejects(absent.get(id('111')), { code: 'READER_PYTHON_MISSING' });
  assert.equal(absent.child, child);
});

test('dependency failure and startup timeout disable the reader for the session', async t => {
  for (const [token, code] of [['fixture-dependency-failure', 'READER_DEPENDENCY'], ['fixture-startup-hang', 'READER_STARTUP']]) {
    const { bridge } = fixture(t, { token, startupTimeout: 500 });
    await assert.rejects(bridge.get(id('111')), { code });
    const child = bridge.child;
    await assert.rejects(bridge.get(id('111')), { code });
    assert.equal(bridge.child, child);
  }
});

test('verification, auth and access failures stop all queued reads without restarting the child', async t => {
  for (const [suffix, code] of [['112', 'READER_VERIFICATION'], ['113', 'READER_AUTH'], ['114', 'READER_ACCESS']]) {
    const { bridge, logs } = fixture(t);
    const outcomes = await Promise.allSettled([bridge.get(id(suffix)), bridge.get(id('111'))]);
    for (const result of outcomes) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, code); }
    const child = bridge.child;
    await assert.rejects(bridge.get(id('111')), { code });
    assert.equal(bridge.child, child);
    assert.equal(logs.filter(line => line.includes('READER_STOPPED')).length, 1);
  }
});

test('malformed output, oversized output, request timeout and disconnect terminate the reader', async t => {
  for (const [suffix, code] of [['116', 'READER_PROTOCOL'], ['117', 'READER_PROTOCOL'], ['118', 'READER_TIMEOUT'], ['120', 'READER_CLOSED']]) {
    const { bridge } = fixture(t, { requestTimeout: 150 });
    await assert.rejects(bridge.get(id(suffix)), { code });
    await assert.rejects(bridge.get(id('111')), { code });
  }
});

test('closing a pending bridge rejects work and prevents a restart', async t => {
  const { bridge } = fixture(t);
  await bridge.start();
  const outcome = Promise.allSettled([bridge.get(id('118'))]);
  await new Promise(resolve => setImmediate(resolve));
  await bridge.close();
  assert.equal((await outcome)[0].reason.code, 'READER_CLOSED');
  await assert.rejects(bridge.get(id('111')), { code: 'READER_CLOSED' });
});

test('rate limit duration crosses the transport and is honored without a second read', async t => {
  const { bridge } = fixture(t);
  const f = provider(bridge);
  await assert.rejects(f.reader.get(id('115')), { code: 'RATE_LIMIT' });
  assert.equal(f.reader.blockUntil, epoch + 180000);
  f.advance(179999);
  await assert.rejects(f.reader.get(id('111')), { code: 'RATE_LIMIT' });
  assert.equal(bridge.sequence, 1);
  f.advance(1);
  assert.ok((await f.reader.get(id('111'))).premium_since);
  assert.equal(bridge.sequence, 2);
});

test('Python provider deduplicates requests and persists only dates for 24 hours across restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'boost24-python-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = join(directory, 'cache.json');
  let calls = 0;
  const bridge = { get: async () => { calls++; return { ...dates, token: 'must not be persisted', bio: 'must not be persisted' }; }, close: async () => {} };
  const f = provider(bridge, { cacheFile });
  const [first, second] = await Promise.all([f.reader.get(id('111')), f.reader.get(id('111'))]);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  const saved = await readFile(cacheFile, 'utf8');
  assert.equal(saved.includes('must not be persisted'), false);
  const restarted = provider({ get: async () => { throw new Error('must use disk cache'); } }, { cacheFile });
  assert.deepEqual(await restarted.reader.get(id('111')), first);
  f.advance(PROFILE_CACHE_MS - 1);
  await f.reader.get(id('111')); assert.equal(calls, 1);
  f.advance(1);
  await f.reader.get(id('111')); assert.equal(calls, 2);
});

test('private or unknown profiles are cached and network errors impose cooldown', async () => {
  for (const code of ['PROFILE_PRIVATE', 'PROFILE_NOT_FOUND', 'NETWORK', 'UNAVAILABLE']) {
    let calls = 0;
    const f = provider({ get: async () => { calls++; throw new ProfileError(code); } });
    await assert.rejects(f.reader.get(id('111')), { code });
    await assert.rejects(f.reader.get(id('111')), { code });
    assert.equal(calls, 1);
    if (['NETWORK', 'UNAVAILABLE'].includes(code)) {
      await assert.rejects(f.reader.get(id('119')), { code });
      assert.equal(calls, 1);
    }
  }
});
