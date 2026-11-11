// Milestones match the supplied artwork. These are estimates from the profile
// start date; Discord remains authoritative about actual badge assignment.
export const tiers = {
  nitro: [1, 3, 6, 12, 24, 36, 60, 72],
  boost: [1, 2, 3, 6, 9, 12, 15, 18, 24],
  snow: [0, 2, 4, 6],
};
export const symbols = {
  snow: [
    '<:snow:1565460718352863422>',
    '<:SnowBeast:1565460709809201322>',
    '<:SnowSpecial:1565460715631026306>',
    '<:SnowLegend:1565460712254349392>',
  ],
  nitro: [
    '<:bronze:1559004459567419443>',
    '<:Silver:1559004457919057960>',
    '<:Gold:1559004446871003186>',
    '<:Platinum:1559004445457514587>',
    '<:Diamond:1559004443578601492>',
    '<:Emerald:1559004441095569478>',
    '<:Ruby:1559004439585620060>',
    '<:Opal:1559004438016950372>',
  ],
  boost: [
    '<:discordboost1:1559004253433897000>',
    '<:discordboost2:1559004251387203695>',
    '<:discordboost3:1559004249948684348>',
    '<:discordboost4:1559004248015110249>',
    '<:discordboost5:1559004246005911593>',
    '<:discordboost6:1559004244642889809>',
    '<:discordboost7:1559004243325755493>',
    '<:discordboost8:1559004241689837608>',
    '<:discordboost9:1559004240112910386>',
  ],
};
export const initialNitroSymbol = '<:Nitro:1559005534169071647>';
export const snowNames = ['Snow', 'Snow Beast', 'Snow Special', 'Snow Legend'];
export function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}
export function progress(kind, since, now = new Date()) {
  if (!tiers[kind]) throw new Error('INVALID_KIND');
  const start = new Date(since);
  if (!since || !Number.isFinite(+start) || +start > +now) throw new Error('INVALID_DATE');
  // Nitro starts with a base badge; Bronze is earned at one full month.
  // Boost starts with its first emblem immediately, then changes at two months.
  let current = kind === 'nitro' ? -1 : 0;
  for (let i = kind === 'nitro' ? 0 : 1; i < tiers[kind].length; i++) {
    if (+addMonths(start, tiers[kind][i]) <= +now) current = i;
  }
  const upcoming = tiers[kind].slice(current + 1).map((months, i) => ({
    months, index: current + 1 + i, date: addMonths(start, months),
  }));
  const stageStart = current < 0 || (kind === 'boost' && current === 0) ? start : addMonths(start, tiers[kind][current]);
  const fraction = upcoming.length ? Math.max(0, Math.min(1, (+now - +stageStart) / (+upcoming[0].date - +stageStart))) : 1;
  return { start, current, months: current < 0 ? 0 : tiers[kind][current], upcoming, fraction };
}
export function label(months) {
  if (months === 12) return '1 Year';
  if (months > 12 && months % 12 === 0) return `${months / 12} Years`;
  return `${months} ${months === 1 ? 'Month' : 'Months'}`;
}
// Completed calendar months, followed by full days since that anniversary.
export function membershipDuration(since, now = new Date()) {
  const start = new Date(since);
  if (!since || !Number.isFinite(+start) || !Number.isFinite(+now) || +start > +now) throw new Error('INVALID_DATE');
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  if (+addMonths(start, months) > +now) months--;
  const days = Math.floor((+now - +addMonths(start, months)) / 86400000);
  return `${months} ${months === 1 ? 'Month' : 'Months'}, ${days} ${days === 1 ? 'Day' : 'Days'}`;
}
export function remaining(date, now = new Date()) {
  const minutes = Math.max(0, Math.ceil((+date - +now) / 60000));
  return `${Math.floor(minutes / 1440)} يوم، ${Math.floor(minutes % 1440 / 60)} ساعة، ${minutes % 60} دقيقة`;
}
export const timestamp = (date, style = 'R') => `<t:${Math.floor(+date / 1000)}:${style}>`;
