import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { renderBadgeImage } from './image.js';
import { progress, symbols, initialNitroSymbol, snowNames, membershipDuration, label, timestamp } from './badges.js';
export async function makeCard(user, kind, since, now = new Date(), requester = user, profile) {
  const state = progress(kind, since, now);
  const next = state.upcoming[0];
  const currentSymbol = state.current < 0 ? initialNitroSymbol : symbols[kind][state.current];
  const currentLabel = kind === 'snow' ? snowNames[state.current] : state.current < 0 ? 'Nitro' : kind === 'boost' && state.current === 0 ? 'Started Boosting' : label(state.months);
  const name = `${kind}-${user.id}.png`;
  const buffer = await renderBadgeImage({ kind, since, now, username: user.username });
  const freshness = kind === 'snow' ? '' : `\n${Number.isFinite(profile?.fetchedAt) ? `Data fetched: ${timestamp(new Date(profile.fetchedAt))}\n` : ''}Subscription data may be delayed.`;
  const embed = new EmbedBuilder()
    .setColor(0x6500a8)
    .setAuthor({ name: user.username })
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(`Requested by <@${requester.id}>${kind === 'snow' ? `\nJoined Server: ${timestamp(state.start, 'D')}\nTime in Server: **${membershipDuration(state.start, now)}**` : freshness}`)
    .addFields(
      { name: 'Current Badge', value: `${currentSymbol} **${currentLabel}**`, inline: true },
      { name: 'Next Badge', value: next ? `${symbols[kind][next.index]} ${kind === 'snow' ? `**${snowNames[next.index]}** ` : ''}${timestamp(next.date)}` : 'Max Level!', inline: true },
    )
    .setImage(`attachment://${name}`)
    .setFooter({ text: user.client?.user?.username || 'Badges', ...(user.client?.user ? { iconURL: user.client.user.displayAvatarURL() } : {}) })
    .setTimestamp(now);
  const later = state.upcoming.slice(1, 6);
  if (later.length) embed.addFields({ name: 'Timeline', value: later.map(item => `${symbols[kind][item.index]} **${kind === 'snow' ? snowNames[item.index] : label(item.months)}** → ${timestamp(item.date)}`).join('\n') });
  return { embeds: [embed], files: [new AttachmentBuilder(buffer, { name })], allowedMentions: { parse: [], repliedUser: false } };
}
