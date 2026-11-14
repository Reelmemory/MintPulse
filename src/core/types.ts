/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * MintPulse Core Domain Types
 * Scope: Strictly NFT Mints only (Free, Allowlist/Whitelist, Public).
 * Raffles, sweepstakes, and giveaways are intentionally excluded.
 */

export type MintCategory = 'free' | 'allowlist' | 'public';

export type VerificationStatus = 'verified' | 'unverified';

export type ChannelStatus = 'active' | 'unavailable' | 'missing_permissions' | 'unconfigured';

export type ReminderStatus = 'pending' | 'sent' | 'skipped' | 'failed';

export interface EvmChainConfig {
  chainId: number;
  slug: string;
  name: string;
  nativeSymbol: string;
  explorerUrl: string;
  openSeaChainIdentifier?: string;
  isEnabled: boolean;
}

export interface NormalizedMint {
  id: string;
  projectName: string;
  collectionName: string;
  collectionSlug: string;
  twitterHandle?: string | null;
  totalSupply?: string | null;
  chainId: number;
  contractAddress: string | null; // null when unknown/unverified — never fabricated
  mintStartUtc: string; // ISO-8601 UTC timestamp
  originalTimezone: string;
  category: MintCategory;
  mintPriceExact: string | null; // null when unknown/unverified — never fabricated
  mintPriceSymbol: string | null;
  websiteUrl: string | null;
  sourceUrl: string;
  discoverySource: string;
  verificationStatus: VerificationStatus;
  verificationNotes: string | null;
  submittedByGuildId?: string | null;
  submittedByUserId?: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface RawDiscoveredMint {
  projectName: string;
  collectionName?: string;
  collectionSlug?: string;
  twitterHandle?: string | null;
  totalSupply?: string | number | null;
  chainId: number;
  contractAddress?: string | null;
  mintStartIso: string;
  originalTimezone?: string;
  category: MintCategory;
  mintPriceExact?: string | null;
  mintPriceSymbol?: string | null;
  websiteUrl?: string | null;
  sourceUrl: string;
  discoverySource: string;
  verificationStatus: VerificationStatus;
  verificationNotes?: string | null;
  submittedByGuildId?: string | null;
  submittedByUserId?: string | null;
}

export interface GuildSettings {
  guildId: string;
  guildName: string;
  announcementChannelId: string | null;
  announcementChannelName: string | null;
  pingRoleId?: string | null;
  pingRoleName?: string | null;
  dailyDigestEnabled?: boolean;
  dailyDigestTimeUtc?: string; // HH:MM in UTC (e.g. "13:00")
  lastDigestSentDate?: string | null; // YYYY-MM-DD in UTC
  timezone: string;
  enabledCategories: MintCategory[];
  reminderIntervalsMinutes: number[];
  includeUnverifiedWatched: boolean;
  channelStatus: ChannelStatus;
  lastError: string | null;
  updatedByUserId: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface WatchlistEntry {
  id: number;
  guildId: string;
  collectionSlug: string;
  projectName: string;
  chainId: number | null;
  contractAddress: string | null;
  addedByUserId: string;
  createdAtUtc: string;
}

export interface ScheduledReminder {
  id: string;
  idempotencyKey: string;
  guildId: string;
  mintId: string;
  intervalMinutes: number;
  scheduledForUtc: string;
  status: ReminderStatus;
  attemptCount: number;
  recoveredAfterDowntime: boolean;
  lastError: string | null;
  dispatchedAtUtc: string | null;
  createdAtUtc: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedPayload {
  title: string;
  description: string;
  url?: string;
  color: number;
  fields: DiscordEmbedField[];
  footer: {
    text: string;
  };
  timestamp: string;
}

export interface DiscoveryFeedSource {
  url: string;
  label: string;
  addedBy: string;
  enabled: boolean;
  lastPolledUtc: string | null;
  lastDiscoveredCount: number;
  lastError: string | null;
  createdAtUtc: string;
}

export interface SlashCommandInvocation {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  userId: string;
  userTag: string;
  hasManageGuildPermission: boolean;
  commandName: 'setup' | 'mints' | 'mint' | 'settings' | 'help';
  subcommand?: 'today' | 'week' | 'digest' | 'watch' | 'add' | 'edit' | 'remove' | 'source';
  options: Record<string, string | boolean | number | undefined>;
}

export interface SlashCommandResult {
  ephemeral: boolean;
  content?: string;
  suppressEmbeds?: boolean;
  embeds: DiscordEmbedPayload[];
  success: boolean;
  errorCode?: string;
}
