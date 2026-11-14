/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Discord Slash Command Handler
 * Implements:
 * - /setup (requires ManageGuild / Administrator permission; configures channel, optional @Role tag, and optional Daily Digest)
 * - /mints today (5-bullet plain Discord message with native <t:UNIX:t> automatic user local time)
 * - /mints week (5-bullet plain Discord message for next 7 days with <t:UNIX:t> local time)
 * - /mints digest (posts/triggers the server's Daily Mint Digest schedule)
 * - /mint watch
 * - /mint add (validates URL with SSRF guard & saves with optional handle & supply)
 * - /mint edit (requires ManageGuild / Administrator; updates mint time, price, supply, @handle, chain, or URL)
 * - /mint remove (requires ManageGuild / Administrator; deletes a cancelled or outdated mint and its queued reminders)
 * - /settings (requires ManageGuild / Administrator; intervals, categories, @Role tag, and automated Daily Digest time)
 * - /help (comprehensive command & chain guide)
 *
 * Ensures strict per-server (guildId) isolation.
 * Strictly NFT mints only — no raffles.
 */

import { chainRegistry } from '../chains.ts';
import {
  buildMintSchedulePlainMessage,
  formatCategoryLabel,
  formatDailyDigestDisplay,
  formatIntervalLabel,
  formatMintHandle,
  formatMintPlainBlock,
  formatRoleMentionDisplay,
} from './embedBuilder.ts';
import { parseCustomMintPayload } from '../discovery/customWebsiteAdapter.ts';
import { ReminderEngine } from '../scheduler/reminderEngine.ts';
import { safeFetchExternalUrl, validateExternalUrl } from '../security/ssrfGuard.ts';
import { StorageRepository } from '../storage/database.ts';
import {
  isMintTodayInTimezone,
  isMintWithinNextSevenDays,
} from '../timezone/timezoneService.ts';
import {
  MintCategory,
  NormalizedMint,
  SlashCommandInvocation,
  SlashCommandResult,
} from '../types.ts';
import { slugifyCollection, verifyAndNormalizeMint } from '../verification/mintVerifier.ts';

function parseRoleOption(
  options: Record<string, string | boolean | number | undefined>,
  existingRoleId?: string | null,
  existingRoleName?: string | null
): { pingRoleId: string | null; pingRoleName: string | null } {
  const rawRoleId = options.role_id !== undefined ? String(options.role_id).trim() : undefined;
  const rawRoleName = options.role_name !== undefined ? String(options.role_name).trim() : undefined;

  if (rawRoleId === undefined && rawRoleName === undefined) {
    return {
      pingRoleId: existingRoleId ?? null,
      pingRoleName: existingRoleName ?? null,
    };
  }

  const lowerId = (rawRoleId ?? '').toLowerCase();
  const lowerName = (rawRoleName ?? '').toLowerCase();
  if (lowerId === 'none' || lowerId === 'clear' || lowerName === 'none' || lowerName === 'clear' || (!rawRoleId && !rawRoleName)) {
    return { pingRoleId: null, pingRoleName: null };
  }

  const cleanId = (rawRoleId || rawRoleName || '')
    .replace(/^<@&|>$/g, '')
    .replace(/^@/, '')
    .trim();
  const cleanName = (rawRoleName || rawRoleId || 'mint-alerts')
    .replace(/^<@&|>$/g, '')
    .replace(/^@/, '')
    .trim();

  return {
    pingRoleId: cleanId || null,
    pingRoleName: cleanName || null,
  };
}

function parseDailyDigestOption(
  rawOption: string | boolean | number | undefined,
  existingEnabled?: boolean,
  existingTimeUtc?: string
): { valid: boolean; enabled: boolean; timeUtc: string; error?: string } {
  if (rawOption === undefined || String(rawOption).trim() === '') {
    return {
      valid: true,
      enabled: Boolean(existingEnabled),
      timeUtc: existingTimeUtc || '13:00',
    };
  }

  const raw = String(rawOption).trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === 'disable' || raw === 'disabled' || raw === 'none') {
    return {
      valid: true,
      enabled: false,
      timeUtc: existingTimeUtc || '13:00',
    };
  }

  if (raw === 'on' || raw === 'true' || raw === 'enable' || raw === 'enabled') {
    return {
      valid: true,
      enabled: true,
      timeUtc: existingTimeUtc || '13:00',
    };
  }

  const match = raw.replace(/\s*utc$/i, '').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return {
      valid: false,
      enabled: Boolean(existingEnabled),
      timeUtc: existingTimeUtc || '13:00',
      error: 'Daily digest time must be in 24-hour `HH:MM` UTC format (e.g. `13:00` or `09:30`), `on`, or `off`.',
    };
  }

  const hh = match[1].padStart(2, '0');
  const mm = match[2];
  return {
    valid: true,
    enabled: true,
    timeUtc: `${hh}:${mm}`,
  };
}

export class DiscordCommandProcessor {
  private readonly storage: StorageRepository;
  private readonly reminderEngine: ReminderEngine;

  constructor(storage: StorageRepository, reminderEngine: ReminderEngine) {
    this.storage = storage;
    this.reminderEngine = reminderEngine;
  }

  public async executeCommand(
    invocation: SlashCommandInvocation,
    referenceNow: Date = new Date()
  ): Promise<SlashCommandResult> {
    const guild = await this.storage.getGuildSettings(invocation.guildId, invocation.guildName);

    switch (invocation.commandName) {
      case 'setup':
        return this.handleSetup(invocation);
      case 'settings':
        return this.handleSettings(invocation);
      case 'help':
        return this.handleHelp(invocation);
      case 'mints':
        if (invocation.subcommand === 'today') {
          return this.handleMintsToday(guild.guildId, referenceNow);
        }
        if (invocation.subcommand === 'digest') {
          return this.handleMintsDigest(invocation, referenceNow);
        }
        return this.handleMintsWeek(guild.guildId, referenceNow);
      case 'mint':
        if (invocation.subcommand === 'watch') {
          return this.handleMintWatch(invocation);
        }
        if (invocation.subcommand === 'add') {
          return this.handleMintAdd(invocation);
        }
        if (invocation.subcommand === 'edit') {
          return this.handleMintEdit(invocation);
        }
        if (invocation.subcommand === 'remove') {
          return this.handleMintRemove(invocation);
        }
        if (invocation.subcommand === 'source') {
          return this.handleMintSource(invocation);
        }
        return {
          ephemeral: true,
          success: false,
          errorCode: 'UNKNOWN_SUBCOMMAND',
          embeds: [
            {
              title: 'Unsupported Subcommand',
              description:
                'Supported subcommands are `/mint watch`, `/mint add`, `/mint edit`, `/mint remove`, and `/mint source`. Run `/help` for full usage details.',
              color: 0xef4444,
              fields: [],
              footer: { text: 'MintPulse · NFT Mints Only' },
              timestamp: new Date().toISOString(),
            },
          ],
        };
      default:
        return {
          ephemeral: true,
          success: true,
          content:
            'Manual timezone setup is no longer needed — MintPulse now uses Discord native timestamps (`<t:UNIX:t>`) so every user automatically sees mint times in their own device timezone. Run `/mints today`, `/mints week`, or `/help`.',
          embeds: [],
        };
    }
  }

  private createPermissionDeniedResult(commandLabel: string): SlashCommandResult {
    return {
      ephemeral: true,
      success: false,
      errorCode: 'PERMISSION_DENIED',
      embeds: [
        {
          title: 'Insufficient Discord Permissions',
          description: `You must have the **Manage Server** (\`ManageGuild\`) or **Administrator** permission in this Discord server to execute \`${commandLabel}\`.`,
          color: 0xef4444,
          fields: [
            {
              name: 'Required Permission',
              value: '`ManageGuild` or `Administrator`',
              inline: true,
            },
          ],
          footer: { text: 'MintPulse Security & Server Isolation' },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private async handleSetup(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    if (!invocation.hasManageGuildPermission) {
      return this.createPermissionDeniedResult('/setup');
    }

    const channelId = String(invocation.options.channel_id || invocation.channelId || '').trim();
    const channelName = String(invocation.options.channel_name || invocation.channelName || 'nft-mint-alerts')
      .trim()
      .replace(/^#/, '');

    if (!channelId) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'INVALID_CHANNEL',
        embeds: [
          {
            title: 'Invalid Announcement Channel',
            description: 'Please provide a valid Discord text channel to receive scheduled NFT mint reminders.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Configuration' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const existing = await this.storage.getGuildSettings(invocation.guildId, invocation.guildName);
    const { pingRoleId, pingRoleName } = parseRoleOption(
      invocation.options,
      existing.pingRoleId,
      existing.pingRoleName
    );

    const digestParsed = parseDailyDigestOption(
      invocation.options.daily_digest,
      existing.dailyDigestEnabled,
      existing.dailyDigestTimeUtc
    );
    if (!digestParsed.valid) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'INVALID_DAILY_DIGEST',
        embeds: [
          {
            title: 'Invalid Daily Digest Time',
            description: digestParsed.error || 'Invalid format.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Configuration' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const updated = await this.storage.saveGuildSettings({
      ...existing,
      guildName: invocation.guildName || existing.guildName,
      announcementChannelId: channelId,
      announcementChannelName: channelName,
      pingRoleId,
      pingRoleName,
      dailyDigestEnabled: digestParsed.enabled,
      dailyDigestTimeUtc: digestParsed.timeUtc,
      channelStatus: 'active',
      lastError: null,
      updatedByUserId: invocation.userId,
    });

    const syncResult = await this.reminderEngine.syncSchedulesForAllGuilds();

    return {
      ephemeral: false,
      success: true,
      embeds: [
        {
          title: 'Server Announcement Channel & Role Configured',
          description: `Scheduled NFT mint reminders for **${updated.guildName}** will now be delivered to **#${channelName}** (\`${channelId}\`) with automatic user-local Discord timestamps (\`<t:UNIX:t>\`).`,
          color: 0x10b981,
          fields: [
            {
              name: 'Announcement Channel',
              value: `#${channelName} (\`${channelId}\`)`,
              inline: true,
            },
            {
              name: 'Tagged Reminder Role',
              value: formatRoleMentionDisplay(updated),
              inline: true,
            },
            {
              name: 'Daily Digest Schedule',
              value: formatDailyDigestDisplay(updated),
              inline: false,
            },
            {
              name: 'Reminder Lead Times',
              value: updated.reminderIntervalsMinutes.map(formatIntervalLabel).join(', '),
              inline: false,
            },
            {
              name: 'Active Mint Categories',
              value: updated.enabledCategories.map(formatCategoryLabel).join(', '),
              inline: true,
            },
            {
              name: 'Newly Queued Reminders',
              value: `${syncResult.newlyScheduledCount} scheduled`,
              inline: true,
            },
          ],
          footer: {
            text: `Configured by ${invocation.userTag} · Server ID: ${updated.guildId}`,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private async handleSettings(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    if (!invocation.hasManageGuildPermission) {
      return this.createPermissionDeniedResult('/settings');
    }

    const existing = await this.storage.getGuildSettings(invocation.guildId, invocation.guildName);

    // Parse categories option if provided (e.g. "free,allowlist,public")
    let enabledCategories = [...existing.enabledCategories];
    if (invocation.options.categories !== undefined && String(invocation.options.categories).trim() !== '') {
      const rawCats = String(invocation.options.categories)
        .toLowerCase()
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      const parsedCats: MintCategory[] = [];
      for (const c of rawCats) {
        if (c === 'free') parsedCats.push('free');
        else if (c === 'allowlist' || c === 'whitelist') parsedCats.push('allowlist');
        else if (c === 'public') parsedCats.push('public');
        else {
          return {
            ephemeral: true,
            success: false,
            errorCode: 'INVALID_CATEGORY',
            embeds: [
              {
                title: 'Invalid Mint Category Filter',
                description: `Category \`${c}\` is not valid. Supported NFT mint categories are \`free\`, \`allowlist\`, and \`public\`. (Raffles are not supported).`,
                color: 0xef4444,
                fields: [],
                footer: { text: 'MintPulse Settings' },
                timestamp: new Date().toISOString(),
              },
            ],
          };
        }
      }
      if (parsedCats.length > 0) {
        enabledCategories = Array.from(new Set(parsedCats));
      }
    }

    // Parse reminder intervals in minutes if provided (e.g. "1440,60,15")
    let intervals = [...existing.reminderIntervalsMinutes];
    if (invocation.options.intervals !== undefined && String(invocation.options.intervals).trim() !== '') {
      const rawNums = String(invocation.options.intervals)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          if (s.endsWith('h')) return Number(s.slice(0, -1)) * 60;
          if (s.endsWith('m')) return Number(s.slice(0, -1));
          return Number(s);
        });

      if (rawNums.some((n) => Number.isNaN(n) || n < 5 || n > 10080)) {
        return {
          ephemeral: true,
          success: false,
          errorCode: 'INVALID_INTERVALS',
          embeds: [
            {
              title: 'Invalid Reminder Intervals',
              description:
                'Intervals must be between 5 minutes and 10080 minutes (7 days). Example: `1440,60,15` (for 24h, 1h, and 15m before mint).',
              color: 0xef4444,
              fields: [],
              footer: { text: 'MintPulse Settings' },
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      intervals = Array.from(new Set(rawNums.map((n) => Math.round(n)))).sort((a, b) => b - a);
    }

    const includeUnverifiedWatched =
      invocation.options.include_unverified_watched !== undefined
        ? Boolean(invocation.options.include_unverified_watched)
        : existing.includeUnverifiedWatched;

    const { pingRoleId, pingRoleName } = parseRoleOption(
      invocation.options,
      existing.pingRoleId,
      existing.pingRoleName
    );

    const digestParsed = parseDailyDigestOption(
      invocation.options.daily_digest,
      existing.dailyDigestEnabled,
      existing.dailyDigestTimeUtc
    );
    if (!digestParsed.valid) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'INVALID_DAILY_DIGEST',
        embeds: [
          {
            title: 'Invalid Daily Digest Schedule',
            description: digestParsed.error || 'Invalid format.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Settings' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const updated = await this.storage.saveGuildSettings({
      ...existing,
      pingRoleId,
      pingRoleName,
      dailyDigestEnabled: digestParsed.enabled,
      dailyDigestTimeUtc: digestParsed.timeUtc,
      enabledCategories,
      reminderIntervalsMinutes: intervals,
      includeUnverifiedWatched,
      updatedByUserId: invocation.userId,
    });

    await this.reminderEngine.syncSchedulesForAllGuilds();

    return {
      ephemeral: false,
      success: true,
      embeds: [
        {
          title: `Reminder & Daily Digest Settings Updated — ${updated.guildName}`,
          description: 'Server-isolated notification preferences, role mentions, and daily digest schedules have been persisted to PostgreSQL.',
          color: 0x6366f1,
          fields: [
            {
              name: 'Announcement Channel',
              value: updated.announcementChannelId
                ? `#${updated.announcementChannelName} (\`${updated.announcementChannelId}\`)`
                : 'Not configured (run `/setup` first)',
              inline: true,
            },
            {
              name: 'Tagged Reminder Role',
              value: formatRoleMentionDisplay(updated),
              inline: true,
            },
            {
              name: 'Automated Daily Digest',
              value: formatDailyDigestDisplay(updated),
              inline: false,
            },
            {
              name: 'Enabled Categories',
              value: updated.enabledCategories.map(formatCategoryLabel).join(', '),
              inline: false,
            },
            {
              name: 'Reminder Intervals',
              value: updated.reminderIntervalsMinutes.map(formatIntervalLabel).join(', '),
              inline: false,
            },
            {
              name: 'Unverified Watched Mints',
              value: updated.includeUnverifiedWatched
                ? 'Enabled for explicitly watched collections'
                : 'Disabled (Verified mints only)',
              inline: false,
            },
          ],
          footer: { text: `Updated by ${invocation.userTag} · Isolated to Server ${updated.guildId}` },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private async handleHelp(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    const guild = await this.storage.getGuildSettings(invocation.guildId, invocation.guildName);
    const enabledChains = chainRegistry
      .getEnabledChains()
      .map((c) => `**${c.name}** (\`${c.slug}\` · Chain ID \`${c.chainId}\`)`)
      .join('  ·  ');

    return {
      ephemeral: false,
      success: true,
      embeds: [
        {
          title: 'MintPulse — Command Reference & NFT Mint Reminder Guide',
          description:
            'MintPulse tracks upcoming **NFT mints** across **Ethereum**, **Robinhood Chain**, and **Ink Chain**, formatting every drop with Discord’s native `<t:UNIX:t>` timestamp so every user automatically sees mint times in their own local timezone.\n\u200B',
          color: 0x6366f1,
          fields: [
            {
              name: '1. Server Admin Commands (`Manage Server` or `Administrator`)',
              value: [
                '• **`/setup channel:#channel [role:@Role] [daily_digest:13:00|off]`** — Configures the alert channel, optional `@Role` tag, and optional automated Daily Digest time in UTC.',
                '• **`/settings [intervals:1440,60,15] [categories:free,allowlist,public] [role:@Role] [daily_digest:13:00|off] [include_unverified_watched:true|false]`** — Customizes reminder lead times, categories, role mention, and daily digest.',
                '• **`/mint edit query:<slug|@handle|name> [start_time] [price] [supply] [handle] [chain] [url] [category]`** — Updates an existing mint’s time, price, supply, `@handle`, or chain and reschedules reminders.',
                '• **`/mint remove query:<slug|@handle|name>`** — Deletes a cancelled or outdated mint and clears its pending reminders.',
                '• **`/mint source url:<https://...|list|clear> [label]`** — Connects an external website or JSON drop feed so MintPulse automatically pulls upcoming mints from it.',
                '\u200B',
              ].join('\n\n'),
              inline: false,
            },
            {
              name: '2. Mint Schedule & Discovery Commands (All Server Members)',
              value: [
                '• **`/mints today`** — Outputs today’s upcoming NFT mints in the clean 5-bullet format (`@Handle`, `Chain`, `Time`, `Mint page`, `Price`, `Supply`) automatically localized to each viewer’s timezone.',
                '• **`/mints week`** — Outputs upcoming NFT mints across the next 7 days in the 5-bullet format.',
                '• **`/mints digest`** — Posts or previews the server’s Daily Mint Digest immediately.',
                '• **`/mint watch collection:<slug or 0xContract>`** — Adds an NFT collection to this server’s priority watchlist.',
                '• **`/mint add url:<https://...> name:<Project> chain:<ethereum|robinhood|ink> start_time:<ISO-8601> category:<free|allowlist|public> [price] [supply] [handle]`** — Validates a mint URL through the SSRF guard and indexes it.',
                '\u200B',
              ].join('\n\n'),
              inline: false,
            },
            {
              name: '3. Allowed EVM Chains',
              value: `${enabledChains}\n\u200B`,
              inline: false,
            },
            {
              name: `4. Active Configuration for ${guild.guildName}`,
              value: [
                `**Channel:** ${guild.announcementChannelId ? `#${guild.announcementChannelName}` : 'Not configured (`/setup`)'}`,
                `**Tagged Role:** ${formatRoleMentionDisplay(guild)}`,
                `**Daily Digest:** ${formatDailyDigestDisplay(guild)}`,
                `**Timestamps:** Automatic User Local Time (\`<t:UNIX:t>\`)   ·   **Intervals:** ${guild.reminderIntervalsMinutes.map(formatIntervalLabel).join(', ')}`,
              ].join('\n'),
              inline: false,
            },
          ],
          footer: {
            text: `MintPulse Help · Requested by ${invocation.userTag} · NFT Mints Only`,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private async handleMintsToday(guildId: string, referenceNow: Date): Promise<SlashCommandResult> {
    const guild = await this.storage.getGuildSettings(guildId);
    const allMints = await this.storage.getAllMints();

    // Include mints happening today in UTC, today in the guild's reference timezone, OR within the next 24h window
    const nowMs = referenceNow.getTime();
    const next24hMs = nowMs + 24 * 3600 * 1000;
    const todayUtcPrefix = referenceNow.toISOString().slice(0, 10);
    const filtered = allMints.filter((m) => {
      if (!guild.enabledCategories.includes(m.category)) return false;
      const startMs = new Date(m.mintStartUtc).getTime();
      return (
        m.mintStartUtc.startsWith(todayUtcPrefix) ||
        isMintTodayInTimezone(m.mintStartUtc, guild.timezone, referenceNow) ||
        (startMs >= nowMs - 2 * 3600 * 1000 && startMs <= next24hMs)
      );
    });

    const plainMessage = buildMintSchedulePlainMessage(filtered, guild);

    return {
      ephemeral: false,
      success: true,
      content: plainMessage,
      suppressEmbeds: true,
      embeds: [],
    };
  }

  private async handleMintsWeek(guildId: string, referenceNow: Date): Promise<SlashCommandResult> {
    const guild = await this.storage.getGuildSettings(guildId);
    const allMints = await this.storage.getAllMints();

    const todayUtcStartMs = new Date(`${referenceNow.toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
    const windowEndMs = referenceNow.getTime() + 14 * 24 * 3600 * 1000;

    const filtered = allMints.filter((m) => {
      if (!guild.enabledCategories.includes(m.category)) return false;
      const startMs = new Date(m.mintStartUtc).getTime();
      return (
        isMintWithinNextSevenDays(m.mintStartUtc, referenceNow) ||
        (startMs >= todayUtcStartMs && startMs <= windowEndMs)
      );
    });

    const plainMessage = buildMintSchedulePlainMessage(filtered, guild);

    return {
      ephemeral: false,
      success: true,
      content: plainMessage,
      suppressEmbeds: true,
      embeds: [],
    };
  }

  private async handleMintsDigest(
    invocation: SlashCommandInvocation,
    referenceNow: Date
  ): Promise<SlashCommandResult> {
    const outcome = await this.reminderEngine.triggerDailyDigestNow(invocation.guildId, referenceNow);

    return {
      ephemeral: false,
      success: outcome.success,
      content: outcome.plainContent || outcome.message,
      suppressEmbeds: true,
      embeds: [],
    };
  }

  private async handleMintWatch(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    const query = String(invocation.options.collection || '').trim();
    if (!query || query.length < 2) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'INVALID_WATCH_QUERY',
        embeds: [
          {
            title: 'Invalid Collection Identifier',
            description: 'Provide a collection slug, project name, or EVM smart contract address (`0x...`) to watch.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Watchlist' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    await this.storage.getGuildSettings(invocation.guildId, invocation.guildName);
    const matchedMint = await this.storage.getMintBySlugOrContract(query);

    const collectionSlug = matchedMint ? matchedMint.collectionSlug : slugifyCollection(query);
    const projectName = matchedMint ? matchedMint.projectName : query;
    const chainId = matchedMint ? matchedMint.chainId : null;
    const contractAddress =
      matchedMint?.contractAddress || (chainRegistry.isValidEvmAddress(query) ? query : null);

    const outcome = await this.storage.addWatchlistEntry({
      guildId: invocation.guildId,
      collectionSlug,
      projectName,
      chainId,
      contractAddress,
      addedByUserId: invocation.userId,
    });

    await this.reminderEngine.syncSchedulesForAllGuilds();

    return {
      ephemeral: false,
      success: true,
      embeds: [
        {
          title: outcome.added
            ? `Added to Server Watchlist: ${projectName}`
            : `Already on Server Watchlist: ${projectName}`,
          description: outcome.added
            ? `This server is now watching **${projectName}** (\`${collectionSlug}\`). Upcoming mint stages will be highlighted with priority watchlist status.`
            : `**${projectName}** (\`${collectionSlug}\`) is already tracked on this server's watchlist.`,
          color: 0x10b981,
          fields: [
            {
              name: 'Collection Slug',
              value: `\`${collectionSlug}\``,
              inline: true,
            },
            {
              name: 'Known Contract',
              value: contractAddress ? `\`${contractAddress}\`` : 'Unverified / Not Published',
              inline: true,
            },
            {
              name: 'Matched Upcoming Mint',
              value: matchedMint
                ? `Yes (${formatCategoryLabel(matchedMint.category)} on Chain ${matchedMint.chainId})`
                : 'No scheduled mint currently in database; will match automatically when discovered',
              inline: false,
            },
          ],
          footer: { text: `Watched by ${invocation.userTag} · Server Watchlist` },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private async handleMintAdd(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    const url = String(invocation.options.url || '').trim();
    const projectName = String(invocation.options.name || '').trim();
    const chainInput = String(invocation.options.chain || 'robinhood').trim();
    const startTimeInput = String(invocation.options.start_time || '').trim();
    const categoryInput = String(invocation.options.category || 'public').trim().toLowerCase() as MintCategory;
    const priceInput =
      invocation.options.price !== undefined && String(invocation.options.price).trim() !== ''
        ? String(invocation.options.price).trim()
        : null;
    const supplyInput =
      invocation.options.supply !== undefined && String(invocation.options.supply).trim() !== ''
        ? String(invocation.options.supply).trim()
        : null;
    const handleInput =
      invocation.options.handle !== undefined && String(invocation.options.handle).trim() !== ''
        ? String(invocation.options.handle).trim()
        : null;
    const contractInput =
      invocation.options.contract !== undefined && String(invocation.options.contract).trim() !== ''
        ? String(invocation.options.contract).trim()
        : null;

    const chain = chainRegistry.getChainBySlugOrId(chainInput);
    if (!chain) {
      const supportedList = chainRegistry
        .getEnabledChains()
        .map((c) => `\`${c.slug}\` (${c.chainId})`)
        .join(', ');
      return {
        ephemeral: true,
        success: false,
        errorCode: 'UNSUPPORTED_CHAIN',
        embeds: [
          {
            title: 'Unsupported EVM Chain',
            description: `Chain \`${chainInput}\` is not registered or enabled. Allowed EVM chains: ${supportedList}.`,
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Chain Registry (Ethereum, Robinhood Chain, Ink Chain)' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const validation = await verifyAndNormalizeMint(
      {
        projectName,
        collectionName: projectName,
        twitterHandle: handleInput,
        totalSupply: supplyInput,
        chainId: chain.chainId,
        contractAddress: contractInput,
        mintStartIso: startTimeInput,
        originalTimezone: 'UTC',
        category: categoryInput,
        mintPriceExact: priceInput,
        mintPriceSymbol: chain.nativeSymbol,
        websiteUrl: url,
        sourceUrl: url,
        discoverySource: 'user_submission',
        verificationStatus: 'unverified', // Never pretend a user submission is verified
        verificationNotes: `Submitted by Discord user ${invocation.userTag} — Unverified community submission`,
        submittedByGuildId: invocation.guildId,
        submittedByUserId: invocation.userId,
      },
      { performDnsLookup: false }
    );

    if (!validation.valid || !validation.mint) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'VALIDATION_FAILED',
        embeds: [
          {
            title: 'Mint Submission Rejected by Security & Data Validator',
            description: validation.errors.map((e) => `• ${e}`).join('\n'),
            color: 0xef4444,
            fields: [
              {
                name: 'Submitted URL',
                value: url ? `\`${url.slice(0, 200)}\`` : '`(empty)`',
                inline: false,
              },
            ],
            footer: { text: 'MintPulse SSRF Guard & Anti-Fabrication Verifier' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const saved = await this.storage.upsertMint(validation.mint);

    // Also add to the submitting server's watchlist automatically
    await this.storage.addWatchlistEntry({
      guildId: invocation.guildId,
      collectionSlug: saved.collectionSlug,
      projectName: saved.projectName,
      chainId: saved.chainId,
      contractAddress: saved.contractAddress,
      addedByUserId: invocation.userId,
    });

    await this.reminderEngine.syncSchedulesForAllGuilds();

    return {
      ephemeral: false,
      success: true,
      content: formatMintPlainBlock(saved),
      suppressEmbeds: true,
      embeds: [],
    };
  }

  private async handleMintEdit(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    if (!invocation.hasManageGuildPermission) {
      return this.createPermissionDeniedResult('/mint edit');
    }

    const query = String(invocation.options.query || '').trim();
    if (!query) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'MISSING_QUERY',
        embeds: [
          {
            title: 'Missing Mint Identifier',
            description: 'Provide the collection slug, project name, `@handle`, or contract address in `query`.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Mint Editor' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const existing = await this.storage.getMintBySlugOrContract(query);
    if (!existing) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'MINT_NOT_FOUND',
        embeds: [
          {
            title: 'Mint Not Found',
            description: `Could not find any tracked mint matching \`${query}\`. Run \`/mints week\` to see tracked collections.`,
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Mint Editor' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const updates: Partial<NormalizedMint> = {};

    if (invocation.options.name !== undefined && String(invocation.options.name).trim() !== '') {
      const nextName = String(invocation.options.name).trim();
      updates.projectName = nextName;
      updates.collectionName = nextName;
    }

    if (invocation.options.handle !== undefined && String(invocation.options.handle).trim() !== '') {
      const rawH = String(invocation.options.handle).trim();
      updates.twitterHandle = rawH.startsWith('@') ? rawH : `@${rawH}`;
    }

    if (invocation.options.supply !== undefined && String(invocation.options.supply).trim() !== '') {
      updates.totalSupply = String(invocation.options.supply).trim();
    }

    if (invocation.options.chain !== undefined && String(invocation.options.chain).trim() !== '') {
      const chainObj = chainRegistry.getChainBySlugOrId(String(invocation.options.chain).trim());
      if (!chainObj) {
        return {
          ephemeral: true,
          success: false,
          errorCode: 'UNSUPPORTED_CHAIN',
          embeds: [
            {
              title: 'Unsupported EVM Chain',
              description: 'Allowed chains are `ethereum` (1), `robinhood` (747474), and `ink` (57073).',
              color: 0xef4444,
              fields: [],
              footer: { text: 'MintPulse Mint Editor' },
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      updates.chainId = chainObj.chainId;
      updates.mintPriceSymbol = chainObj.nativeSymbol;
    }

    if (invocation.options.category !== undefined && String(invocation.options.category).trim() !== '') {
      const cat = String(invocation.options.category).trim().toLowerCase();
      if (cat !== 'free' && cat !== 'allowlist' && cat !== 'public') {
        return {
          ephemeral: true,
          success: false,
          errorCode: 'INVALID_CATEGORY',
          embeds: [
            {
              title: 'Invalid Category',
              description: 'Supported categories are `free`, `allowlist`, and `public`.',
              color: 0xef4444,
              fields: [],
              footer: { text: 'MintPulse Mint Editor' },
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      updates.category = cat as MintCategory;
    }

    if (invocation.options.price !== undefined && String(invocation.options.price).trim() !== '') {
      const rawPrice = String(invocation.options.price).trim();
      if (/^(free|0|0\.0+)$/i.test(rawPrice)) {
        updates.mintPriceExact = '0';
        updates.category = 'free';
      } else if (/^tba$/i.test(rawPrice)) {
        updates.mintPriceExact = null;
      } else {
        const cleaned = rawPrice.replace(/[^0-9.]/g, '');
        if (!cleaned || Number.isNaN(Number(cleaned))) {
          return {
            ephemeral: true,
            success: false,
            errorCode: 'INVALID_PRICE',
            embeds: [
              {
                title: 'Invalid Mint Price',
                description: 'Provide a numeric price (e.g. `0.0004`), `Free`, or `TBA`.',
                color: 0xef4444,
                fields: [],
                footer: { text: 'MintPulse Mint Editor' },
                timestamp: new Date().toISOString(),
              },
            ],
          };
        }
        updates.mintPriceExact = cleaned;
      }
    }

    let startTimeChanged = false;
    if (invocation.options.start_time !== undefined && String(invocation.options.start_time).trim() !== '') {
      const parsedDate = new Date(String(invocation.options.start_time).trim());
      if (Number.isNaN(parsedDate.getTime())) {
        return {
          ephemeral: true,
          success: false,
          errorCode: 'INVALID_START_TIME',
          embeds: [
            {
              title: 'Invalid Mint Start Timestamp',
              description: 'Provide a valid ISO-8601 UTC timestamp (e.g. `2026-10-19T16:00:00Z`).',
              color: 0xef4444,
              fields: [],
              footer: { text: 'MintPulse Mint Editor' },
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      updates.mintStartUtc = parsedDate.toISOString();
      startTimeChanged = updates.mintStartUtc !== existing.mintStartUtc;
    }

    if (invocation.options.url !== undefined && String(invocation.options.url).trim() !== '') {
      const rawUrl = String(invocation.options.url).trim();
      const urlCheck = await validateExternalUrl(rawUrl, { performDnsLookup: false });
      if (!urlCheck.valid || !urlCheck.normalizedUrl) {
        return {
          ephemeral: true,
          success: false,
          errorCode: 'INVALID_URL',
          embeds: [
            {
              title: 'URL Blocked by SSRF Guard',
              description: urlCheck.reason || 'Unsafe URL rejected.',
              color: 0xef4444,
              fields: [],
              footer: { text: 'MintPulse SSRF Guard' },
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
      updates.sourceUrl = urlCheck.normalizedUrl;
      updates.websiteUrl = urlCheck.normalizedUrl;
    }

    const updated = await this.storage.updateMintById(existing.id, updates);
    if (!updated) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'UPDATE_FAILED',
        embeds: [],
        content: 'Could not update mint record.',
      };
    }

    if (startTimeChanged) {
      await this.storage.deletePendingRemindersForMint(existing.id);
    }
    await this.reminderEngine.syncSchedulesForAllGuilds();

    return {
      ephemeral: false,
      success: true,
      content: formatMintPlainBlock(updated),
      suppressEmbeds: true,
      embeds: [],
    };
  }

  private async handleMintRemove(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    if (!invocation.hasManageGuildPermission) {
      return this.createPermissionDeniedResult('/mint remove');
    }

    const query = String(invocation.options.query || '').trim();
    if (!query) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'MISSING_QUERY',
        embeds: [
          {
            title: 'Missing Mint Identifier',
            description: 'Provide the collection slug, project name, `@handle`, or contract address to remove.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Mint Manager' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const existing = await this.storage.getMintBySlugOrContract(query);
    if (!existing) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'MINT_NOT_FOUND',
        embeds: [
          {
            title: 'Mint Not Found',
            description: `Could not find any tracked mint matching \`${query}\`.`,
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Mint Manager' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const handleDisplay = formatMintHandle(existing);
    await this.storage.deleteMintById(existing.id);
    await this.storage.removeWatchlistEntry(invocation.guildId, existing.collectionSlug);

    return {
      ephemeral: false,
      success: true,
      embeds: [
        {
          title: `Removed Mint: ${existing.projectName} (${handleDisplay})`,
          description: `Deleted **${existing.projectName}** (\`${existing.collectionSlug}\`) and cleared its pending scheduled reminders.`,
          color: 0x10b981,
          fields: [
            {
              name: 'Removed By',
              value: invocation.userTag,
              inline: true,
            },
            {
              name: 'Collection Slug',
              value: `\`${existing.collectionSlug}\``,
              inline: true,
            },
          ],
          footer: { text: 'MintPulse Mint Manager' },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  private async handleMintSource(invocation: SlashCommandInvocation): Promise<SlashCommandResult> {
    if (!invocation.hasManageGuildPermission) {
      return this.createPermissionDeniedResult('/mint source');
    }

    const rawUrl = String(invocation.options.url || '').trim();
    const label = String(invocation.options.label || 'Custom Mint Website').trim() || 'Custom Mint Website';

    if (!rawUrl || rawUrl.toLowerCase() === 'list') {
      const sources = await this.storage.getFeedSources();
      const desc =
        sources.length === 0
          ? 'No custom website mint sources are connected yet. Run `/mint source url:https://your-mint-website.com` to connect your website.'
          : sources
              .map(
                (s, idx) =>
                  `**${idx + 1}. ${s.label}**\n• URL: \`${s.url}\`\n• Last Synced Mints: \`${s.lastDiscoveredCount}\`${s.lastError ? ` (Last error: ${s.lastError})` : ''}`
              )
              .join('\n\n');

      return {
        ephemeral: false,
        success: true,
        embeds: [
          {
            title: `Connected Mint Websites (${sources.length})`,
            description: desc,
            color: 0x6366f1,
            fields: [],
            footer: { text: 'MintPulse Website Feed Connector' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    if (rawUrl.toLowerCase() === 'clear') {
      const sources = await this.storage.getFeedSources();
      for (const s of sources) {
        await this.storage.removeFeedSource(s.url);
      }
      return {
        ephemeral: false,
        success: true,
        embeds: [
          {
            title: 'Cleared Connected Website Sources',
            description: `Removed ${sources.length} custom website source(s).`,
            color: 0x10b981,
            fields: [],
            footer: { text: 'MintPulse Website Feed Connector' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    if (rawUrl.toLowerCase().startsWith('remove:')) {
      const targetUrl = rawUrl.slice('remove:'.length).trim();
      const removed = await this.storage.removeFeedSource(targetUrl);
      return {
        ephemeral: false,
        success: removed,
        embeds: [
          {
            title: removed ? 'Removed Website Source' : 'Website Source Not Found',
            description: removed
              ? `Disconnected \`${targetUrl}\` from MintPulse.`
              : `Could not find connected source matching \`${targetUrl}\`.`,
            color: removed ? 0x10b981 : 0xef4444,
            fields: [],
            footer: { text: 'MintPulse Website Feed Connector' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const urlCheck = await validateExternalUrl(rawUrl, { performDnsLookup: false });
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      return {
        ephemeral: true,
        success: false,
        errorCode: 'INVALID_SOURCE_URL',
        embeds: [
          {
            title: 'Website URL Rejected by SSRF Guard',
            description: urlCheck.reason || 'Provide a valid public HTTPS website URL.',
            color: 0xef4444,
            fields: [],
            footer: { text: 'MintPulse SSRF Guard' },
            timestamp: new Date().toISOString(),
          },
        ],
      };
    }

    const normalizedUrl = urlCheck.normalizedUrl;
    await this.storage.addFeedSource(normalizedUrl, label, invocation.userTag);

    let importedCount = 0;
    let fetchNote = 'Saved to active discovery sources; will poll automatically.';

    try {
      const response = await safeFetchExternalUrl(normalizedUrl, { timeoutMs: 8000 });
      if (response.status === 200) {
        const parsed = parseCustomMintPayload(response.bodyText, response.finalUrl);
        for (const raw of parsed) {
          const verified = await verifyAndNormalizeMint(raw, { performDnsLookup: false });
          if (verified.valid && verified.mint) {
            await this.storage.upsertMint(verified.mint);
            importedCount++;
          }
        }
        await this.storage.updateFeedSourceStatus(normalizedUrl, {
          discoveredCount: importedCount,
          lastError: null,
        });
        await this.reminderEngine.syncSchedulesForAllGuilds();
        fetchNote =
          importedCount > 0
            ? `Successfully fetched and imported **${importedCount}** upcoming mint(s) from the website.`
            : 'Connected website (HTTP 200). No structured upcoming mints were found on this page yet — share your website URL or structure if it uses a custom layout.';
      } else {
        await this.storage.updateFeedSourceStatus(normalizedUrl, {
          discoveredCount: 0,
          lastError: `HTTP ${response.status}`,
        });
        fetchNote = `Saved source URL, but initial fetch returned HTTP ${response.status}.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.storage.updateFeedSourceStatus(normalizedUrl, {
        discoveredCount: 0,
        lastError: msg,
      });
      fetchNote = `Saved source URL (initial fetch note: ${msg}).`;
    }

    return {
      ephemeral: false,
      success: true,
      embeds: [
        {
          title: `Connected Mint Website Source: ${label}`,
          description: fetchNote,
          color: 0x10b981,
          fields: [
            {
              name: 'Website / Feed URL',
              value: `\`${normalizedUrl}\``,
              inline: false,
            },
            {
              name: 'Mints Imported Now',
              value: `\`${importedCount}\``,
              inline: true,
            },
            {
              name: 'Auto-Sync Polling',
              value: 'Enabled',
              inline: true,
            },
          ],
          footer: { text: `Connected by ${invocation.userTag} · MintPulse Discovery Engine` },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }
}

export { DiscordCommandProcessor as SlashCommandProcessor };
