/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Persistent NFT Mint Reminder Engine, Automated Daily Digest & Rate-Limit Aware Dispatcher
 * - Schedules reminders strictly for verified mints (or watched collections if explicitly enabled).
 * - Deduplicates via unique idempotency keys (`guild:{guildId}:mint:{mintId}:interval:{minutes}`).
 * - Dispatches automated once-per-day Daily Mint Digests at each server's configured UTC time.
 * - Recovers missed/overdue reminders within configurable grace window after downtime.
 * - Handles Discord 429 rate limits, unavailable channels, and missing bot permissions gracefully.
 */

import crypto from 'node:crypto';
import {
  buildDailyDigestPlainMessage,
  buildMintReminderEmbed,
  buildMintReminderPlainMessage,
  buildMintScheduleListEmbed,
} from '../discord/embedBuilder.ts';
import { logger } from '../logger.ts';
import { StorageRepository } from '../storage/database.ts';
import { isMintTodayInTimezone } from '../timezone/timezoneService.ts';
import {
  DiscordEmbedPayload,
  GuildSettings,
  NormalizedMint,
  ScheduledReminder,
} from '../types.ts';

export interface DispatchedNotificationRecord {
  id: string;
  idempotencyKey: string;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  mintId: string;
  projectName: string;
  intervalMinutes: number;
  content?: string;
  embed: DiscordEmbedPayload;
  dispatchedAtUtc: string;
  recoveredAfterDowntime: boolean;
}

export interface DeliveryTransportResult {
  success: boolean;
  rateLimitedRetryMs?: number;
  channelUnavailable?: boolean;
  missingPermissions?: boolean;
  errorMessage?: string;
}

export type DiscordDeliveryTransport = (
  guild: GuildSettings,
  embed: DiscordEmbedPayload,
  reminder: ScheduledReminder,
  plainContent?: string
) => Promise<DeliveryTransportResult>;

export class ReminderEngine {
  private readonly storage: StorageRepository;
  private deliveryTransport: DiscordDeliveryTransport;
  private dispatchedHistory: DispatchedNotificationRecord[] = [];
  private readonly overdueGraceMinutes: number;

  constructor(options: {
    storage: StorageRepository;
    deliveryTransport?: DiscordDeliveryTransport;
    overdueGraceMinutes?: number;
  }) {
    this.storage = options.storage;
    this.overdueGraceMinutes =
      options.overdueGraceMinutes ??
      (Number(process.env.OVERDUE_GRACE_MINUTES) > 0 ? Number(process.env.OVERDUE_GRACE_MINUTES) : 30);

    this.deliveryTransport =
      options.deliveryTransport ??
      (async (guild) => {
        if (!guild.announcementChannelId || guild.channelStatus === 'unconfigured') {
          return {
            success: false,
            channelUnavailable: true,
            errorMessage: 'Announcement channel is not configured for this server.',
          };
        }
        if (guild.channelStatus === 'unavailable') {
          return {
            success: false,
            channelUnavailable: true,
            errorMessage: 'Configured Discord channel is unavailable or deleted (10003).',
          };
        }
        if (guild.channelStatus === 'missing_permissions') {
          return {
            success: false,
            missingPermissions: true,
            errorMessage: 'Bot lacks Send Messages / Embed Links permissions in configured channel (50013).',
          };
        }
        return { success: true };
      });
  }

  public setDeliveryTransport(transport: DiscordDeliveryTransport): void {
    this.deliveryTransport = transport;
  }

  public getDispatchedHistory(guildId?: string): DispatchedNotificationRecord[] {
    if (!guildId) return [...this.dispatchedHistory];
    return this.dispatchedHistory.filter((d) => d.guildId === guildId);
  }

  public static buildIdempotencyKey(guildId: string, mintId: string, intervalMinutes: number): string {
    return `guild:${guildId}:mint:${mintId}:interval:${intervalMinutes}`;
  }

  /**
   * Synchronizes scheduled reminders in persistent storage for all configured guilds
   * and eligible upcoming mints. Uses unique idempotency keys so calling this repeatedly
   * never creates duplicate jobs.
   */
  public async syncSchedulesForAllGuilds(referenceNow: Date = new Date()): Promise<{
    newlyScheduledCount: number;
    skippedDuplicateCount: number;
  }> {
    const guilds = await this.storage.getAllGuildSettings();
    const mints = await this.storage.getAllMints();

    let newlyScheduledCount = 0;
    let skippedDuplicateCount = 0;

    for (const guild of guilds) {
      if (!guild.announcementChannelId || guild.channelStatus !== 'active') {
        continue;
      }

      const watchlist = await this.storage.getGuildWatchlist(guild.guildId);
      const watchedSlugs = new Set(watchlist.map((w) => w.collectionSlug.toLowerCase()));

      for (const mint of mints) {
        const mintStartMs = new Date(mint.mintStartUtc).getTime();
        if (Number.isNaN(mintStartMs) || mintStartMs <= referenceNow.getTime()) {
          continue;
        }

        const isWatched = watchedSlugs.has(mint.collectionSlug.toLowerCase());

        // Only schedule verified mints (unless watched AND server explicitly opted into unverified watched mints)
        const eligibleVerification =
          mint.verificationStatus === 'verified' || (isWatched && guild.includeUnverifiedWatched);
        if (!eligibleVerification) {
          continue;
        }

        // Respect server's category filters
        if (!guild.enabledCategories.includes(mint.category)) {
          continue;
        }

        for (const intervalMinutes of guild.reminderIntervalsMinutes) {
          const scheduledForMs = mintStartMs - intervalMinutes * 60 * 1000;
          const scheduledForUtc = new Date(scheduledForMs).toISOString();
          const idempotencyKey = ReminderEngine.buildIdempotencyKey(
            guild.guildId,
            mint.id,
            intervalMinutes
          );
          const id = `rem_${crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}`;

          const outcome = await this.storage.scheduleReminderIfNotExists({
            id,
            idempotencyKey,
            guildId: guild.guildId,
            mintId: mint.id,
            intervalMinutes,
            scheduledForUtc,
            status: 'pending',
            attemptCount: 0,
            recoveredAfterDowntime: false,
            lastError: null,
            dispatchedAtUtc: null,
            createdAtUtc: referenceNow.toISOString(),
          });

          if (outcome.created) {
            newlyScheduledCount++;
          } else {
            skippedDuplicateCount++;
          }
        }
      }
    }

    return { newlyScheduledCount, skippedDuplicateCount };
  }

  /**
   * Returns upcoming mints for a guild's daily digest (next 24h or today in guild timezone).
   */
  public async getUpcomingMintsForDailyDigest(
    guild: GuildSettings,
    referenceNow: Date = new Date()
  ): Promise<NormalizedMint[]> {
    const allMints = await this.storage.getAllMints();
    const nowMs = referenceNow.getTime();
    const next24hMs = nowMs + 24 * 3600 * 1000;

    return allMints.filter((m) => {
      if (!guild.enabledCategories.includes(m.category)) return false;
      const startMs = new Date(m.mintStartUtc).getTime();
      return (
        isMintTodayInTimezone(m.mintStartUtc, guild.timezone, referenceNow) ||
        (startMs >= nowMs - 2 * 3600 * 1000 && startMs <= next24hMs)
      );
    });
  }

  /**
   * Processes automated once-per-day Daily Digests for all guilds that have
   * `dailyDigestEnabled = true` and whose configured `dailyDigestTimeUtc` has arrived.
   */
  public async processDueDailyDigests(referenceNow: Date = new Date()): Promise<{
    digestsSent: number;
    records: DispatchedNotificationRecord[];
  }> {
    const guilds = await this.storage.getAllGuildSettings();
    const currentDateUtc = referenceNow.toISOString().slice(0, 10); // YYYY-MM-DD
    const currentMinutesUtc = referenceNow.getUTCHours() * 60 + referenceNow.getUTCMinutes();

    let digestsSent = 0;
    const records: DispatchedNotificationRecord[] = [];

    for (const guild of guilds) {
      if (!guild.dailyDigestEnabled || !guild.announcementChannelId || guild.channelStatus !== 'active') {
        continue;
      }

      // Idempotent once-per-day check
      if (guild.lastDigestSentDate === currentDateUtc) {
        continue;
      }

      const timeStr = guild.dailyDigestTimeUtc || '13:00';
      const [hhStr, mmStr] = timeStr.split(':');
      const targetMinutesUtc = (Number(hhStr) || 0) * 60 + (Number(mmStr) || 0);

      const diffMinutes = currentMinutesUtc - targetMinutesUtc;
      if (diffMinutes >= 0 && diffMinutes <= this.overdueGraceMinutes) {
        const outcome = await this.triggerDailyDigestNow(guild.guildId, referenceNow);
        if (outcome.success && outcome.record) {
          digestsSent++;
          records.push(outcome.record);
        }
      }
    }

    return { digestsSent, records };
  }

  /**
   * Dispatches a Daily Digest immediately for a guild (used by automated daily schedule,
   * `/mints digest`, and the Web Dashboard test button).
   */
  public async triggerDailyDigestNow(
    guildId: string,
    referenceNow: Date = new Date()
  ): Promise<{
    success: boolean;
    message: string;
    plainContent?: string;
    record?: DispatchedNotificationRecord;
  }> {
    const guild = await this.storage.getGuildSettings(guildId);
    const mints = await this.getUpcomingMintsForDailyDigest(guild, referenceNow);
    const plainContent = buildDailyDigestPlainMessage(mints, guild);
    const currentDateUtc = referenceNow.toISOString().slice(0, 10);
    const idempotencyKey = `guild:${guild.guildId}:daily_digest:${currentDateUtc}`;

    const embed = buildMintScheduleListEmbed(
      `Daily NFT Mint Digest — ${guild.guildName}`,
      `Automated Daily Schedule (${guild.dailyDigestTimeUtc || '13:00'} UTC)`,
      mints,
      guild,
      new Set()
    );

    const syntheticReminder: ScheduledReminder = {
      id: `digest_${guild.guildId}_${currentDateUtc}`,
      idempotencyKey,
      guildId: guild.guildId,
      mintId: 'daily_digest',
      intervalMinutes: 1440,
      scheduledForUtc: referenceNow.toISOString(),
      status: 'pending',
      attemptCount: 1,
      recoveredAfterDowntime: false,
      lastError: null,
      dispatchedAtUtc: null,
      createdAtUtc: referenceNow.toISOString(),
    };

    if (guild.announcementChannelId && guild.channelStatus === 'active') {
      const transportOutcome = await this.deliveryTransport(guild, embed, syntheticReminder, plainContent);
      if (!transportOutcome.success) {
        return {
          success: false,
          message: transportOutcome.errorMessage ?? 'Failed to deliver Daily Digest to channel.',
          plainContent,
        };
      }
    }

    const dispatchedAtUtc = referenceNow.toISOString();
    await this.storage.saveGuildSettings({
      ...guild,
      lastDigestSentDate: currentDateUtc,
    });

    const record: DispatchedNotificationRecord = {
      id: syntheticReminder.id,
      idempotencyKey,
      guildId: guild.guildId,
      guildName: guild.guildName,
      channelId: guild.announcementChannelId || 'simulator',
      channelName: guild.announcementChannelName || 'nft-mint-alerts',
      mintId: 'daily_digest',
      projectName: `Daily Mint Digest (${mints.length} drops)`,
      intervalMinutes: 1440,
      content: plainContent,
      embed,
      dispatchedAtUtc,
      recoveredAfterDowntime: false,
    };

    this.dispatchedHistory.unshift(record);
    logger.info('ReminderEngine', `Dispatched Daily Mint Digest for ${guild.guildName}`, {
      guildId: guild.guildId,
      mintCount: mints.length,
      dateUtc: currentDateUtc,
    });

    return {
      success: true,
      message: `Dispatched Daily Digest (${mints.length} upcoming mints) to #${
        guild.announcementChannelName || 'nft-mint-alerts'
      }.`,
      plainContent,
      record,
    };
  }

  /**
   * Processes due pending reminders up to `referenceNow`.
   * - Safely recovers overdue jobs within `overdueGraceMinutes` if the mint hasn't started yet.
   * - Skips stale jobs older than `overdueGraceMinutes` or for mints that have already started.
   * - Respects Discord rate limits and handles channel/permission failures gracefully.
   */
  public async processDueReminders(referenceNow: Date = new Date()): Promise<{
    sentCount: number;
    skippedStaleCount: number;
    failedCount: number;
    rateLimitedCount: number;
    dispatchedRecords: DispatchedNotificationRecord[];
  }> {
    const dueReminders = await this.storage.getDuePendingReminders(referenceNow.toISOString());
    let sentCount = 0;
    let skippedStaleCount = 0;
    let failedCount = 0;
    let rateLimitedCount = 0;
    const newlyDispatched: DispatchedNotificationRecord[] = [];

    for (const reminder of dueReminders) {
      const guild = await this.storage.getGuildSettings(reminder.guildId);
      const mint = await this.storage.getMintById(reminder.mintId);

      if (!mint) {
        await this.storage.updateReminderStatus(reminder.id, 'skipped', {
          lastError: 'Associated mint record no longer exists.',
        });
        skippedStaleCount++;
        continue;
      }

      const nowMs = referenceNow.getTime();
      const mintStartMs = new Date(mint.mintStartUtc).getTime();
      const scheduledMs = new Date(reminder.scheduledForUtc).getTime();
      const overdueMinutes = (nowMs - scheduledMs) / (60 * 1000);

      // 1. Check if mint has already started or passed
      if (nowMs >= mintStartMs) {
        await this.storage.updateReminderStatus(reminder.id, 'skipped', {
          lastError: 'Skipped: Mint start time already passed during downtime.',
        });
        skippedStaleCount++;
        logger.info('ReminderEngine', 'Skipped overdue reminder because mint already started', {
          reminderId: reminder.id,
          mintId: mint.id,
          guildId: guild.guildId,
        });
        continue;
      }

      // 2. Check if reminder is overdue beyond the safe downtime recovery grace window
      if (overdueMinutes > this.overdueGraceMinutes) {
        await this.storage.updateReminderStatus(reminder.id, 'skipped', {
          lastError: `Skipped: Overdue by ${Math.round(overdueMinutes)}m (exceeds ${this.overdueGraceMinutes}m downtime grace window).`,
        });
        skippedStaleCount++;
        logger.warn('ReminderEngine', 'Skipped stale reminder exceeding downtime grace window', {
          reminderId: reminder.id,
          overdueMinutes: Math.round(overdueMinutes),
          graceMinutes: this.overdueGraceMinutes,
        });
        continue;
      }

      const isRecovered = overdueMinutes > 2;
      const watchlist = await this.storage.getGuildWatchlist(guild.guildId);
      const isWatched = watchlist.some(
        (w) => w.collectionSlug.toLowerCase() === mint.collectionSlug.toLowerCase()
      );

      const embed = buildMintReminderEmbed(mint, guild, reminder.intervalMinutes, {
        isWatched,
        recoveredAfterDowntime: isRecovered,
      });

      const plainContent = buildMintReminderPlainMessage(mint, guild);
      const transportOutcome = await this.deliveryTransport(guild, embed, reminder, plainContent);

      if (transportOutcome.rateLimitedRetryMs && transportOutcome.rateLimitedRetryMs > 0) {
        rateLimitedCount++;
        await this.storage.updateReminderStatus(reminder.id, 'pending', {
          incrementAttempt: true,
          lastError: `Discord rate limit (429): backing off for ${transportOutcome.rateLimitedRetryMs}ms`,
        });
        logger.warn('ReminderEngine', 'Discord API rate limit encountered; deferring reminder', {
          reminderId: reminder.id,
          retryAfterMs: transportOutcome.rateLimitedRetryMs,
        });
        continue;
      }

      if (transportOutcome.channelUnavailable) {
        failedCount++;
        await this.storage.saveGuildSettings({
          ...guild,
          channelStatus: 'unavailable',
          lastError: transportOutcome.errorMessage ?? 'Announcement channel unavailable',
        });
        await this.storage.updateReminderStatus(reminder.id, 'failed', {
          incrementAttempt: true,
          lastError: transportOutcome.errorMessage ?? 'Channel unavailable',
        });
        logger.warn('ReminderEngine', 'Configured Discord channel is unavailable; disabled channel delivery', {
          guildId: guild.guildId,
          channelId: guild.announcementChannelId,
        });
        continue;
      }

      if (transportOutcome.missingPermissions) {
        failedCount++;
        await this.storage.saveGuildSettings({
          ...guild,
          channelStatus: 'missing_permissions',
          lastError: transportOutcome.errorMessage ?? 'Bot missing Send Messages / Embed Links permission',
        });
        await this.storage.updateReminderStatus(reminder.id, 'failed', {
          incrementAttempt: true,
          lastError: transportOutcome.errorMessage ?? 'Missing bot permissions',
        });
        logger.warn('ReminderEngine', 'Bot missing Discord channel permissions; marked guild status', {
          guildId: guild.guildId,
          channelId: guild.announcementChannelId,
        });
        continue;
      }

      if (!transportOutcome.success) {
        failedCount++;
        await this.storage.updateReminderStatus(reminder.id, 'failed', {
          incrementAttempt: true,
          lastError: transportOutcome.errorMessage ?? 'Delivery failed',
        });
        continue;
      }

      const dispatchedAtUtc = referenceNow.toISOString();
      await this.storage.updateReminderStatus(reminder.id, 'sent', {
        dispatchedAtUtc,
        recoveredAfterDowntime: isRecovered,
        incrementAttempt: true,
        lastError: null,
      });

      const record: DispatchedNotificationRecord = {
        id: reminder.id,
        idempotencyKey: reminder.idempotencyKey,
        guildId: guild.guildId,
        guildName: guild.guildName,
        channelId: guild.announcementChannelId || 'unknown',
        channelName: guild.announcementChannelName || 'nft-mint-alerts',
        mintId: mint.id,
        projectName: mint.projectName,
        intervalMinutes: reminder.intervalMinutes,
        content: plainContent,
        embed,
        dispatchedAtUtc,
        recoveredAfterDowntime: isRecovered,
      };

      this.dispatchedHistory.unshift(record);
      newlyDispatched.push(record);
      sentCount++;
    }

    // Also process any due automated Daily Digests
    await this.processDueDailyDigests(referenceNow);

    return {
      sentCount,
      skippedStaleCount,
      failedCount,
      rateLimitedCount,
      dispatchedRecords: newlyDispatched,
    };
  }

  /**
   * Allows manual force-dispatch of a specific pending reminder from the dashboard
   * while still respecting idempotency (cannot re-send an already 'sent' reminder).
   */
  public async triggerSingleReminderNow(reminderId: string): Promise<{
    success: boolean;
    message: string;
    record?: DispatchedNotificationRecord;
  }> {
    const all = await this.storage.getAllScheduledReminders();
    const target = all.find((r) => r.id === reminderId);
    if (!target) {
      return { success: false, message: 'Reminder job not found.' };
    }
    if (target.status === 'sent') {
      return {
        success: false,
        message: `Idempotency lock active: Reminder "${target.idempotencyKey}" was already dispatched at ${target.dispatchedAtUtc}. Duplicate notifications are blocked.`,
      };
    }

    const guild = await this.storage.getGuildSettings(target.guildId);
    const mint = await this.storage.getMintById(target.mintId);
    if (!mint) {
      return { success: false, message: 'Mint record not found.' };
    }

    const watchlist = await this.storage.getGuildWatchlist(guild.guildId);
    const isWatched = watchlist.some(
      (w) => w.collectionSlug.toLowerCase() === mint.collectionSlug.toLowerCase()
    );

    const embed = buildMintReminderEmbed(mint, guild, target.intervalMinutes, {
      isWatched,
      recoveredAfterDowntime: false,
    });
    const plainContent = buildMintReminderPlainMessage(mint, guild);

    const transportOutcome = await this.deliveryTransport(guild, embed, target, plainContent);
    if (!transportOutcome.success) {
      await this.storage.updateReminderStatus(target.id, 'failed', {
        incrementAttempt: true,
        lastError: transportOutcome.errorMessage ?? 'Delivery failed',
      });
      return {
        success: false,
        message: transportOutcome.errorMessage ?? 'Delivery failed.',
      };
    }

    const dispatchedAtUtc = new Date().toISOString();
    await this.storage.updateReminderStatus(target.id, 'sent', {
      dispatchedAtUtc,
      incrementAttempt: true,
      lastError: null,
    });

    const record: DispatchedNotificationRecord = {
      id: target.id,
      idempotencyKey: target.idempotencyKey,
      guildId: guild.guildId,
      guildName: guild.guildName,
      channelId: guild.announcementChannelId || 'unknown',
      channelName: guild.announcementChannelName || 'nft-mint-alerts',
      mintId: mint.id,
      projectName: mint.projectName,
      intervalMinutes: target.intervalMinutes,
      content: plainContent,
      embed,
      dispatchedAtUtc,
      recoveredAfterDowntime: false,
    };
    this.dispatchedHistory.unshift(record);

    return {
      success: true,
      message: `Dispatched ${target.intervalMinutes}m reminder for ${mint.projectName} to #${record.channelName}${
        guild.pingRoleName ? ` (tagged @${guild.pingRoleName.replace(/^@/, '')})` : ''
      }.`,
      record,
    };
  }
}
