import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, progress, remaining } from '../src/badges.js';
import { getStart } from '../src/profile.js';

test('calendar month boundaries and leap years do not overflow', () => {
  assert.equal(addMonths(new Date('2024-01-31T12:34:56Z'), 1).toISOString(), '2024-02-29T12:34:56.000Z');
  assert.equal(addMonths(new Date('2024-02-29T12:34:56Z'), 12).toISOString(), '2025-02-28T12:34:56.000Z');
});
test('exact transition and last badge', () => {
  assert.equal(progress('boost', '2026-01-12T00:00:00Z', new Date('2026-03-11T23:59:59Z')).months, 1);
  assert.equal(progress('boost', '2026-01-12T00:00:00Z', new Date('2026-03-12T00:00:00Z')).months, 2);
  assert.equal(progress('boost', '2020-01-01', new Date('2026-01-01')).upcoming.length, 0);
  assert.equal(progress('nitro', '2020-01-01', new Date('2026-01-01')).months, 72);
});
test('different members produce different personal timelines', () => {
  const now = new Date('2026-10-12T00:00:00Z');
  assert.equal(progress('nitro', '2026-01-12', now).months, 6);
  assert.equal(progress('nitro', '2024-01-12', now).months, 24);
  assert.throws(() => progress('nitro', 'bad-date', now));
  assert.throws(() => progress('nitro', '2027-01-01', now));
});
test('account boost streak is separate from Nitro subscription', () => {
  const p = { premium_since: '2022-01-01T00:00:00Z', premium_guild_since: '2024-06-01T00:00:00Z' };
  assert.equal(getStart(p, 'boost').getUTCFullYear(), 2024);
  assert.equal(getStart(p, 'nitro').getUTCFullYear(), 2022);
  assert.throws(() => getStart({}, 'nitro'), { code: 'MISSING_DATE' });
  assert.throws(() => getStart({ premium_since: null }, 'nitro'), { code: 'NO_DATE' });
});
test('minutes round up and never produce a negative countdown', () => {
  const now = new Date('2026-01-01');
  assert.equal(remaining(new Date(+now + 86460001), now), '1 يوم، 0 ساعة، 2 دقيقة');
  assert.equal(remaining(now, now), '0 يوم، 0 ساعة، 0 دقيقة');
});
