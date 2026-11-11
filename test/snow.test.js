import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { addMonths, progress, membershipDuration, symbols, snowNames, timestamp } from '../src/badges.js';
import { makeCard } from '../src/card.js';
import { renderBadgeImage } from '../src/image.js';
import { createCommandHandlers, parseCommand, slashCommands } from '../src/commands.js';

const user = {
  id: '222222222222222222', username: 'SnowMember',
  displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
};
const guildId = '333333333333333333', channelId = '444444444444444444';
const clock = Date.parse('2026-10-29T12:00:00Z');

function fixture(options = {}) {
  const sent = [], fetched = [], rendered = [], logs = [];
  const guild = { id: guildId, members: {
    me: { id: '111111111111111111' },
    fetch: async lookup => {
      fetched.push(lookup);
      return options.fetch ? options.fetch(lookup) : { joinedAt: new Date('2026-07-14T12:00:00Z') };
    },
  } };
  const permissions = new PermissionsBitField(PermissionsBitField.All);
  permissions.remove(PermissionFlagsBits.Administrator);
  for (const name of options.missing || []) permissions.remove(PermissionFlagsBits[name]);
  const message = {
    content: '!سنو', author: user, guildId, channelId, guild,
    client: { user: guild.members.me }, inGuild: () => true,
    channel: { permissionsFor: () => permissions, isThread: () => false,
      sendTyping: async () => {}, send: async payload => sent.push(payload) },
    reply: async payload => sent.push(payload),
  };
  let readerCalls = 0;
  const handlers = createCommandHandlers({
    reader: { get: async () => { readerCalls++; throw new Error('Snow must not use profile reader'); } },
    config: options.config, now: options.now || (() => clock),
    render: options.render || (async (...args) => { rendered.push(args); return { content: 'SNOW_CARD' }; }),
    logger: { info: line => logs.push(line), warn: line => logs.push(line) },
  });
  return { guild, message, sent, fetched, rendered, logs, handlers, readerCalls: () => readerCalls };
}

test('Snow accepts existing prefix/mention styles and registers /سنو', () => {
  for (const command of ['!سنو', '-سنو', '!SNOW', '\u200f!سنو\u200e', '-سُنَو', '<@111111111111111111> سنو']) {
    assert.equal(parseCommand(command, '111111111111111111'), 'snow', command);
  }
  assert.ok(slashCommands.some(command => command.name === 'سنو'));
});

test('Snow calendar transitions include end-of-month and leap-year joins', () => {
  for (const since of ['2024-12-31T12:30:00Z', '2023-12-31T12:30:00Z', '2024-02-29T12:30:00Z']) {
    const start = new Date(since);
    assert.equal(progress('snow', start, start).months, 0);
    for (const [index, months] of [2, 4, 6].entries()) {
      const boundary = addMonths(start, months);
      assert.equal(progress('snow', start, new Date(+boundary - 1)).months, [0, 2, 4][index]);
      const state = progress('snow', start, boundary);
      assert.equal(state.months, months);
      assert.equal(state.fraction, months === 6 ? 1 : 0);
      assert.deepEqual(state.upcoming.map(item => item.months), [2, 4, 6].filter(value => value > months));
    }
    assert.equal(progress('snow', start, addMonths(start, 100)).months, 6);
    assert.equal(progress('snow', start, addMonths(start, 100)).upcoming.length, 0);
  }
  assert.throws(() => progress('snow', 'bad-date', new Date(clock)));
  assert.throws(() => progress('snow', '2027-01-01', new Date(clock)));
});

test('membership duration uses full calendar months plus days and keeps counting after Legend', () => {
  assert.equal(membershipDuration('2024-01-31T12:00:00Z', new Date('2024-02-29T12:00:00Z')), '1 Month, 0 Days');
  assert.equal(membershipDuration('2024-01-31T12:00:00Z', new Date('2024-02-29T11:59:59Z')), '0 Months, 28 Days');
  assert.equal(membershipDuration('2025-01-31T12:00:00Z', new Date('2025-03-01T12:00:00Z')), '1 Month, 1 Day');
  assert.equal(membershipDuration('2025-01-29T12:00:00Z', new Date(clock)), '21 Months, 0 Days');
  assert.equal(membershipDuration(new Date(clock), new Date(clock)), '0 Months, 0 Days');
  assert.throws(() => membershipDuration(null, new Date(clock)));
  assert.throws(() => membershipDuration('2027-01-01', new Date(clock)));
});

test('all four Snow PNGs remain exact originals and change only at the milestone', async () => {
  const since = new Date('2024-12-31T12:30:00Z');
  for (const [index, months] of [0, 2, 4, 6].entries()) {
    const expected = await readFile(new URL(`../assets/snow/${months}-months.png`, import.meta.url));
    const actual = await renderBadgeImage({ kind: 'snow', since, now: addMonths(since, months) });
    assert.ok(actual.equals(expected));
    const meta = await sharp(actual).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 2048);
    assert.equal(meta.height, 682);
    assert.equal(meta.hasAlpha, true);
    if (index) {
      const before = await renderBadgeImage({ kind: 'snow', since, now: new Date(+addMonths(since, months) - 1) });
      const previous = await readFile(new URL(`../assets/snow/${[0, 2, 4][index - 1]}-months.png`, import.meta.url));
      assert.ok(before.equals(previous));
    }
  }
});

test('Snow cards show supplied emoji IDs, member tenure and only upcoming stages', async () => {
  assert.deepEqual(symbols.snow, [
    '<:snow:1565460718352863422>', '<:SnowBeast:1565460709809201322>',
    '<:SnowSpecial:1565460715631026306>', '<:SnowLegend:1565460712254349392>',
  ]);
  const since = new Date('2025-01-29T12:00:00Z');
  for (const [index, months] of [0, 2, 4, 6].entries()) {
    const card = await makeCard(user, 'snow', since, addMonths(since, months));
    const embed = card.embeds[0].toJSON();
    assert.equal(embed.fields[0].value, `${symbols.snow[index]} **${snowNames[index]}**`);
    assert.match(embed.description, new RegExp(`${months} Months, 0 Days`));
    assert.ok(embed.description.includes(timestamp(since, 'D')));
    assert.equal(embed.image.url, `attachment://snow-${user.id}.png`);
    assert.equal(card.files[0].name, `snow-${user.id}.png`);
    assert.deepEqual(card.allowedMentions, { parse: [], repliedUser: false });
    if (index < 3) {
      assert.ok(embed.fields[1].value.includes(snowNames[index + 1]));
      assert.ok(embed.fields[1].value.includes(timestamp(addMonths(since, [2, 4, 6][index]))));
      if (index < 2) assert.equal(embed.fields[2].value.split('\n').length, 2 - index);
      else assert.equal(embed.fields.length, 2);
    } else {
      assert.equal(embed.fields[1].value, 'Max Level!');
      assert.equal(embed.fields.length, 2);
    }
  }
  const max = await makeCard(user, 'snow', since, new Date(clock));
  assert.match(max.embeds[0].toJSON().description, /21 Months, 0 Days/);
});

test('!سنو fetches only the requester in this guild and never reads Nitro/Boost data', async () => {
  const f = fixture();
  await f.handlers.onMessage(f.message);
  assert.deepEqual(f.fetched, [{ user: user.id, force: true }]);
  assert.equal(f.readerCalls(), 0);
  assert.equal(f.rendered[0][0], user);
  assert.equal(f.rendered[0][1], 'snow');
  assert.equal(f.rendered[0][2].toISOString(), '2026-07-14T12:00:00.000Z');
  assert.equal(+f.rendered[0][3], clock);
  assert.equal(f.sent[0].content, 'SNOW_CARD');
});

test('a second member and a rejoined member each use their own latest guild join date', async () => {
  let time = clock, joinedAt = new Date('2025-01-01T00:00:00Z');
  const f = fixture({ now: () => time, fetch: async () => ({ joinedAt }) });
  await f.handlers.onMessage(f.message);
  joinedAt = new Date('2026-10-28T00:00:00Z');
  f.message.author = { ...user, id: '555555555555555555' };
  await f.handlers.onMessage(f.message);
  f.message.author = user;
  time += 3001;
  await f.handlers.onMessage(f.message);
  assert.equal(f.rendered.length, 3);
  assert.equal(+f.rendered[0][2], Date.parse('2025-01-01'));
  assert.equal(f.rendered[1][0].id, '555555555555555555');
  assert.equal(+f.rendered[1][2], +joinedAt);
  assert.equal(+f.rendered[2][2], +joinedAt);
  assert.equal(f.readerCalls(), 0);
});

test('Snow obeys existing guild/channel scope and image permissions before member lookup', async () => {
  for (const options of [
    { config: { guildId: '555555555555555555' } },
    { config: { channelId: '555555555555555555' } },
    { missing: ['EmbedLinks'] }, { missing: ['AttachFiles'] },
  ]) {
    const f = fixture(options);
    await f.handlers.onMessage(f.message);
    assert.equal(f.fetched.length, 0);
    assert.match(f.sent[0].content, /GUILD_ID|CHANNEL_ID|EmbedLinks|AttachFiles/);
  }
});

test('Snow reports missing, invalid and future join dates without guessing another timestamp', async () => {
  for (const joinedAt of [null, undefined, new Date('invalid'), new Date(clock + 60000)]) {
    const f = fixture({ fetch: async () => ({ joinedAt, premiumSince: new Date('2020-01-01') }) });
    await f.handlers.onMessage(f.message);
    assert.match(f.sent[0].content, /تاريخ دخول الشخص المطلوب للسيرفر غير متاح/);
    assert.equal(f.rendered.length, 0);
    assert.equal(f.readerCalls(), 0);
  }
});

test('Snow member lookup errors produce clear replies and log codes without full errors', async () => {
  for (const code of [10007, 50013]) {
    const f = fixture({ fetch: async () => { throw Object.assign(new Error('hidden details'), { code }); } });
    await f.handlers.onMessage(f.message);
    assert.match(f.sent[0].content, code === 10007 ? /الشخص المطلوب غير موجود/ : /تعذرت قراءة عضوية/);
    assert.ok(f.logs.some(line => line.includes(String(code))));
    assert.equal(f.logs.some(line => line.includes('hidden details')), false);
  }
});

test('/سنو defers before member lookup and edits the deferred reply on success or failure', async () => {
  for (const fail of [false, true]) {
    const events = [];
    const interaction = {
      commandName: 'سنو', user, guildId, channelId, deferred: false, replied: false,
      isChatInputCommand: () => true, inGuild: () => true,
      deferReply: async () => { interaction.deferred = true; events.push('DEFER'); },
      reply: async payload => events.push(payload),
      editReply: async payload => events.push(payload),
    };
    const f = fixture({ fetch: async () => {
      assert.equal(interaction.deferred, true);
      if (fail) throw Object.assign(new Error('hidden'), { code: 50013 });
      return { joinedAt: new Date('2026-07-14T12:00:00Z') };
    } });
    interaction.guild = f.guild;
    await f.handlers.onInteraction(interaction);
    assert.equal(events[0], 'DEFER');
    assert.match(events[1].content, fail ? /تعذرت قراءة عضوية/ : /SNOW_CARD/);
    assert.equal(f.readerCalls(), 0);
  }
});

test('Snow throttles repeat requests and full handler delivers the real image card', async () => {
  const f = fixture({ render: makeCard });
  await f.handlers.onMessage(f.message);
  assert.equal(f.sent[0].embeds[0].toJSON().fields[0].value, `${symbols.snow[1]} **Snow Beast**`);
  const expected = await readFile(new URL('../assets/snow/2-months.png', import.meta.url));
  assert.ok(f.sent[0].files[0].attachment.equals(expected));
  await f.handlers.onMessage(f.message);
  assert.match(f.sent[1].content, /3 ثوان/);
  assert.equal(f.fetched.length, 1);
});
