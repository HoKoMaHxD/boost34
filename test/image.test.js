import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { tiers, addMonths, progress } from '../src/badges.js';
import { renderBadgeImage } from '../src/image.js';
import { makeCard } from '../src/card.js';

test('progress changes within a stage and resets at the next milestone', () => {
  const since = '2026-01-01T00:00:00Z';
  const a = progress('nitro', since, new Date('2026-04-02'));
  const b = progress('nitro', since, new Date('2026-05-02'));
  assert.equal(a.current, b.current);
  assert.ok(a.fraction < b.fraction);
  const next = progress('nitro', since, new Date('2026-07-01'));
  assert.equal(next.months, 6);
  assert.equal(next.fraction, 0);
});
test('each member date produces its own PNG, with bounded valid images', async () => {
  for (const kind of ['boost', 'nitro']) {
    const options = { kind, username: 'Member <&>', now: new Date('2026-10-12T00:00:00Z') };
    const a = await renderBadgeImage({ ...options, since: '2026-07-25' });
    const b = await renderBadgeImage({ ...options, since: '2025-07-25' });
    assert.equal(a.equals(b), false);
    const meta = await sharp(a).metadata();
    assert.equal(meta.width, 1800);
    assert.ok(meta.height > 0);
    assert.equal(meta.format, 'png');
  }
});
test('all nine boost stages use the exact supplied artwork at promotion boundaries', async () => {
  const since = new Date('2020-01-01T00:00:00Z');
  for (let i = 0; i < tiers.boost.length; i++) {
    const months = tiers.boost[i];
    const expected = await readFile(new URL(`../assets/boost/${months}-months.png`, import.meta.url));
    const actual = await renderBadgeImage({kind:'boost', since, now:addMonths(since, months)});
    assert.ok(actual.equals(expected), `stage ${months}`);
    if (i > 0) {
      const before = await renderBadgeImage({kind:'boost', since, now:new Date(+addMonths(since, months) - 1)});
      const previous = await readFile(new URL(`../assets/boost/${tiers.boost[i-1]}-months.png`, import.meta.url));
      assert.ok(before.equals(previous), `before ${months}`);
    }
  }
  const final = await renderBadgeImage({kind:'boost', since, now:addMonths(since, 80)});
  assert.ok(final.equals(await readFile(new URL('../assets/boost/24-months.png', import.meta.url))));
});
test('card attaches generated image belonging to the invoking member', async () => {
  const user = { id: '123456789012345678', username: 'Member', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
  const card = await makeCard(user, 'boost', new Date('2026-01-01'), new Date('2026-10-12'));
  assert.ok(Buffer.isBuffer(card.files[0].attachment));
  assert.equal(card.files[0].name, `boost-${user.id}.png`);
  assert.equal(card.embeds[0].toJSON().image.url, `attachment://boost-${user.id}.png`);
});

test('all eight Nitro images are selected at exact boundaries, including 60 and 72+', async () => {
  const since = new Date('2018-01-01T00:00:00Z');
  for (let i=0; i<tiers.nitro.length; i++) {
    const months = tiers.nitro[i];
    const expected = await readFile(new URL(`../assets/nitro/${months}-months.png`, import.meta.url));
    const actual = await renderBadgeImage({kind:'nitro',since,now:addMonths(since,months)});
    assert.ok(actual.equals(expected), `stage ${months}`);
    if(i>0) {
      const previous=await readFile(new URL(`../assets/nitro/${tiers.nitro[i-1]}-months.png`,import.meta.url));
      const before=await renderBadgeImage({kind:'nitro',since,now:new Date(+addMonths(since,months)-1)});
      assert.ok(before.equals(previous), `before ${months}`);
    }
  }
  const final=await renderBadgeImage({kind:'nitro',since,now:addMonths(since,100)});
  assert.ok(final.equals(await readFile(new URL('../assets/nitro/72-months.png',import.meta.url))));
});
test('new Nitro subscribers get the base emoji and Bronze only after a full month', async () => {
  const user = { id: '123456789012345678', username: 'NewMember', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
  const since = new Date('2026-01-31T12:00:00Z');
  const before = new Date('2026-02-28T11:59:59Z');
  const state = progress('nitro', since, before);
  assert.equal(state.current, -1);
  assert.equal(state.months, 0);
  assert.equal(state.upcoming[0].months, 1);
  const card = await makeCard(user, 'nitro', since, before);
  const fields = card.embeds[0].toJSON().fields;
  assert.equal(fields[0].value, '<:Nitro:1559005534169071647> **Nitro**');
  assert.ok(fields[1].value.startsWith('<:bronze:1559004459567419443>'));
  assert.ok(fields[2].value.split('\n')[0].includes('3 Months'));
  assert.equal(fields[2].value.includes(fields[1].value), false);
  assert.ok(card.files[0].attachment.equals(await readFile(new URL('../assets/nitro/0-months.png', import.meta.url))));
  const after = progress('nitro', since, new Date('2026-02-28T12:00:00Z'));
  assert.equal(after.current, 0);
  assert.equal(after.months, 1);
  assert.equal(after.upcoming[0].months, 3);
  assert.equal(after.fraction, 0);
});
