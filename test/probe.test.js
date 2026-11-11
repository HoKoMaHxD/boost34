import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { createCommandHandlers, parseRequest } from '../src/commands.js';
import { runProbe } from '../probe-badges.mjs';

const botId = '111111111111111111';
const userId = '222222222222222222';
const targetId = '141947703742562304';
const otherId = '555555555555555555';
const token = 'example-bot-credential';
const outcome = 'BADGES_REJECTED_BOT_AUTH';
const deniedReport = id => ({ targetId: id, botId, outcome, requests: [
  { route: 'BOT_IDENTITY', http: 200 }, { route: 'USER_BADGES', http: 403, discordCode: 20001 },
] });

function fixture(content = '-فحص ' + targetId, options = {}) {
  let time = 100000;
  const sent = [], calls = [];
  const permissions = new PermissionsBitField(PermissionsBitField.All);
  permissions.remove(PermissionFlagsBits.Administrator);
  for (const name of options.missing || []) permissions.remove(PermissionFlagsBits[name]);
  const message = { content, author: { id: userId, bot: false }, guildId: '333333333333333333', channelId: '444444444444444444',
    client: { user: { id: botId }, users: { fetch: async () => { throw Error('probe must not fetch a separate user'); } } },
    guild: { members: { me: { id: botId } } }, inGuild: () => true,
    channel: { permissionsFor: () => permissions, isThread: () => false, sendTyping: async () => {}, send: async payload => sent.push(payload) },
    reply: async payload => sent.push(payload),
  };
  const handlers = createCommandHandlers({ reader: { get: async () => { throw Error('probe must not use DCDN'); } },
    config: { token, ...options.config }, logger: { info() {}, warn() {} }, now: () => time,
    probe: async input => { calls.push(input); return options.probe ? options.probe(input) : deniedReport(input.targetId); },
  });
  return { handlers, message, sent, calls, advance: ms => { time += ms; } };
}

test('probe parses Arabic and English text commands with optional exact IDs or mentions', () => {
  for (const content of ['-فحص', '!probe', '- فحص', '<@' + botId + '> فحص']) {
    assert.equal(parseRequest(content, botId).kind, 'probe');
  }
  for (const value of [targetId, '<@' + targetId + '>', '<@!' + targetId + '>']) {
    assert.deepEqual(parseRequest('-فحص ' + value, botId), { kind: 'probe', targetId, invalidTarget: false });
  }
  for (const value of ['123', '../profile', targetId + ' extra', '<@&' + targetId + '>']) {
    assert.equal(parseRequest('-فحص ' + value, botId).invalidTarget, true);
  }
});

test('probe runs with only the configured bot credential and returns a shareable JSON report', async () => {
  const f = fixture();
  await f.handlers.onMessage(f.message);
  assert.deepEqual(f.calls, [{ token, targetId }]);
  const payload = f.sent[0];
  assert.match(payload.content, /HTTP 403 \| Discord 20001/);
  assert.match(payload.content, /رفض اعتماد البوت/);
  assert.equal(payload.files[0].name, 'badge-probe-' + targetId + '.json');
  assert.deepEqual(JSON.parse(payload.files[0].attachment.toString()), deniedReport(targetId));
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  const self = fixture('-فحص');
  await self.handlers.onMessage(self.message);
  assert.equal(self.calls[0].targetId, userId);
});

test('probe respects scope, target validation and attachment permission before any HTTP requests', async () => {
  for (const options of [{ config: { guildId: otherId } }, { config: { channelId: otherId } }, { missing: ['AttachFiles'] }]) {
    const f = fixture(undefined, options);
    await f.handlers.onMessage(f.message);
    assert.equal(f.calls.length, 0);
    assert.match(f.sent[0].content, /GUILD_ID|CHANNEL_ID|AttachFiles/);
  }
  const invalid = fixture('-فحص 123');
  await invalid.handlers.onMessage(invalid.message);
  assert.equal(invalid.calls.length, 0);
  assert.match(invalid.sent[0].content, /آيدي مستخدم صحيح/);
  const noEmbed = fixture(undefined, { missing: ['EmbedLinks'] });
  await noEmbed.handlers.onMessage(noEmbed.message);
  assert.equal(noEmbed.calls.length, 1);
});

test('cached probe reports avoid requests for an hour; new targets have a global one-minute delay', async () => {
  const f = fixture();
  await f.handlers.onMessage(f.message);
  f.advance(3001);
  f.message.author = { id: otherId, bot: false };
  await f.handlers.onMessage(f.message);
  assert.match(f.sent.at(-1).content, /نتيجة محفوظة/);
  assert.equal(f.calls.length, 1);
  f.advance(3001);
  f.message.content = '-فحص ' + otherId;
  await f.handlers.onMessage(f.message);
  assert.match(f.sent.at(-1).content, /قبل فحص حساب جديد/);
  assert.equal(f.calls.length, 1);
  f.advance(60000);
  await f.handlers.onMessage(f.message);
  assert.equal(f.calls.length, 2);
  f.advance(3600001);
  f.handlers.cleanup();
  f.message.content = '-فحص ' + targetId;
  await f.handlers.onMessage(f.message);
  assert.equal(f.calls.length, 3);
});

test('only one probe can execute at a time while ordinary ping remains available', async () => {
  let finish;
  const f = fixture(undefined, { probe: () => new Promise(resolve => { finish = resolve; }) });
  const first = f.handlers.onMessage(f.message);
  await new Promise(resolve => setImmediate(resolve));
  f.message.author = { id: otherId, bot: false };
  f.message.content = '-فحص ' + otherId;
  await f.handlers.onMessage(f.message);
  assert.match(f.sent[0].content, /يوجد فحص شارات/);
  f.message.content = '-ping';
  await f.handlers.onMessage(f.message);
  assert.match(f.sent[1].content, /Pong/);
  finish(deniedReport(targetId));
  await first;
  assert.equal(f.calls.length, 1);
});

test('diagnostic attachments redact the configured bot token even from unexpected badge text', async () => {
  const f = fixture(undefined, { probe: () => ({ ...deniedReport(targetId), label: 'unexpected ' + token }) });
  await f.handlers.onMessage(f.message);
  const serialized = f.sent[0].files[0].attachment.toString();
  assert.equal(serialized.includes(token), false);
  assert.ok(serialized.includes('[REDACTED]'));
  assert.equal(f.sent[0].content.includes(token), false);
});

test('runner verifies bot identity, filters unrelated data and limits successful probes to four requests', async () => {
  const calls = [];
  const result = await runProbe({ token, targetId, wait: async () => {}, request: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bot ' + token);
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/users/@me')) return Response.json({ id: botId, bot: true, email: 'private@example.com' });
    if (url.endsWith('/badges')) return Response.json([{ id: 1, name: 'Nitro' }, { id: 18, name: 'Account Age' }]);
    return Response.json({ id: 1, label: 'Subscriber since 12/01/2025', extra_private_data: 'discard me' });
  } });
  assert.equal(calls.length, 4);
  assert.equal(result.requests[1].selectedBadges.length, 1);
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  assert.equal(JSON.stringify(result).includes('discard me'), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(result.outcome, 'CHECK_BADGE_FIELDS_NOT_A_CONFIRMED_SOLUTION');
});

test('runner stops on denied access, rate limits or an invalid/non-bot credential without retries', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const result = await runProbe({ token, targetId, wait: async () => {}, request: async () => {
      calls++;
      return calls === 1 ? Response.json({ id: botId, bot: true }) : Response.json({ code: 20001 }, { status });
    } });
    assert.equal(calls, 2);
    assert.notEqual(result.outcome, 'CHECK_BADGE_FIELDS_NOT_A_CONFIRMED_SOLUTION');
  }
  let calls = 0;
  const nonBot = await runProbe({ token, request: async () => { calls++; return Response.json({ bot: false }); } });
  assert.equal(calls, 1);
  assert.equal(nonBot.outcome, 'BOT_AUTH_CHECK_FAILED');
});
