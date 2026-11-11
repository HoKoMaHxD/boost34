import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadReaderTokens, RotatingProfileReader } from '../src/reader-token.js';

const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
const config = { source: 'discord.py-self', python: 'python3' };
function mockManager(tokens = ids) {
  const calls = [], created = [], persisted = [], closes = [];
  const manager = new RotatingProfileReader(config, {
    tokens,
    tokenFileForSlot: i => `token-${i}.json`,
    cacheFileForSlot: i => `cache-${i}.json`,
    createReader: (settings, opts) => {
      const bridge = {
        connected: false, disabledCode: null,
        start: async () => { bridge.connected = true; },
      };
      const reader = {
        ready: Promise.resolve(), tail: Promise.resolve(), cache: new Map(),
        bridge, close: async () => { bridge.connected = false; closes.push(settings.token); },
        saveCache: async () => {},
        get: async id => { calls.push({ id, token: settings.token, cacheFile: opts.cacheFile }); return { premium_since: null }; },
      };
      created.push({ settings, opts, reader });
      return reader;
    },
    persist: async (token, file) => { persisted.push([token, file]); },
  });
  return { manager, calls, created, persisted, closes };
}

test('round robin rotates over five configured slots, preserving distinct caches', async t => {
  const f = mockManager(); t.after(() => f.manager.close());
  for (let i = 0; i < 7; i++) await f.manager.get('123456789012345678');
  assert.deepEqual(f.calls.map(c => c.token), ['a1','a2','a3','a4','a5','a1','a2']);
  assert.deepEqual(f.calls.slice(0, 5).map(c => c.cacheFile), [1,2,3,4,5].map(i => `cache-${i}.json`));
});

test('unset and stopped credentials do not receive requests; no automatic replay after a reader error', async t => {
  const f = mockManager(['a1', '', 'a3']); t.after(() => f.manager.close());
  await f.manager.get('123456789012345678');
  f.manager.slots[0].reader.bridge.disabledCode = 'READER_AUTH';
  await f.manager.get('123456789012345678');
  assert.deepEqual(f.calls.map(c => c.token), ['a1', 'a3']);
  f.manager.slots[2].reader.bridge.disabledCode = 'READER_VERIFICATION';
  await assert.rejects(f.manager.get('123456789012345678'), { code: 'READER_CLOSED' });
  assert.equal(f.calls.length, 2);
});

test('status probes each configured connection but never exposes credentials', async t => {
  const f = mockManager(['a1', '', 'a3', '', 'a5']); t.after(() => f.manager.close());
  f.manager.slots[2].reader.bridge.disabledCode = 'READER_AUTH';
  const before = await f.manager.getStatuses();
  assert.deepEqual(before.map(x => x.state), ['not-checked', 'missing', 'stopped', 'missing', 'not-checked']);
  const after = await f.manager.getStatuses({ probe: true });
  assert.deepEqual(after.map(x => x.state), ['connected', 'missing', 'stopped', 'missing', 'connected']);
  assert.equal(JSON.stringify(after).includes('a1'), false);
  assert.equal(f.calls.length, 0);
});

test('updating slot four touches only its own reader and rejects same credentials in other slots', async t => {
  const f = mockManager(['a1', 'a2']); t.after(() => f.manager.close());
  const previous = f.manager.slots[3].reader;
  await f.manager.updateToken('a4', 4);
  assert.deepEqual(f.persisted, [['a4', 'token-4.json']]);
  assert.notEqual(f.manager.slots[3].reader, previous);
  assert.equal(f.manager.slots[0].settings.token, 'a1');
  assert.equal(f.manager.slots[1].settings.token, 'a2');
  assert.equal(f.closes.length, 1);
  await assert.rejects(f.manager.updateToken('a1', 5), { code: 'TOKEN_DUPLICATE' });
  await assert.rejects(f.manager.updateToken('x', 6), { code: 'TOKEN_SLOT_INVALID' });
});

test('legacy saved token migrates as fallback and slot files override env', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-slots-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'legacy.json'), '{"token":"legacy1"}');
  await writeFile(join(dir, 'token-2.json'), '{"token":"saved2"}');
  const loaded = await loadReaderTokens({ READER_TOKEN_1: 'env1', READER_TOKEN_2: 'env2', READER_TOKEN_5: 'env5' }, {
    legacyFile: join(dir, 'legacy.json'), tokenFileForSlot: i => join(dir, `token-${i}.json`),
  });
  assert.deepEqual(loaded, ['env1', 'saved2', '', '', 'env5']);
  const migrated = await loadReaderTokens({ READER_TOKEN: 'oldenv' }, {
    legacyFile: join(dir, 'legacy.json'), tokenFileForSlot: i => join(dir, `token-${i}.json`),
  });
  assert.equal(migrated[0], 'legacy1');
});

test('offline worker handshake is a real connected status, not merely a saved token', async t => {
  const { PythonReaderBridge, PythonProfileReader } = await import('../src/python-reader.js');
  const { fileURLToPath } = await import('node:url');
  const worker = fileURLToPath(new URL('./fixtures/fake-reader.py', import.meta.url));
  const logger = { info() {}, warn() {} };
  const manager = new RotatingProfileReader(config, {
    tokens: ['fixture-only-placeholder'], logger,
    createReader: settings => new PythonProfileReader({
      cacheFile: null, logger,
      bridge: new PythonReaderBridge({ token: settings.token, worker, logger, startupTimeout: 3000 }),
    }),
  });
  t.after(() => manager.close());
  const before = await manager.getStatuses();
  assert.equal(before[0].state, 'not-checked');
  const after = await manager.getStatuses({ probe: true });
  assert.deepEqual(after.map(s => s.state), ['connected', 'missing', 'missing', 'missing', 'missing']);
  assert.equal(manager.slots[0].reader.bridge.connected, true);
});
