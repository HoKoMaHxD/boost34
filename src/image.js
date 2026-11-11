import { readFile } from 'node:fs/promises';
import { progress } from './badges.js';

// Stage artwork uses the account subscription date or the Snow guild join date.
// Members at the same milestone share artwork, with personal times in Embed.
export async function renderBadgeImage({ kind, since, now = new Date() }) {
  const state = progress(kind, since, now);
  return readFile(new URL(`../assets/${kind}/${state.months}-months.png`, import.meta.url));
}
