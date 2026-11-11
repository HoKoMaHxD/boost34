import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createCommandHandlers, parseCommand, registerGuildCommands, slashCommands } from '../src/commands.js';
import { readConfig } from '../src/config.js';
import { ProfileReader } from '../src/profile.js';

const botId = '111111111111111111';
const user = { id: '222222222222222222', username: 'Member' };
const guildId = '333333333333333333';
const channelId = '444444444444444444';
function fixture(content = '-بوست', options = {}) {
  const replies = [], sends = [], logs = [], calls = [], userFetches = [];
  const permissions = new PermissionsBitField(PermissionsBitField.All);
  permissions.remove(PermissionFlagsBits.Administrator);
  for (const name of options.missing || []) permissions.remove(PermissionFlagsBits[name]);
  const logger = { info: value => logs.push(value), warn: value => logs.push(value) };
  const reader = options.reader || { get: async id => {
    calls.push(id);
    return { premium_since: '2020-01-01', premium_guild_since: '2021-01-01' };
  } };
  const message = {
    content, author: user, guildId, channelId, client: { user: { id: botId }, users: { fetch: async id => {
      userFetches.push(id);
      return { id, username: 'TargetMember' };
    } } }, inGuild: () => true,
    guild: { members: { me: { id: botId } } },
    channel: { permissionsFor: () => permissions, isThread: () => options.thread || false,
      sendTyping: async () => {}, send: async payload => { sends.push(payload); } },
    reply: async payload => { replies.push(payload); },
  };
  const rendered = [];
  const handlers = createCommandHandlers({ reader, config: options.config, logger, now: options.now,
    render: async (...args) => { rendered.push(args); return { content: 'CARD', allowedMentions: { parse: [] } }; } });
  return { handlers, message, replies, sends, logs, calls, rendered, logger, userFetches };
}
function interactionFixture(name) {
  const sent = [];
  const interaction = {
    commandName: name, user, guildId, channelId, deferred: false, replied: false,
    isChatInputCommand: () => true, inGuild: () => true,
    deferReply: async () => { interaction.deferred = true; sent.push('DEFER'); },
    reply: async payload => { interaction.replied = true; sent.push(payload); },
    editReply: async payload => { sent.push(payload); },
  };
  return { interaction, sent };
}

test('prefixes, Arabic invisible marks, dash variants and mentions are accepted', () => {
  for (const content of ['-بوست', ' - بوست ', '\u200f-بوست\u200e', '–بوست', '!BOOST', '-بُوسْت', `-بوست <@${user.id}>`, `<@${botId}> بوست`, `<@!${botId}> -بوست`]) {
    assert.equal(parseCommand(content, botId), 'boost', content);
  }
  assert.equal(parseCommand('-نيترو', botId), 'nitro');
  assert.equal(parseCommand('!NiTrO', botId), 'nitro');
  assert.equal(parseCommand(`<@${botId}>`, botId), 'help');
  assert.equal(parseCommand('-ping', botId), 'ping');
  for (const content of ['', 'بوست', 'hello -بوست', '-unknown', `<@${user.id}> بوست`]) assert.equal(parseCommand(content, botId), null);
});
test('config trims IDs and credentials and rejects invalid restrictions before login', () => {
  const config = readConfig({ BOT_TOKEN: ' placeholder ', READER_TOKEN: ' reader ', GUILD_ID: ` ${guildId} `, CHANNEL_ID: ` ${channelId} ` });
  assert.equal(config.guildId, guildId);
  assert.equal(config.channelId, channelId);
  assert.equal(config.token, 'placeholder');
  assert.equal(Object.hasOwn(config, 'readerToken'), false);
  assert.equal(JSON.stringify(config).includes('reader'), false);
  assert.equal(config.messageContent, true);
  assert.equal(readConfig({ BOT_TOKEN: 'placeholder', MESSAGE_CONTENT_INTENT: ' false ' }).messageContent, false);
  assert.throws(() => readConfig({ BOT_TOKEN: ' ' }), /BOT_TOKEN/);
  assert.throws(() => readConfig({ BOT_TOKEN: 'placeholder', CHANNEL_ID: `<#${channelId}>` }), /CHANNEL_ID/);
});
test('ping and mention help respond without any configured profile reader', async () => {
  const f = fixture('-ping', { reader: { get: async () => { throw new Error('ping must not access the service'); } } });
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[0].content, /Pong/);
  f.message.content = `<@${botId}>`;
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[1].content, /الأوامر/);
});
test('message reaches reader and card for the mentioned member and retains the requester', async () => {
  const f = fixture(`-بوست <@555555555555555555>`);
  await f.handlers.onMessage(f.message);
  assert.deepEqual(f.calls, ['555555555555555555']);
  assert.deepEqual(f.userFetches, ['555555555555555555']);
  assert.equal(f.rendered[0][0].id, '555555555555555555');
  assert.equal(f.rendered[0][4], user);
  assert.equal(f.rendered[0][1], 'boost');
  assert.equal(f.rendered[0][2].toISOString(), '2021-01-01T00:00:00.000Z');
  assert.equal(f.replies[0].content, 'CARD');
});
test('an uncovered account gets an explicit reply without claiming it has no Nitro', async () => {
  const f = fixture('-نيترو', { reader: new ProfileReader({ cacheFile: null, request: async () => new Response('{}', { status: 404 }) }) });
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[0].content, /لا تعرف هذا الحساب/);
  assert.match(f.replies[0].content, /هذا لا يعني/);
  assert.ok(f.logs.some(line => line.includes('PROFILE_NOT_FOUND')));
});
test('configured channel and guild restrictions explain why a command cannot run', async () => {
  for (const config of [{ guildId: '555555555555555555' }, { channelId: '666666666666666666' }]) {
    const f = fixture('-بوست', { config });
    await f.handlers.onMessage(f.message);
    assert.equal(f.calls.length, 0);
    assert.match(f.replies[0].content, /GUILD_ID|CHANNEL_ID/);
    assert.ok(f.logs.some(line => line.includes('COMMAND_SCOPE')));
  }
});
test('missing embed or attachment permission is reported before profile access', async () => {
  const f = fixture('-بوست', { missing: ['EmbedLinks', 'AttachFiles'] });
  await f.handlers.onMessage(f.message);
  assert.equal(f.calls.length, 0);
  assert.match(f.replies[0].content, /EmbedLinks/);
  assert.match(f.replies[0].content, /AttachFiles/);
  f.message.content = '-ping';
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[1].content, /Pong/);
});
test('missing message history uses direct send; failed replies also fall back to direct send', async () => {
  const noHistory = fixture('-ping', { missing: ['ReadMessageHistory'] });
  await noHistory.handlers.onMessage(noHistory.message);
  assert.equal(noHistory.replies.length, 0);
  assert.match(noHistory.sends[0].content, /Pong/);
  const failedReply = fixture('-ping');
  failedReply.message.reply = async () => { throw Object.assign(new Error('hidden'), { code: 50013 }); };
  await failedReply.handlers.onMessage(failedReply.message);
  assert.match(failedReply.sends[0].content, /Pong/);
  assert.ok(failedReply.logs.some(line => line.includes('50013')));
});
test('missing send permission and failed fallback are visible in logs', async () => {
  const f = fixture('-بوست', { missing: ['SendMessages'] });
  await f.handlers.onMessage(f.message);
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  assert.ok(f.logs.some(line => line.includes('MISSING_PERMISSIONS')));
  const fail = fixture('-ping');
  fail.message.reply = fail.message.channel.send = async () => { throw Object.assign(new Error('not logged'), { code: 50013 }); };
  await fail.handlers.onMessage(fail.message);
  assert.ok(fail.logs.some(line => line.includes('error-reply-failed') && line.includes('50013')));
  assert.equal(fail.logs.some(line => line.includes('not logged')), false);
});
test('threads check SendMessagesInThreads rather than ordinary channel send permission', async () => {
  const allowed = fixture('-ping', { thread: true, missing: ['SendMessages'] });
  await allowed.handlers.onMessage(allowed.message);
  assert.match(allowed.replies[0].content, /Pong/);
  const blocked = fixture('-ping', { thread: true, missing: ['SendMessagesInThreads'] });
  await blocked.handlers.onMessage(blocked.message);
  assert.equal(blocked.replies.length, 0);
  assert.ok(blocked.logs.some(line => line.includes('SendMessagesInThreads')));
});
test('empty message warning is bounded and bots and direct messages are ignored', async () => {
  const f = fixture('');
  await f.handlers.onMessage(f.message);
  await f.handlers.onMessage(f.message);
  assert.equal(f.logs.filter(line => line.includes('EMPTY_CONTENT')).length, 1);
  f.message.content = '-ping';
  f.message.author = { ...user, bot: true };
  await f.handlers.onMessage(f.message);
  f.message.author = user;
  f.message.inGuild = () => false;
  await f.handlers.onMessage(f.message);
  assert.equal(f.replies.length, 0);
});
test('inflight and cooldown requests get feedback; ping remains available', async () => {
  let finish, clock = 10000;
  const f = fixture('-بوست', { now: () => clock, reader: { get: () => new Promise(resolve => { finish = resolve; }) } });
  const first = f.handlers.onMessage(f.message);
  await new Promise(resolve => setImmediate(resolve));
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[0].content, /قيد المعالجة/);
  f.message.content = '-ping';
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[1].content, /Pong/);
  finish({ premium_guild_since: '2021-01-01' });
  await first;
  f.message.content = '-بوست';
  await f.handlers.onMessage(f.message);
  assert.match(f.replies.at(-1).content, /3 ثوان/);
  clock += 3001;
  f.handlers.cleanup();
});
test('slash commands acknowledge before reading, then deliver the personal result', async () => {
  const { interaction, sent } = interactionFixture('نيترو');
  const f = fixture('', { reader: { get: async id => {
    assert.equal(interaction.deferred, true);
    assert.equal(id, user.id);
    return { premium_since: '2020-01-01' };
  } } });
  await f.handlers.onInteraction(interaction);
  assert.equal(sent[0], 'DEFER');
  assert.equal(sent[1].content, 'CARD');
});
test('slash ping works without content or reader and slash reader errors edit the deferred response', async () => {
  const f = fixture('', { reader: new ProfileReader({ cacheFile: null, request: async () => new Response('{}', { status: 404 }) }) });
  const ping = interactionFixture('ping');
  await f.handlers.onInteraction(ping.interaction);
  assert.match(ping.sent[0].content, /Pong/);
  assert.equal(ping.interaction.deferred, false);
  const nitro = interactionFixture('نيترو');
  await f.handlers.onInteraction(nitro.interaction);
  assert.equal(nitro.sent[0], 'DEFER');
  assert.match(nitro.sent[1].content, /لا تعرف هذا الحساب/);
});
test('slash restrictions reply privately and do not fetch a profile', async () => {
  const f = fixture('', { config: { channelId: '555555555555555555' } });
  const { interaction, sent } = interactionFixture('بوست');
  await f.handlers.onInteraction(interaction);
  assert.equal(sent[0].flags, MessageFlags.Ephemeral);
  assert.match(sent[0].content, /CHANNEL_ID/);
  assert.equal(f.calls.length, 0);
});
test('slash registration upserts only its commands and logs failures without blocking text handlers', async () => {
  const f = fixture('-ping'), created = [];
  const client = { application: { commands: { create: async (command, id) => created.push([command.name, id]) } } };
  await registerGuildCommands(client, { id: guildId }, {}, f.logger);
  assert.deepEqual(created, slashCommands.map(command => [command.name, guildId]));
  await registerGuildCommands(client, { id: 'other' }, { guildId }, f.logger);
  assert.equal(created.length, slashCommands.length);
  client.application.commands.create = async () => { throw Object.assign(new Error('hidden'), { code: 50001 }); };
  await registerGuildCommands(client, { id: guildId }, {}, f.logger);
  assert.ok(f.logs.some(line => line.includes('SLASH_REGISTER_FAILED') && line.includes('50001')));
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[0].content, /Pong/);
});

test('duplicate delivery of a message or slash interaction produces one response', async () => {
  const f = fixture('-ping');
  f.message.id = '777777777777777777';
  await Promise.all([f.handlers.onMessage(f.message), f.handlers.onMessage(f.message)]);
  assert.equal(f.replies.length, 1);
  const ping = interactionFixture('ping');
  ping.interaction.id = '888888888888888888';
  await Promise.all([f.handlers.onInteraction(ping.interaction), f.handlers.onInteraction(ping.interaction)]);
  assert.equal(ping.sent.length, 1);
  f.message.id = '777777777777777778';
  await f.handlers.onMessage(f.message);
  assert.equal(f.replies.length, 2);
});

test('reply fallback and parallel handler instances reuse the same Discord deduplication nonce', async () => {
  const f = fixture('-ping'), other = fixture('-ping');
  f.message.id = other.message.id = '777777777777777777';
  const attempted = [];
  f.message.reply = async payload => { attempted.push(payload); throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' }); };
  await f.handlers.onMessage(f.message);
  await other.handlers.onMessage(other.message);
  for (const payload of [attempted[0], f.sends[0], other.replies[0]]) {
    assert.equal(payload.nonce, f.message.id);
    assert.equal(payload.enforceNonce, true);
  }
});
