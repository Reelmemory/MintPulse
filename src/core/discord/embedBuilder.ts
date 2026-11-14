/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Discord Message & Embed Builder for NFT Mint Announcements & Command Responses
 * Formats normalized mint records into the clean 5-bullet plain Discord message
 * format matching the user's screenshot (@Handle + Chain, Time, Mint page, Price, Supply)
 * with native Discord <t:UNIX:t> automatic local timestamps.
 */

import { chainRegistry } from '../chains.ts';
import { DiscordEmbedField, DiscordEmbedPayload, GuildSettings, MintCategory, NormalizedMint } from '../types.ts';

export function formatCategoryLabel(category: MintCategory): string {
  switch (category) {
    case 'free':
      return 'Free Mint';
    case 'allowlist':
      return 'Allowlist / Whitelist';
    case 'public':
      return 'Public Mint';
  }
}

export function formatIntervalLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '24 hours before' : `${days * 24} hours before`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour before' : `${hours} hours before`;
  }
  return `${minutes} minutes before`;
}

export function formatPriceDisplay(mint: NormalizedMint): string {
  if (mint.category === 'free' || mint.mintPriceExact === '0' || mint.mintPriceExact === '0.0') {
    return 'Free';
  }
  if (mint.mintPriceExact !== null && mint.mintPriceExact !== undefined && mint.mintPriceExact !== '') {
    return `${mint.mintPriceExact} ${mint.mintPriceSymbol || 'ETH'}`;
  }
  return 'TBA';
}

export function formatContractDisplay(mint: NormalizedMint): string {
  if (!mint.contractAddress) {
    return 'Unverified / Not Published';
  }
  const explorerUrl = chainRegistry.getContractExplorerUrl(mint.chainId, mint.contractAddress);
  const shortHex = `${mint.contractAddress.slice(0, 6)}...${mint.contractAddress.slice(-4)}`;
  return explorerUrl ? `[${shortHex}](${explorerUrl})` : `\`${mint.contractAddress}\``;
}

export function formatRoleMentionDisplay(guild: GuildSettings): string {
  if (!guild.pingRoleId) {
    return 'None configured (set via `/setup` or `/settings`)';
  }
  const roleLabel = guild.pingRoleName ? `@${guild.pingRoleName.replace(/^@/, '')}` : 'Role';
  return `<@&${guild.pingRoleId}> (${roleLabel})`;
}

export function formatMintHandle(mint: NormalizedMint): string {
  if (mint.twitterHandle && mint.twitterHandle.trim() !== '') {
    const clean = mint.twitterHandle.trim().replace(/^@+/, '');
    if (clean) return `@${clean}`;
  }
  const derived = mint.projectName
    .replace(/\[Test Fixture\]/gi, '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '');
  return `@${derived || 'NFTCollection'}`;
}

export function formatMintPageUrl(mint: NormalizedMint): string {
  const rawUrl = (mint.sourceUrl || mint.websiteUrl || '').trim();
  const withoutTrailingSlash = rawUrl.replace(/\/+$/, '');
  if (/^https?:\/\/(www\.)?opensea\.io\/collection\/[^/]+$/i.test(withoutTrailingSlash)) {
    return `${withoutTrailingSlash}/overview`;
  }
  return rawUrl;
}

export function formatDiscordLocalTimeTag(isoUtc: string): string {
  const unixSeconds = Math.floor(new Date(isoUtc).getTime() / 1000);
  return `<t:${unixSeconds}:t>`;
}

export function formatDiscordRelativeTimeTag(isoUtc: string): string {
  const unixSeconds = Math.floor(new Date(isoUtc).getTime() / 1000);
  return `<t:${unixSeconds}:R>`;
}

/**
 * Formats a single mint in the exact 5-bullet screenshot format:
 *
 * @ComputersRh
 * • Chain : Robinhood Chain
 * • Time : <t:1760803200:t>
 * • Mint page : https://opensea.io/collection/computersrh-nft/overview
 * • Price : Free
 * • Supply : 3333
 */
export function formatMintPlainBlock(mint: NormalizedMint): string {
  const chain = chainRegistry.getChainById(mint.chainId);
  const chainName = chain ? chain.name : `Chain ${mint.chainId}`;
  const handle = formatMintHandle(mint);
  const timeTag = formatDiscordLocalTimeTag(mint.mintStartUtc);
  const mintPage = formatMintPageUrl(mint);
  const price = formatPriceDisplay(mint);
  const supply =
    mint.totalSupply !== null && mint.totalSupply !== undefined && String(mint.totalSupply).trim() !== ''
      ? String(mint.totalSupply).trim()
      : 'TBA';

  return [
    handle,
    `• Chain : ${chainName}`,
    `• Time : ${timeTag}`,
    `• Mint page : ${mintPage}`,
    `• Price : ${price}`,
    `• Supply : ${supply}`,
  ].join('\n');
}

/**
 * Builds the plain Discord message for `/mints today` and `/mints week`
 * with blank-line spacing between each project and native <t:UNIX:t> timestamps.
 */
export function buildMintSchedulePlainMessage(mints: NormalizedMint[], guild: GuildSettings): string {
  if (mints.length === 0) {
    return `No upcoming NFT mints found for active categories (${guild.enabledCategories
      .map(formatCategoryLabel)
      .join(', ')}) on Ethereum, Robinhood Chain, or Ink Chain.`;
  }

  const slice = mints.slice(0, 25);
  return slice.map((mint) => formatMintPlainBlock(mint)).join('\n\n');
}

/**
 * Splits a multi-project plain Discord message along `\n\n` boundaries so every chunk
 * is strictly <= maxChars (default 1900, safely under Discord's 2000-character limit).
 */
export function splitDiscordPlainMessage(content: string, maxChars = 1900): string[] {
  const trimmed = content.trim();
  if (!trimmed) return ['No content available.'];
  if (trimmed.length <= maxChars) return [trimmed];

  const blocks = trimmed.split('\n\n');
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    if (!current) {
      current = block.slice(0, maxChars);
    } else if (current.length + 2 + block.length <= maxChars) {
      current = `${current}\n\n${block}`;
    } else {
      chunks.push(current);
      current = block.slice(0, maxChars);
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [trimmed.slice(0, maxChars)];
}

/**
 * Formats the server's Daily Digest configuration for /setup, /settings, and /help embeds.
 */
export function formatDailyDigestDisplay(guild: GuildSettings): string {
  if (!guild.dailyDigestEnabled) {
    return 'Disabled (enable via `/settings daily_digest:13:00`)';
  }
  const timeUtc = guild.dailyDigestTimeUtc || '13:00';
  const [hh, mm] = timeUtc.split(':').map((n) => Number(n) || 0);
  const now = new Date();
  const sampleDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0);
  const unixSec = Math.floor(sampleDate / 1000);
  return `Enabled daily at \`${timeUtc} UTC\` (<t:${unixSec}:t> your local time)`;
}

/**
 * Builds the automated Daily Digest plain Discord message with optional @Role mention
 * and blank-line spacing between each project in the 5-bullet screenshot format.
 */
export function buildDailyDigestPlainMessage(mints: NormalizedMint[], guild: GuildSettings): string {
  const scheduleBody = buildMintSchedulePlainMessage(mints, guild);
  if (guild.pingRoleId) {
    return `<@&${guild.pingRoleId}>\n\n${scheduleBody}`;
  }
  return scheduleBody;
}

/**
 * Builds the plain Discord message for a scheduled reminder dispatch,
 * including the server's @Role mention if configured.
 */
export function buildMintReminderPlainMessage(mint: NormalizedMint, guild: GuildSettings): string {
  const block = formatMintPlainBlock(mint);
  if (guild.pingRoleId) {
    return `<@&${guild.pingRoleId}>\n${block}`;
  }
  return block;
}

export function buildMintReminderEmbed(
  mint: NormalizedMint,
  guild: GuildSettings,
  intervalMinutes: number,
  options?: { isWatched?: boolean; recoveredAfterDowntime?: boolean }
): DiscordEmbedPayload {
  const chain = chainRegistry.getChainById(mint.chainId);
  const chainLabel = chain ? chain.name : `Chain ID ${mint.chainId}`;
  const timeTag = formatDiscordLocalTimeTag(mint.mintStartUtc);
  const relTag = formatDiscordRelativeTimeTag(mint.mintStartUtc);
  const leadLabel = formatIntervalLabel(intervalMinutes);
  const color = mint.verificationStatus === 'verified' ? 0x6366f1 : 0xf59e0b;

  const descriptionParts = [formatMintPlainBlock(mint)];
  if (options?.isWatched) {
    descriptionParts.push(`\nPriority Watchlist Collection (${leadLabel}).`);
  }
  if (options?.recoveredAfterDowntime) {
    descriptionParts.push('\nNote: Dispatched via downtime recovery within grace window.');
  }

  const fields: DiscordEmbedField[] = [
    {
      name: 'Chain',
      value: chainLabel,
      inline: true,
    },
    {
      name: 'Local Time',
      value: `${timeTag} (${relTag})`,
      inline: true,
    },
    {
      name: 'Price & Supply',
      value: `${formatPriceDisplay(mint)} · Supply: ${mint.totalSupply || 'TBA'}`,
      inline: true,
    },
  ];

  if (guild.pingRoleId) {
    fields.push({
      name: 'Tagged Server Role',
      value: formatRoleMentionDisplay(guild),
      inline: false,
    });
  }

  return {
    title: `${formatMintHandle(mint)} — ${mint.projectName}`,
    description: descriptionParts.join('\n'),
    url: formatMintPageUrl(mint),
    color,
    fields,
    footer: {
      text: `MintPulse · Automatic Local Time · Chains: Ethereum, Robinhood Chain, Ink Chain`,
    },
    timestamp: new Date().toISOString(),
  };
}

export function buildMintScheduleListEmbed(
  title: string,
  subtitle: string,
  mints: NormalizedMint[],
  guild: GuildSettings,
  _watchedSlugs: Set<string>
): DiscordEmbedPayload {
  return {
    title,
    description: buildMintSchedulePlainMessage(mints, guild),
    color: 0x6366f1,
    fields: [],
    footer: {
      text: `${subtitle} · Chains: Ethereum, Robinhood Chain, Ink Chain`,
    },
    timestamp: new Date().toISOString(),
  };
}
