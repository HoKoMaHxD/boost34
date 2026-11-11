import { Client, Events, GatewayIntentBits } from 'discord.js';
import { readProfileConfig } from './python-reader.js';
import { loadReaderTokens, RotatingProfileReader } from './reader-token.js';
import { readConfig } from './config.js';
import { createCommandHandlers, registerGuildCommands, errorCode } from './commands.js';

let config, profileConfig;
try {
  config = readConfig(); profileConfig = readProfileConfig();
  if (profileConfig.source === 'discord.py-self') profileConfig.readerTokens = await loadReaderTokens();
}
catch (error) { console.error(error.message); process.exit(1); }
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.messageContent) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
const reader = new RotatingProfileReader(profileConfig, { tokens: profileConfig.readerTokens, botToken: config.token });
const handlers = createCommandHandlers({ reader, config });

client.once(Events.ClientReady, async bot => {
  console.log(`جاهز: ${bot.user.tag} | v2.2.0 | -فحص | !سنو | -نيترو | -بوست | -ping | /سنو | /ping | /تحديث التوكن | /حالة`);
  console.log(`GUILD_ID=${config.guildId || 'ALL'} | CHANNEL_ID=${config.channelId || 'ALL'} | MessageContent=${config.messageContent}`);
  console.log(`مصدر النيترو والبوست: ${profileConfig.source} | حفظ التواريخ على القرص 24 ساعة.`);
  if (profileConfig.source === 'discord.py-self') {
    if (!profileConfig.readerTokens.some(Boolean)) console.warn('[READER_NOT_CONFIGURED] أضف READER_TOKEN_1 إلى READER_TOKEN_5 أو استخدم /تحديث التوكن من الحساب المسموح. أوامر سنو وping تعمل بدونه.');
    console.warn('قارئ حساب شخصي: تغيير المكتبة لا يضمن منع قفل الحساب. يبدأ عند أول طلب غير محفوظ ويتوقف عند رفض الاعتماد أو طلب التحقق.');
  }
  if (!config.messageContent) console.warn('الأوامر النصية العادية تحتاج Message Content Intent. استخدم /سنو أو /ping أو منشن البوت ثم سنو أو بوست أو نيترو.');
  if (config.guildId && !bot.guilds.cache.has(config.guildId)) console.warn('[GUILD_NOT_FOUND] البوت غير موجود في GUILD_ID المحدد. صحح المتغير أو احذفه وأعد التشغيل.');
  if (config.channelId) {
    try {
      const channel = await bot.channels.fetch(config.channelId);
      if (!channel?.isTextBased() || !channel.guildId || (config.guildId && channel.guildId !== config.guildId)) {
        console.warn('[CHANNEL_NOT_FOUND] CHANNEL_ID ليس رومًا نصيًا متاحًا في السيرفر المطلوب.');
      }
    } catch (error) { console.warn(`[CHANNEL_NOT_FOUND] code=${errorCode(error)}: راجع CHANNEL_ID وصلاحية View Channels.`); }
  }
  for (const guild of bot.guilds.cache.values()) await registerGuildCommands(bot, guild, config);
});
client.on(Events.GuildCreate, guild => registerGuildCommands(client, guild, config));
client.on(Events.MessageCreate, message => {
  handlers.onMessage(message).catch(error => console.error(`[MESSAGE_HANDLER] ${errorCode(error)}`));
});
client.on(Events.InteractionCreate, interaction => {
  handlers.onInteraction(interaction).catch(error => console.error(`[INTERACTION_HANDLER] ${errorCode(error)}`));
});
setInterval(handlers.cleanup, 60000).unref();
client.on(Events.Error, error => console.error(`[DISCORD_ERROR] ${errorCode(error)}`));
client.on(Events.ShardDisconnect, event => {
  console.warn(`[DISCORD_DISCONNECT] code=${event.code}`);
  if (event.code === 4014) console.error('فعّل Message Content Intent في Developer Portal > Bot وأعد التشغيل. أو اضبط MESSAGE_CONTENT_INTENT=false واستخدم أوامر / أو منشن البوت.');
});
let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  client.destroy();
  await reader.close?.();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(0); });
client.login(config.token).catch(error => {
  console.error(`[LOGIN_FAILED] ${errorCode(error)}: تحقق من BOT_TOKEN وMessage Content Intent. للتشغيل بدون Intent اضبط MESSAGE_CONTENT_INTENT=false واستخدم أوامر / أو منشن البوت.`);
  void shutdown(1);
});
