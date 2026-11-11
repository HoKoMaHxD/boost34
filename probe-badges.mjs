// One-shot diagnostic, not a replacement badge reader.
// Node.js >= 22.12. Uses BOT_TOKEN only; never a personal Discord token.
// Run in the project terminal:
// node --env-file-if-exists=.env probe-badges.mjs 141947703742562304
// The /badges routes below are client-observed, NOT documented for bot access.
// A 200 is useful evidence, not a guarantee of future availability.

import { pathToFileURL } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const selectedIds = new Set(['1', '12']);
const fields = ['id', 'name', 'type', 'tier', 'label', 'description', 'premium_since',
  'premium_guild_since', 'starts_at', 'start_date', 'started_at', 'since'];

function summarize(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 2).map(item => summarize(item, depth + 1));
  const result = {};
  for (const key of fields) {
    if (Object.hasOwn(value, key) && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))) {
      result[key] = typeof value[key] === 'string' ? value[key].slice(0, 200) : value[key];
    }
  }
  for (const key of ['badge', 'current_tier', 'metadata', 'progress']) {
    if (value[key] && typeof value[key] === 'object') result[key] = summarize(value[key], depth + 1);
  }
  return result;
}

function selectedBadges(data) {
  const badges = Array.isArray(data) ? data : data?.badges || data?.data?.badges || [];
  if (!Array.isArray(badges)) return [];
  return badges.filter(badge => badge && typeof badge === 'object' && (
    selectedIds.has(String(badge.id ?? badge.badge?.id)) ||
    /nitro|boost|premium_tenure/i.test(String(badge.name || badge.type || badge.id || ''))
  )).slice(0, 4).map(badge => summarize(badge));
}

export async function runProbe({ token, targetId = '141947703742562304', request = fetch, wait = pause }) {
  if (typeof token !== 'string' || !token.trim()) return { outcome: 'MISSING_BOT_TOKEN', requests: [] };
  if (typeof targetId !== 'string' || !/^\d{17,20}$/.test(targetId)) return { outcome: 'INVALID_USER_ID', requests: [] };
  token = token.trim();
  const report = { targetId, outcome: 'INCONCLUSIVE', requests: [] };
  let lastResponse;

  async function read(path, label, version = 'v9') {
    if (report.requests.length) await wait(1000);
    const entry = { route: label };
    report.requests.push(entry);
    try {
      const response = await request('https://discord.com/api/' + version + path, {
        headers: { Authorization: 'Bot ' + token, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      entry.http = response.status;
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (typeof data?.code === 'number') entry.discordCode = data.code;
        if (response.status === 429) entry.result = 'RATE_LIMITED_STOPPED';
        return { ok: false, status: response.status };
      }
      entry.shape = Array.isArray(data) ? 'array' : data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : typeof data;
      return { ok: true, status: response.status, data, entry };
    } catch {
      entry.result = 'NETWORK_OR_TIMEOUT';
      return { ok: false, status: 0 };
    }
  }

  // Verify that the provided credential belongs to a bot before testing anything.
  const identity = await read('/users/@me', 'BOT_IDENTITY', 'v10');
  if (!identity.ok || identity.data?.bot !== true) {
    report.outcome = 'BOT_AUTH_CHECK_FAILED';
    return report;
  }
  report.botId = identity.data.id;

  const list = await read('/users/' + targetId + '/badges', 'USER_BADGES');
  if (!list.ok) {
    report.outcome = list.status === 401 || list.status === 403 ? 'BADGES_REJECTED_BOT_AUTH' : 'BADGES_ROUTE_UNAVAILABLE';
    return report; // No retries, alternate credentials, or requests around a denial.
  }
  list.entry.selectedBadges = selectedBadges(list.data);

  // Detail requests happen only after the list route accepted this bot's access.
  for (const [id, name] of [['1', 'NITRO_DETAIL'], ['12', 'BOOST_DETAIL']]) {
    lastResponse = await read('/users/' + targetId + '/badges/' + id, name);
    if (lastResponse.ok) lastResponse.entry.badge = summarize(lastResponse.data);
    if ([0, 401, 403, 429].includes(lastResponse.status)) {
      report.outcome = 'DETAIL_LOOKUP_STOPPED';
      return report;
    }
  }
  report.outcome = 'CHECK_BADGE_FIELDS_NOT_A_CONFIRMED_SOLUTION';
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProbe({ token: process.env.BOT_TOKEN, targetId: process.argv[2] || '141947703742562304' });
  // Print only allowlisted badge data and response codes. Never print credentials,
  // request objects, full account profiles, error stacks, or raw response bodies.
  console.log(JSON.stringify(report, null, 2));
  console.log('هذا فحص تجريبي فقط. HTTP 200 وحده لا يثبت توفر تواريخ الشارات أو دقتها.');
  if (report.outcome === 'MISSING_BOT_TOKEN') console.log('شغّل الملف في بيئة البوت التي تحتوي BOT_TOKEN.');
}
