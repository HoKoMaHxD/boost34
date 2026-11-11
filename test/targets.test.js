import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, PermissionsBitField } from 'discord.js';
import { createCommandHandlers, parseRequest, slashCommands } from '../src/commands.js';
import { makeCard } from '../src/card.js';
import { readFile } from 'node:fs/promises';

const botId = '111111111111111111', guildId = '333333333333333333', channelId = '444444444444444444';
const requester = { id: '222222222222222222', username: 'Requester', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
const subject = { id: '555555555555555555', username: 'Target', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png' };
const clock = Date.parse('2026-10-29T12:00:00Z');
const commands = [['نيترو', 'nitro'], ['بوست', 'boost'], ['سنو', 'snow']];

function fixture(content, options = {}) {
  const replies = [], fetchedUsers = [], fetchedMembers = [], profiles = [], rendered = [], logs = [];
  const client = { user: { id: botId }, users: { fetch: async id => {
    fetchedUsers.push(id);
    if (options.userError) throw Object.assign(new Error('hidden'), { code: options.userError });
    return { ...subject, id };
  } } };
  const guild = { id: guildId, members: { me: client.user, fetch: async ({ user: id, force }) => {
    assert.equal(force, true);
    fetchedMembers.push(id);
    if (options.memberError) throw Object.assign(new Error('hidden'), { code: options.memberError });
    const user = id === requester.id ? requester : { ...subject, id };
    return { user, joinedAt: new Date(id === requester.id ? '2026-10-01T12:00:00Z' : '2026-05-01T12:00:00Z') };
  } } };
  const message = { content, author: requester, guildId, channelId, client, guild, inGuild: () => true,
    channel: { permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), isThread: () => false,
      sendTyping: async () => {}, send: async payload => replies.push(payload) },
    reply: async payload => replies.push(payload),
  };
  const reader = { get: async id => {
    profiles.push(id);
    if (options.profile) return options.profile(id);
    return { premium_since: id === requester.id ? '2024-01-01' : '2025-01-01', premium_guild_since: id === requester.id ? '2023-01-01' : '2026-01-01' };
  } };
  const handlers = createCommandHandlers({ reader, config: options.config, now: () => clock,
    render: options.render || (async (...args) => { rendered.push(args); return { content: 'CARD' }; }),
    logger: { info: value => logs.push(value), warn: value => logs.push(value) } });
  return { handlers, message, replies, fetchedUsers, fetchedMembers, profiles, rendered, logs, client, guild };
}

test('all three bare commands use the requester without fetching another user', async () => {
  for (const [command, kind] of commands) {
    const f = fixture(`-${command}`);
    await f.handlers.onMessage(f.message);
    assert.equal(f.rendered[0][0].id, requester.id);
    assert.equal(f.rendered[0][1], kind);
    assert.equal(f.rendered[0][4], requester);
    assert.deepEqual(f.fetchedUsers, []);
    assert.deepEqual(kind === 'snow' ? f.fetchedMembers : f.profiles, [requester.id]);
  }
});

test('all three commands accept exact IDs, user mentions and nickname mentions as targets', async () => {
  for (const [command, kind] of commands) for (const target of [subject.id, `<@${subject.id}>`, `<@!${subject.id}>`]) {
    const f = fixture(`-${command} ${target}`);
    await f.handlers.onMessage(f.message);
    assert.equal(f.replies[0].content, 'CARD');
    assert.equal(f.rendered[0][0].id, subject.id);
    assert.equal(f.rendered[0][0].username, subject.username);
    assert.equal(f.rendered[0][1], kind);
    assert.equal(f.rendered[0][4], requester);
    assert.equal(f.rendered[0][2].toISOString(), kind === 'snow' ? '2026-05-01T12:00:00.000Z' : kind === 'nitro' ? '2025-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z');
    if (kind === 'snow') {
      assert.deepEqual(f.fetchedMembers, [subject.id]);
      assert.deepEqual(f.fetchedUsers, []);
      assert.deepEqual(f.profiles, []);
    } else {
      assert.deepEqual(f.fetchedUsers, [subject.id]);
      assert.deepEqual(f.profiles, [subject.id]);
    }
  }
});

test('bot invocation mention and target mention are distinct and preserve full ID precision', () => {
  const id = '12345678901234567890';
  for (const command of [`<@${botId}> بوست <@${id}>`, `<@!${botId}> -بوست ${id}`, `!BOOST ${id}`, `\u200f-بوست <@!${id}>\u200e`]) {
    assert.deepEqual(parseRequest(command, botId), { kind: 'boost', targetId: id, invalidTarget: false });
  }
  assert.equal(parseRequest(`-سنو <@${botId}>`, botId).targetId, botId);
  assert.equal(parseRequest(`<@${botId}> سنو <@${botId}>`, botId).targetId, botId);
});

test('bad IDs, role/channel mentions, multiple people and extra text never fall back to self', async () => {
  for (const target of ['123', 'unknown', '<@123>', `<@&${subject.id}>`, `<#${subject.id}>`, `${subject.id} ${requester.id}`, `<@${subject.id}> extra`, '55555555555555555x']) {
    const f = fixture(`-بوست ${target}`);
    await f.handlers.onMessage(f.message);
    assert.match(f.replies[0].content, /آيدي مستخدم صحيحًا/);
    assert.deepEqual(f.fetchedUsers, []);
    assert.deepEqual(f.profiles, []);
    assert.deepEqual(f.rendered, []);
  }
});

test('a missing target account or guild member gets an error and never renders requester data', async () => {
  for (const [command, options, expected] of [
    ['بوست', { userError: 10013 }, /تعذر العثور على الشخص/],
    ['نيترو', { userError: 50001 }, /تعذرت قراءة حساب الشخص/],
    ['سنو', { memberError: 10007 }, /الشخص المطلوب غير موجود/],
  ]) {
    const f = fixture(`-${command} ${subject.id}`, options);
    await f.handlers.onMessage(f.message);
    assert.match(f.replies[0].content, expected);
    assert.deepEqual(f.rendered, []);
    assert.deepEqual(f.profiles, []);
    assert.equal(f.logs.some(line => line.includes('hidden')), false);
  }
});

test('changing target does not bypass requester cooldown or inflight lock', async () => {
  let finish;
  const f = fixture(`-بوست ${subject.id}`, { profile: () => new Promise(resolve => { finish = resolve; }) });
  const first = f.handlers.onMessage(f.message);
  await new Promise(resolve => setImmediate(resolve));
  f.message.content = `-بوست ${botId}`;
  await f.handlers.onMessage(f.message);
  assert.match(f.replies[0].content, /قيد المعالجة/);
  finish({ premium_guild_since: '2026-01-01' });
  await first;
  await f.handlers.onMessage(f.message);
  assert.match(f.replies.at(-1).content, /3 ثوان/);
  assert.deepEqual(f.fetchedUsers, [subject.id]);
});

test('different requesters can look up the same target independently and scope checks run first', async () => {
  const f = fixture(`-بوست ${subject.id}`);
  await f.handlers.onMessage(f.message);
  f.message.author = { ...requester, id: '666666666666666666' };
  await f.handlers.onMessage(f.message);
  assert.equal(f.rendered.length, 2);
  for (const config of [{ guildId: 'other' }, { channelId: 'other' }]) {
    const restricted = fixture(`-بوست ${subject.id}`, { config });
    await restricted.handlers.onMessage(restricted.message);
    assert.deepEqual(restricted.fetchedUsers, []);
    assert.deepEqual(restricted.profiles, []);
  }
});

test('slash user option targets the selected member or defaults to the requester', async () => {
  for (const [command, kind] of commands) for (const target of [null, subject]) {
    const f = fixture('');
    const sent = [];
    const interaction = { commandName: command, user: requester, client: f.client, guild: f.guild, guildId, channelId,
      deferred: false, replied: false, inGuild: () => true, isChatInputCommand: () => true,
      options: { getUser: name => { assert.equal(name, 'user'); return target; } },
      deferReply: async () => { interaction.deferred = true; sent.push('DEFER'); },
      editReply: async payload => sent.push(payload), reply: async payload => sent.push(payload),
    };
    await f.handlers.onInteraction(interaction);
    assert.equal(sent[0], 'DEFER');
    assert.equal(sent[1].content, 'CARD');
    assert.equal(f.rendered[0][0].id, target?.id || requester.id);
    assert.equal(f.rendered[0][1], kind);
    assert.equal(f.rendered[0][4], requester);
    assert.deepEqual(f.fetchedUsers, []);
  }
  for (const command of slashCommands.filter(item => ['نيترو', 'بوست', 'سنو'].includes(item.name))) {
    assert.equal(command.options[0].type, ApplicationCommandOptionType.User);
    assert.equal(command.options[0].required, false);
  }
});

test('rendered card uses the target name/avatar/artwork and credits the actual requester', async () => {
  for (const [command, kind] of commands) {
    const f = fixture(`-${command} <@${subject.id}>`, { render: makeCard });
    await f.handlers.onMessage(f.message);
    const payload = f.replies[0], embed = payload.embeds[0].toJSON();
    assert.equal(embed.author.name, subject.username);
    assert.equal(embed.thumbnail.url, subject.displayAvatarURL());
    assert.ok(embed.description.startsWith(`Requested by <@${requester.id}>`));
    assert.equal(payload.files[0].name, `${kind}-${subject.id}.png`);
    assert.equal(embed.image.url, `attachment://${kind}-${subject.id}.png`);
    const months = kind === 'snow' ? 4 : kind === 'nitro' ? 12 : 9;
    assert.ok(payload.files[0].attachment.equals(await readFile(new URL(`../assets/${kind}/${months}-months.png`, import.meta.url))));
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  }
});
