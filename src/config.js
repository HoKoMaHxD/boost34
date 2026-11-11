export function readConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  if (!token) throw new Error('أضف BOT_TOKEN في متغيرات البيئة.');
  const config = { token };
  for (const [key, name] of [['GUILD_ID', 'guildId'], ['CHANNEL_ID', 'channelId']]) {
    const value = env[key]?.trim() || '';
    if (value && !/^\d{17,20}$/.test(value)) {
      throw new Error(`${key}: انسخ الآيدي الرقمي فقط، أو احذف المتغير لإلغاء التقييد.`);
    }
    config[name] = value;
  }
  const intent = (env.MESSAGE_CONTENT_INTENT || 'true').trim().toLowerCase();
  if (!['true', 'false'].includes(intent)) throw new Error('MESSAGE_CONTENT_INTENT يجب أن يكون true أو false.');
  config.messageContent = intent === 'true';
  return config;
}
