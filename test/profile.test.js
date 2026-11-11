import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileReader, PROFILE_CACHE_MS, PROFILE_ERROR_CACHE_MS, getStart } from '../src/profile.js';
import { createCommandHandlers } from '../src/commands.js';
import { makeCard } from '../src/card.js';

const ids = ['222222222222222222', '333333333333333333', '444444444444444444', '555555555555555555'];
const epoch = Date.parse('2026-11-05T00:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (id = ids[0], extra = {}) => Response.json({
  user: { id, bio: 'not retained' }, premium_since: '2022-01-01T00:00:00Z',
  premium_guild_since: '2023-06-01T00:00:00Z', connected_accounts: ['not retained'], ...extra,
});
function fixture(request, options = {}) {
  let clock = epoch;
  const waits = [], warnings = [];
  const reader = new ProfileReader({ cacheFile: null, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    logger: { warn: line => warnings.push(line) }, request, ...options });
  return { reader, waits, warnings, advance: ms => { clock += ms; }, now: () => clock };
}

test('profile lookups use the external HTTPS service without credentials or guild data', async () => {
  let calls = 0;
  const f = fixture(async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://dcdn.dstn.to/profile/' + ids[0]);
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return reply();
  });
  const [a, b] = await Promise.all([f.reader.get(ids[0]), f.reader.get(ids[0])]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, { premium_since: '2022-01-01T00:00:00Z', premium_guild_since: '2023-06-01T00:00:00Z', fetchedAt: epoch });
  a.premium_since = null;
  assert.equal((await f.reader.get(ids[0])).premium_since, '2022-01-01T00:00:00Z');
  assert.equal(calls, 1);
});

test('successful data expires at 24 hours; expired data is not presented when the service fails', async () => {
  let calls = 0, fail = false;
  const f = fixture(async () => { calls++; return fail ? new Response('{}', { status: 503 }) : reply(); });
  await f.reader.get(ids[0]);
  f.advance(PROFILE_CACHE_MS - 1);
  assert.equal((await f.reader.get(ids[0])).fetchedAt, epoch);
  assert.equal(calls, 1);
  f.advance(1);
  assert.equal((await f.reader.get(ids[0])).fetchedAt, epoch + PROFILE_CACHE_MS);
  assert.equal(calls, 2);
  f.advance(PROFILE_CACHE_MS);
  fail = true;
  await assert.rejects(f.reader.get(ids[0]), { code: 'UNAVAILABLE' });
  assert.equal(calls, 3);
});

test('cache survives a process restart and stores only dates and freshness, not full profiles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'boost24-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = join(directory, 'cache.json');
  let calls = 0;
  const first = fixture(async () => { calls++; return reply(); }, { cacheFile });
  const expected = await first.reader.get(ids[0]);
  const serialized = await readFile(cacheFile, 'utf8');
  assert.equal(serialized.includes('not retained'), false);
  assert.equal(serialized.includes('connected_accounts'), false);
  assert.equal(serialized.includes('"user"'), false);
  const second = fixture(async () => { throw new Error('valid disk cache must prevent a request'); }, { cacheFile });
  assert.deepEqual(await second.reader.get(ids[0]), expected);
  assert.equal(calls, 1);
});

test('unknown/private profiles are cached for an hour and never become guessed dates', async () => {
  for (const [response, code] of [
    [() => new Response('{}', { status: 404 }), 'PROFILE_NOT_FOUND'],
    [() => Response.json({ error: true, code: 'unknown_user' }), 'PROFILE_NOT_FOUND'],
    [() => reply(ids[0], { private: true }), 'PROFILE_PRIVATE'],
    [() => Response.json({ user: { id: ids[0] } }), 'MISSING_DATE'],
    [() => reply(ids[0], { premium_since: 'not-a-date' }), 'MISSING_DATE'],
    [() => reply(ids[0], { premium_since: '2099-01-01' }), 'MISSING_DATE'],
  ]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return response(); });
    await assert.rejects(f.reader.get(ids[0]), { code });
    await assert.rejects(f.reader.get(ids[0]), { code });
    assert.equal(calls, 1);
    f.advance(PROFILE_ERROR_CACHE_MS);
    await assert.rejects(f.reader.get(ids[0]), { code });
    assert.equal(calls, 2);
  }
});

test('a missing subscription is distinct from a hidden or uncovered profile', async () => {
  const f = fixture(async () => reply(ids[0], { premium_since: null, premium_guild_since: null }));
  const data = await f.reader.get(ids[0]);
  assert.throws(() => getStart(data, 'nitro', epoch), { code: 'NO_DATE' });
  assert.throws(() => getStart(data, 'boost', epoch), { code: 'NO_DATE' });
});

test('429 backoff honors body seconds and header seconds or HTTP dates without retries', async () => {
  for (const response of [
    () => Response.json({ retry_after: 30 }, { status: 429 }),
    () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
    () => new Response('', { status: 429, headers: { 'Retry-After': new Date(epoch + 30000).toUTCString() } }),
  ]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return calls === 1 ? response() : reply(ids[1]); });
    await assert.rejects(f.reader.get(ids[0]), { code: 'RATE_LIMIT' });
    f.advance(29999);
    await assert.rejects(f.reader.get(ids[1]), { code: 'RATE_LIMIT' });
    assert.equal(calls, 1);
    f.advance(1);
    await f.reader.get(ids[1]);
    assert.equal(calls, 2);
  }
});

test('outages, access denials and wrong-user responses stop further requests temporarily', async () => {
  for (const [response, code] of [
    [() => new Response('{}', { status: 401 }), 'SERVICE_ACCESS'],
    [() => new Response('{}', { status: 403 }), 'SERVICE_ACCESS'],
    [() => new Response('{}', { status: 502 }), 'UNAVAILABLE'],
    [() => new Response('<html>not JSON</html>'), 'UNAVAILABLE'],
    [() => reply(ids[1]), 'UNAVAILABLE'],
    [() => { throw new Error('request details must stay private'); }, 'NETWORK'],
  ]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return response(); });
    await assert.rejects(f.reader.get(ids[0]), { code });
    await assert.rejects(f.reader.get(ids[1]), { code });
    assert.equal(calls, 1);
    assert.deepEqual(f.warnings, []);
  }
});

test('service backoff still allows already cached results', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return calls === 1 ? reply() : new Response('{}', { status: 429 }); });
  const data = await f.reader.get(ids[0]);
  await assert.rejects(f.reader.get(ids[1]), { code: 'RATE_LIMIT' });
  assert.deepEqual(await f.reader.get(ids[0]), data);
  assert.equal(calls, 2);
});

test('new profiles are serialized five seconds apart and the pending queue is bounded', async () => {
  let finish;
  const starts = [];
  const f = fixture(async url => {
    starts.push(f.now());
    if (starts.length === 1) await new Promise(resolve => { finish = resolve; });
    return reply(url.pathname.split('/').at(-1));
  });
  const first = f.reader.get(ids[0]);
  await tick();
  const same = f.reader.get(ids[0]);
  const second = f.reader.get(ids[1]);
  const third = f.reader.get(ids[2]);
  await tick();
  await assert.rejects(f.reader.get(ids[3]), { code: 'BUSY' });
  finish();
  await Promise.all([first, same, second, third]);
  assert.deepEqual(starts, [epoch, epoch + 5000, epoch + 10000]);
  assert.deepEqual(f.waits, [5000, 5000]);
});

test('malformed and expired disk entries are ignored; write failures preserve in-memory cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'boost24-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = join(directory, 'bad.json');
  await writeFile(cacheFile, JSON.stringify({ version: 1, entries: [
    [ids[0], { data: { premium_since: 'garbage' }, fetchedAt: epoch, until: epoch + 1000 }],
    [ids[1], { data: { premium_since: '2020-01-01' }, fetchedAt: epoch, until: epoch - 1 }],
  ] }));
  let calls = 0;
  const f = fixture(async () => { calls++; return reply(); }, { cacheFile });
  await f.reader.get(ids[0]);
  assert.equal(calls, 1);
  const failure = fixture(async () => reply(), { cacheFile: directory });
  await failure.reader.get(ids[0]);
  await failure.reader.get(ids[0]);
  assert.ok(failure.warnings.some(line => line.includes('PROFILE_CACHE_WRITE')));
});

test('invalid target IDs cannot generate URLs or call the service', async () => {
  const f = fixture(async () => { throw new Error('must not call'); });
  for (const id of ['123', '../profile', 'https://example.com', 222222222222222222, undefined]) {
    await assert.rejects(f.reader.get(id), { code: 'INVALID_TARGET' });
  }
});

test('slash Nitro integrates the tokenless service with the existing card and freshness note', async () => {
  const f = fixture(async () => reply());
  const user = { id: ids[0], username: 'Member', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
  const sent = [];
  const interaction = { commandName: 'نيترو', user, guildId: ids[1], channelId: ids[2],
    isChatInputCommand: () => true, inGuild: () => true, deferred: false,
    options: { getUser: () => null },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async payload => sent.push(payload), reply: async payload => sent.push(payload),
  };
  const handlers = createCommandHandlers({ reader: f.reader, now: f.now, logger: { info() {}, warn() {} } });
  await handlers.onInteraction(interaction);
  assert.equal(interaction.deferred, true);
  assert.equal(sent[0].files[0].name, 'nitro-' + ids[0] + '.png');
  const description = sent[0].embeds[0].toJSON().description;
  assert.ok(description.includes('Data fetched: <t:' + epoch / 1000 + ':R>'));
  assert.match(description, /may be delayed/);
  const snow = await makeCard(user, 'snow', new Date('2026-01-01'), new Date(epoch), user, { fetchedAt: epoch });
  assert.equal(snow.embeds[0].toJSON().description.includes('Data fetched'), false);
});
