/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Persistent Storage Layer (PostgreSQL + Local SQL-Semantics Fallback)
 * Provides strict multi-server isolation, unique idempotency constraints for reminders,
 * daily digest state tracking, and normalized mint persistence (add, edit, remove).
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { logger } from '../logger.ts';
import {
  ChannelStatus,
  DiscoveryFeedSource,
  GuildSettings,
  MintCategory,
  NormalizedMint,
  ReminderStatus,
  ScheduledReminder,
  WatchlistEntry,
} from '../types.ts';

const { Pool } = pg;

export interface StorageRepository {
  readonly mode: 'postgresql' | 'embedded_sql_store';
  initialize(): Promise<void>;
  upsertMint(mint: NormalizedMint): Promise<NormalizedMint>;
  updateMintById(id: string, updates: Partial<NormalizedMint>): Promise<NormalizedMint | null>;
  deleteMintById(id: string): Promise<boolean>;
  deletePendingRemindersForMint(mintId: string): Promise<number>;
  getAllMints(): Promise<NormalizedMint[]>;
  getMintById(id: string): Promise<NormalizedMint | null>;
  getMintBySlugOrContract(query: string): Promise<NormalizedMint | null>;
  getGuildSettings(guildId: string, defaultName?: string): Promise<GuildSettings>;
  getAllGuildSettings(): Promise<GuildSettings[]>;
  saveGuildSettings(settings: GuildSettings): Promise<GuildSettings>;
  addWatchlistEntry(entry: Omit<WatchlistEntry, 'id' | 'createdAtUtc'>): Promise<{ added: boolean; entry: WatchlistEntry }>;
  getGuildWatchlist(guildId: string): Promise<WatchlistEntry[]>;
  removeWatchlistEntry(guildId: string, collectionSlug: string): Promise<boolean>;
  scheduleReminderIfNotExists(reminder: ScheduledReminder): Promise<{ created: boolean; reminder: ScheduledReminder }>;
  getDuePendingReminders(upToUtc: string): Promise<ScheduledReminder[]>;
  getAllScheduledReminders(guildId?: string): Promise<ScheduledReminder[]>;
  updateReminderStatus(
    id: string,
    status: ReminderStatus,
    options?: {
      dispatchedAtUtc?: string | null;
      lastError?: string | null;
      recoveredAfterDowntime?: boolean;
      incrementAttempt?: boolean;
    }
  ): Promise<ScheduledReminder | null>;
  getFeedSources(): Promise<DiscoveryFeedSource[]>;
  addFeedSource(url: string, label?: string, addedBy?: string): Promise<DiscoveryFeedSource>;
  updateFeedSourceStatus(url: string, status: { discoveredCount: number; lastError: string | null }): Promise<void>;
  removeFeedSource(url: string): Promise<boolean>;
}

interface PersistedSnapshot {
  mints: NormalizedMint[];
  guilds: GuildSettings[];
  watchlists: WatchlistEntry[];
  reminders: ScheduledReminder[];
  watchlistSeq: number;
  feedSources?: DiscoveryFeedSource[];
}

/**
 * Enforces identical relational constraints (`uq_chain_slug_start_category`,
 * `uq_guild_watchlist_slug`, `UNIQUE(idempotency_key)`) with optional file persistence.
 */
export class EmbeddedSqlRepository implements StorageRepository {
  public readonly mode = 'embedded_sql_store' as const;
  private mints = new Map<string, NormalizedMint>();
  private guilds = new Map<string, GuildSettings>();
  private watchlists: WatchlistEntry[] = [];
  private reminders = new Map<string, ScheduledReminder>();
  private remindersByIdempotency = new Map<string, string>();
  private feedSources = new Map<string, DiscoveryFeedSource>();
  private watchlistSeq = 1;
  private readonly persistPath: string | null;

  constructor(persistFilePath?: string | null) {
    this.persistPath = persistFilePath === undefined ? path.resolve(process.cwd(), '.data', 'mintpulse-store.json') : persistFilePath;
  }

  public async initialize(): Promise<void> {
    const allowedChainIds = new Set([1, 747474, 57073]);
    if (this.persistPath && fs.existsSync(this.persistPath)) {
      try {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedSnapshot;
        for (const m of parsed.mints ?? []) {
          const isLegacyUnscheduledOpenSea =
            m.discoverySource === 'opensea_v2' &&
            (!m.verificationNotes ||
              m.verificationNotes === 'Verified via OpenSea API v2 with published onchain contract address');
          if (allowedChainIds.has(m.chainId) && !isLegacyUnscheduledOpenSea) {
            this.mints.set(m.id, m);
          }
        }
        for (const g of parsed.guilds ?? []) this.guilds.set(g.guildId, g);
        this.watchlists = parsed.watchlists ?? [];
        this.watchlistSeq = parsed.watchlistSeq ?? (this.watchlists.length + 1);
        for (const r of parsed.reminders ?? []) {
          if (this.mints.has(r.mintId)) {
            this.reminders.set(r.id, r);
            this.remindersByIdempotency.set(r.idempotencyKey, r.id);
          }
        }
        for (const fsEntry of parsed.feedSources ?? []) {
          this.feedSources.set(fsEntry.url, fsEntry);
        }
        this.flushToDisk();
      } catch (err) {
        logger.warn('Storage', 'Could not read persisted snapshot, starting fresh', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private flushToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const snapshot: PersistedSnapshot = {
        mints: Array.from(this.mints.values()),
        guilds: Array.from(this.guilds.values()),
        watchlists: this.watchlists,
        reminders: Array.from(this.reminders.values()),
        watchlistSeq: this.watchlistSeq,
        feedSources: Array.from(this.feedSources.values()),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('Storage', 'Failed to flush snapshot to disk', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async upsertMint(mint: NormalizedMint): Promise<NormalizedMint> {
    // Check unique constraint (chain_id, collection_slug, mint_start_utc, category)
    for (const existing of this.mints.values()) {
      if (
        existing.chainId === mint.chainId &&
        existing.collectionSlug === mint.collectionSlug &&
        existing.mintStartUtc === mint.mintStartUtc &&
        existing.category === mint.category
      ) {
        const updated: NormalizedMint = {
          ...existing,
          ...mint,
          id: existing.id,
          createdAtUtc: existing.createdAtUtc,
          updatedAtUtc: new Date().toISOString(),
        };
        this.mints.set(existing.id, updated);
        this.flushToDisk();
        return updated;
      }
    }

    this.mints.set(mint.id, mint);
    this.flushToDisk();
    return mint;
  }

  public async updateMintById(id: string, updates: Partial<NormalizedMint>): Promise<NormalizedMint | null> {
    const existing = this.mints.get(id);
    if (!existing) return null;

    const updated: NormalizedMint = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAtUtc: existing.createdAtUtc,
      updatedAtUtc: new Date().toISOString(),
    };
    this.mints.set(existing.id, updated);
    this.flushToDisk();
    return updated;
  }

  public async deleteMintById(id: string): Promise<boolean> {
    if (!this.mints.has(id)) return false;
    this.mints.delete(id);
    for (const [remId, rem] of this.reminders.entries()) {
      if (rem.mintId === id) {
        this.reminders.delete(remId);
        this.remindersByIdempotency.delete(rem.idempotencyKey);
      }
    }
    this.flushToDisk();
    return true;
  }

  public async deletePendingRemindersForMint(mintId: string): Promise<number> {
    let removed = 0;
    for (const [remId, rem] of this.reminders.entries()) {
      if (rem.mintId === mintId && rem.status === 'pending') {
        this.reminders.delete(remId);
        this.remindersByIdempotency.delete(rem.idempotencyKey);
        removed++;
      }
    }
    if (removed > 0) {
      this.flushToDisk();
    }
    return removed;
  }

  public async getAllMints(): Promise<NormalizedMint[]> {
    return Array.from(this.mints.values()).sort(
      (a, b) => new Date(a.mintStartUtc).getTime() - new Date(b.mintStartUtc).getTime()
    );
  }

  public async getMintById(id: string): Promise<NormalizedMint | null> {
    return this.mints.get(id) ?? null;
  }

  public async getMintBySlugOrContract(query: string): Promise<NormalizedMint | null> {
    const q = query.trim().toLowerCase();
    const qNoAt = q.replace(/^@/, '');
    for (const mint of this.mints.values()) {
      const handleClean = (mint.twitterHandle ?? '').trim().toLowerCase().replace(/^@/, '');
      if (
        mint.id.toLowerCase() === q ||
        mint.collectionSlug.toLowerCase() === q ||
        mint.projectName.toLowerCase() === q ||
        mint.collectionName.toLowerCase() === q ||
        (handleClean && handleClean === qNoAt) ||
        (mint.contractAddress && mint.contractAddress.toLowerCase() === q)
      ) {
        return mint;
      }
    }
    return null;
  }

  public async getGuildSettings(guildId: string, defaultName = 'Discord Server'): Promise<GuildSettings> {
    const existing = this.guilds.get(guildId);
    if (existing) {
      return {
        ...existing,
        pingRoleId: existing.pingRoleId ?? null,
        pingRoleName: existing.pingRoleName ?? null,
        dailyDigestEnabled: Boolean(existing.dailyDigestEnabled),
        dailyDigestTimeUtc: existing.dailyDigestTimeUtc || '13:00',
        lastDigestSentDate: existing.lastDigestSentDate ?? null,
        enabledCategories: [...existing.enabledCategories],
        reminderIntervalsMinutes: [...existing.reminderIntervalsMinutes],
      };
    }

    const nowUtc = new Date().toISOString();
    const initial: GuildSettings = {
      guildId,
      guildName: defaultName,
      announcementChannelId: null,
      announcementChannelName: null,
      pingRoleId: null,
      pingRoleName: null,
      dailyDigestEnabled: false,
      dailyDigestTimeUtc: '13:00',
      lastDigestSentDate: null,
      timezone: 'UTC',
      enabledCategories: ['free', 'allowlist', 'public'],
      reminderIntervalsMinutes: [1440, 60, 15],
      includeUnverifiedWatched: false,
      channelStatus: 'unconfigured',
      lastError: null,
      updatedByUserId: null,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };
    this.guilds.set(guildId, initial);
    this.flushToDisk();
    return {
      ...initial,
      enabledCategories: [...initial.enabledCategories],
      reminderIntervalsMinutes: [...initial.reminderIntervalsMinutes],
    };
  }

  public async getAllGuildSettings(): Promise<GuildSettings[]> {
    return Array.from(this.guilds.values()).map((g) => ({
      ...g,
      pingRoleId: g.pingRoleId ?? null,
      pingRoleName: g.pingRoleName ?? null,
      dailyDigestEnabled: Boolean(g.dailyDigestEnabled),
      dailyDigestTimeUtc: g.dailyDigestTimeUtc || '13:00',
      lastDigestSentDate: g.lastDigestSentDate ?? null,
      enabledCategories: [...g.enabledCategories],
      reminderIntervalsMinutes: [...g.reminderIntervalsMinutes],
    }));
  }

  public async saveGuildSettings(settings: GuildSettings): Promise<GuildSettings> {
    const updated: GuildSettings = {
      ...settings,
      pingRoleId: settings.pingRoleId ?? null,
      pingRoleName: settings.pingRoleName ?? null,
      dailyDigestEnabled: Boolean(settings.dailyDigestEnabled),
      dailyDigestTimeUtc: settings.dailyDigestTimeUtc || '13:00',
      lastDigestSentDate: settings.lastDigestSentDate ?? null,
      enabledCategories: [...settings.enabledCategories],
      reminderIntervalsMinutes: [...settings.reminderIntervalsMinutes],
      updatedAtUtc: new Date().toISOString(),
    };
    this.guilds.set(settings.guildId, updated);
    this.flushToDisk();
    return updated;
  }

  public async addWatchlistEntry(
    entry: Omit<WatchlistEntry, 'id' | 'createdAtUtc'>
  ): Promise<{ added: boolean; entry: WatchlistEntry }> {
    const normalizedSlug = entry.collectionSlug.trim().toLowerCase();
    const existing = this.watchlists.find(
      (w) => w.guildId === entry.guildId && w.collectionSlug.toLowerCase() === normalizedSlug
    );
    if (existing) {
      return { added: false, entry: existing };
    }

    const created: WatchlistEntry = {
      ...entry,
      collectionSlug: normalizedSlug,
      id: this.watchlistSeq++,
      createdAtUtc: new Date().toISOString(),
    };
    this.watchlists.push(created);
    this.flushToDisk();
    return { added: true, entry: created };
  }

  public async getGuildWatchlist(guildId: string): Promise<WatchlistEntry[]> {
    return this.watchlists.filter((w) => w.guildId === guildId);
  }

  public async removeWatchlistEntry(guildId: string, collectionSlug: string): Promise<boolean> {
    const normalizedSlug = collectionSlug.trim().toLowerCase();
    const prevLen = this.watchlists.length;
    this.watchlists = this.watchlists.filter(
      (w) => !(w.guildId === guildId && w.collectionSlug.toLowerCase() === normalizedSlug)
    );
    if (this.watchlists.length !== prevLen) {
      this.flushToDisk();
      return true;
    }
    return false;
  }

  public async scheduleReminderIfNotExists(
    reminder: ScheduledReminder
  ): Promise<{ created: boolean; reminder: ScheduledReminder }> {
    const existingId = this.remindersByIdempotency.get(reminder.idempotencyKey);
    if (existingId) {
      const existing = this.reminders.get(existingId)!;
      return { created: false, reminder: existing };
    }

    this.reminders.set(reminder.id, { ...reminder });
    this.remindersByIdempotency.set(reminder.idempotencyKey, reminder.id);
    this.flushToDisk();
    return { created: true, reminder: { ...reminder } };
  }

  public async getDuePendingReminders(upToUtc: string): Promise<ScheduledReminder[]> {
    const cutoffMs = new Date(upToUtc).getTime();
    return Array.from(this.reminders.values())
      .filter((r) => r.status === 'pending' && new Date(r.scheduledForUtc).getTime() <= cutoffMs)
      .sort((a, b) => new Date(a.scheduledForUtc).getTime() - new Date(b.scheduledForUtc).getTime());
  }

  public async getAllScheduledReminders(guildId?: string): Promise<ScheduledReminder[]> {
    const list = Array.from(this.reminders.values()).filter((r) => !guildId || r.guildId === guildId);
    return list.sort((a, b) => new Date(a.scheduledForUtc).getTime() - new Date(b.scheduledForUtc).getTime());
  }

  public async updateReminderStatus(
    id: string,
    status: ReminderStatus,
    options?: {
      dispatchedAtUtc?: string | null;
      lastError?: string | null;
      recoveredAfterDowntime?: boolean;
      incrementAttempt?: boolean;
    }
  ): Promise<ScheduledReminder | null> {
    const existing = this.reminders.get(id);
    if (!existing) return null;

    const updated: ScheduledReminder = {
      ...existing,
      status,
      attemptCount: options?.incrementAttempt ? existing.attemptCount + 1 : existing.attemptCount,
      dispatchedAtUtc:
        options?.dispatchedAtUtc !== undefined ? options.dispatchedAtUtc : existing.dispatchedAtUtc,
      lastError: options?.lastError !== undefined ? options.lastError : existing.lastError,
      recoveredAfterDowntime:
        options?.recoveredAfterDowntime !== undefined
          ? options.recoveredAfterDowntime
          : existing.recoveredAfterDowntime,
    };

    this.reminders.set(id, updated);
    this.flushToDisk();
    return updated;
  }

  public async getFeedSources(): Promise<DiscoveryFeedSource[]> {
    return Array.from(this.feedSources.values());
  }

  public async addFeedSource(url: string, label = 'Custom Mint Website', addedBy = 'admin'): Promise<DiscoveryFeedSource> {
    const cleanUrl = url.trim();
    const existing = this.feedSources.get(cleanUrl);
    const entry: DiscoveryFeedSource = {
      url: cleanUrl,
      label: label.trim() || 'Custom Mint Website',
      addedBy,
      enabled: true,
      lastPolledUtc: existing?.lastPolledUtc ?? null,
      lastDiscoveredCount: existing?.lastDiscoveredCount ?? 0,
      lastError: existing?.lastError ?? null,
      createdAtUtc: existing?.createdAtUtc ?? new Date().toISOString(),
    };
    this.feedSources.set(cleanUrl, entry);
    this.flushToDisk();
    return entry;
  }

  public async updateFeedSourceStatus(
    url: string,
    status: { discoveredCount: number; lastError: string | null }
  ): Promise<void> {
    const existing = this.feedSources.get(url.trim());
    if (!existing) return;
    existing.lastPolledUtc = new Date().toISOString();
    existing.lastDiscoveredCount = status.discoveredCount;
    existing.lastError = status.lastError;
    this.feedSources.set(existing.url, existing);
    this.flushToDisk();
  }

  public async removeFeedSource(url: string): Promise<boolean> {
    const existed = this.feedSources.delete(url.trim());
    if (existed) this.flushToDisk();
    return existed;
  }
}

/**
 * Production PostgreSQL Repository using pg.Pool
 */
export class PostgresRepository implements StorageRepository {
  public readonly mode = 'postgresql' as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      keepAlive: true,
    });

    this.pool.on('error', (err) => {
      // Prevent idle client disconnection events from Supabase Pooler from crashing the Node process
      console.warn('[Storage] Idle PostgreSQL pool client error (auto-recovering):', err.message);
    });
  }

  public async initialize(): Promise<void> {
    const migrationPath = path.resolve(process.cwd(), 'migrations', '001_initial_schema.sql');
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      await this.pool.query(sql);
    }
  }

  private mapMintRow(row: Record<string, unknown>): NormalizedMint {
    return {
      id: String(row.id),
      projectName: String(row.project_name),
      collectionName: String(row.collection_name),
      collectionSlug: String(row.collection_slug),
      twitterHandle: row.twitter_handle ? String(row.twitter_handle) : null,
      totalSupply: row.total_supply !== null && row.total_supply !== undefined ? String(row.total_supply) : null,
      chainId: Number(row.chain_id),
      contractAddress: row.contract_address ? String(row.contract_address) : null,
      mintStartUtc: new Date(String(row.mint_start_utc)).toISOString(),
      originalTimezone: String(row.original_timezone),
      category: String(row.category) as MintCategory,
      mintPriceExact: row.mint_price_exact !== null && row.mint_price_exact !== undefined ? String(row.mint_price_exact) : null,
      mintPriceSymbol: row.mint_price_symbol ? String(row.mint_price_symbol) : null,
      websiteUrl: row.website_url ? String(row.website_url) : null,
      sourceUrl: String(row.source_url),
      discoverySource: String(row.discovery_source),
      verificationStatus: (String(row.verification_status) === 'verified' ? 'verified' : 'unverified'),
      verificationNotes: row.verification_notes ? String(row.verification_notes) : null,
      submittedByGuildId: row.submitted_by_guild_id ? String(row.submitted_by_guild_id) : null,
      submittedByUserId: row.submitted_by_user_id ? String(row.submitted_by_user_id) : null,
      createdAtUtc: new Date(String(row.created_at_utc)).toISOString(),
      updatedAtUtc: new Date(String(row.updated_at_utc)).toISOString(),
    };
  }

  private mapGuildRow(row: Record<string, unknown>): GuildSettings {
    return {
      guildId: String(row.guild_id),
      guildName: String(row.guild_name),
      announcementChannelId: row.announcement_channel_id ? String(row.announcement_channel_id) : null,
      announcementChannelName: row.announcement_channel_name ? String(row.announcement_channel_name) : null,
      pingRoleId: row.ping_role_id ? String(row.ping_role_id) : null,
      pingRoleName: row.ping_role_name ? String(row.ping_role_name) : null,
      dailyDigestEnabled: Boolean(row.daily_digest_enabled),
      dailyDigestTimeUtc: row.daily_digest_time_utc ? String(row.daily_digest_time_utc) : '13:00',
      lastDigestSentDate: row.last_digest_sent_date ? String(row.last_digest_sent_date) : null,
      timezone: String(row.timezone),
      enabledCategories: (row.enabled_categories as MintCategory[]) ?? ['free', 'allowlist', 'public'],
      reminderIntervalsMinutes: ((row.reminder_intervals_minutes as number[]) ?? [1440, 60, 15]).map(Number),
      includeUnverifiedWatched: Boolean(row.include_unverified_watched),
      channelStatus: (row.channel_status as ChannelStatus) ?? 'unconfigured',
      lastError: row.last_error ? String(row.last_error) : null,
      updatedByUserId: row.updated_by_user_id ? String(row.updated_by_user_id) : null,
      createdAtUtc: new Date(String(row.created_at_utc)).toISOString(),
      updatedAtUtc: new Date(String(row.updated_at_utc)).toISOString(),
    };
  }

  private mapReminderRow(row: Record<string, unknown>): ScheduledReminder {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      guildId: String(row.guild_id),
      mintId: String(row.mint_id),
      intervalMinutes: Number(row.interval_minutes),
      scheduledForUtc: new Date(String(row.scheduled_for_utc)).toISOString(),
      status: String(row.status) as ReminderStatus,
      attemptCount: Number(row.attempt_count),
      recoveredAfterDowntime: Boolean(row.recovered_after_downtime),
      lastError: row.last_error ? String(row.last_error) : null,
      dispatchedAtUtc: row.dispatched_at_utc ? new Date(String(row.dispatched_at_utc)).toISOString() : null,
      createdAtUtc: new Date(String(row.created_at_utc)).toISOString(),
    };
  }

  public async upsertMint(mint: NormalizedMint): Promise<NormalizedMint> {
    const res = await this.pool.query(
      `INSERT INTO nft_mints (
        id, project_name, collection_name, collection_slug, twitter_handle, total_supply, chain_id,
        contract_address, mint_start_utc, original_timezone, category,
        mint_price_exact, mint_price_symbol, website_url, source_url,
        discovery_source, verification_status, verification_notes,
        submitted_by_guild_id, submitted_by_user_id, created_at_utc, updated_at_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (chain_id, collection_slug, mint_start_utc, category)
      DO UPDATE SET
        project_name = EXCLUDED.project_name,
        twitter_handle = COALESCE(EXCLUDED.twitter_handle, nft_mints.twitter_handle),
        total_supply = COALESCE(EXCLUDED.total_supply, nft_mints.total_supply),
        contract_address = COALESCE(EXCLUDED.contract_address, nft_mints.contract_address),
        mint_price_exact = COALESCE(EXCLUDED.mint_price_exact, nft_mints.mint_price_exact),
        source_url = EXCLUDED.source_url,
        verification_status = EXCLUDED.verification_status,
        verification_notes = EXCLUDED.verification_notes,
        updated_at_utc = NOW()
      RETURNING *`,
      [
        mint.id,
        mint.projectName,
        mint.collectionName,
        mint.collectionSlug,
        mint.twitterHandle ?? null,
        mint.totalSupply ?? null,
        mint.chainId,
        mint.contractAddress,
        mint.mintStartUtc,
        mint.originalTimezone,
        mint.category,
        mint.mintPriceExact,
        mint.mintPriceSymbol,
        mint.websiteUrl,
        mint.sourceUrl,
        mint.discoverySource,
        mint.verificationStatus,
        mint.verificationNotes,
        mint.submittedByGuildId ?? null,
        mint.submittedByUserId ?? null,
        mint.createdAtUtc,
        mint.updatedAtUtc,
      ]
    );
    return this.mapMintRow(res.rows[0]);
  }

  public async updateMintById(id: string, updates: Partial<NormalizedMint>): Promise<NormalizedMint | null> {
    const existing = await this.getMintById(id);
    if (!existing) return null;

    const merged: NormalizedMint = {
      ...existing,
      ...updates,
      id: existing.id,
      updatedAtUtc: new Date().toISOString(),
    };

    const res = await this.pool.query(
      `UPDATE nft_mints
       SET project_name = $2,
           collection_name = $3,
           collection_slug = $4,
           twitter_handle = $5,
           total_supply = $6,
           chain_id = $7,
           contract_address = $8,
           mint_start_utc = $9,
           category = $10,
           mint_price_exact = $11,
           mint_price_symbol = $12,
           website_url = $13,
           source_url = $14,
           verification_status = $15,
           verification_notes = $16,
           updated_at_utc = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        merged.projectName,
        merged.collectionName,
        merged.collectionSlug,
        merged.twitterHandle ?? null,
        merged.totalSupply ?? null,
        merged.chainId,
        merged.contractAddress ?? null,
        merged.mintStartUtc,
        merged.category,
        merged.mintPriceExact ?? null,
        merged.mintPriceSymbol ?? 'ETH',
        merged.websiteUrl ?? merged.sourceUrl,
        merged.sourceUrl,
        merged.verificationStatus,
        merged.verificationNotes ?? null,
      ]
    );

    return res.rows[0] ? this.mapMintRow(res.rows[0]) : null;
  }

  public async deleteMintById(id: string): Promise<boolean> {
    await this.pool.query(`DELETE FROM scheduled_reminders WHERE mint_id = $1`, [id]);
    const res = await this.pool.query(`DELETE FROM nft_mints WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  public async deletePendingRemindersForMint(mintId: string): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM scheduled_reminders WHERE mint_id = $1 AND status = 'pending'`,
      [mintId]
    );
    return res.rowCount ?? 0;
  }

  public async getAllMints(): Promise<NormalizedMint[]> {
    const res = await this.pool.query(`SELECT * FROM nft_mints ORDER BY mint_start_utc ASC`);
    return res.rows.map((r) => this.mapMintRow(r));
  }

  public async getMintById(id: string): Promise<NormalizedMint | null> {
    const res = await this.pool.query(`SELECT * FROM nft_mints WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ? this.mapMintRow(res.rows[0]) : null;
  }

  public async getMintBySlugOrContract(query: string): Promise<NormalizedMint | null> {
    const q = query.trim().toLowerCase();
    const qWithAt = q.startsWith('@') ? q : `@${q}`;
    const qNoAt = q.replace(/^@/, '');
    const res = await this.pool.query(
      `SELECT * FROM nft_mints
       WHERE LOWER(id) = $1
          OR LOWER(collection_slug) = $1
          OR LOWER(project_name) = $1
          OR LOWER(collection_name) = $1
          OR LOWER(twitter_handle) = $2
          OR LOWER(twitter_handle) = $3
          OR LOWER(contract_address) = $1
       ORDER BY mint_start_utc ASC
       LIMIT 1`,
      [q, qWithAt, qNoAt]
    );
    return res.rows[0] ? this.mapMintRow(res.rows[0]) : null;
  }

  public async getGuildSettings(guildId: string, defaultName = 'Discord Server'): Promise<GuildSettings> {
    const existing = await this.pool.query(`SELECT * FROM guild_settings WHERE guild_id = $1 LIMIT 1`, [guildId]);
    if (existing.rows[0]) {
      return this.mapGuildRow(existing.rows[0]);
    }

    const inserted = await this.pool.query(
      `INSERT INTO guild_settings (
        guild_id, guild_name, timezone, enabled_categories, reminder_intervals_minutes, channel_status
      ) VALUES ($1, $2, 'UTC', ARRAY['free','allowlist','public'], ARRAY[1440,60,15], 'unconfigured')
      ON CONFLICT (guild_id) DO UPDATE SET guild_name = guild_settings.guild_name
      RETURNING *`,
      [guildId, defaultName]
    );
    return this.mapGuildRow(inserted.rows[0]);
  }

  public async getAllGuildSettings(): Promise<GuildSettings[]> {
    const res = await this.pool.query(`SELECT * FROM guild_settings ORDER BY created_at_utc ASC`);
    return res.rows.map((r) => this.mapGuildRow(r));
  }

  public async saveGuildSettings(settings: GuildSettings): Promise<GuildSettings> {
    const res = await this.pool.query(
      `INSERT INTO guild_settings (
        guild_id, guild_name, announcement_channel_id, announcement_channel_name,
        ping_role_id, ping_role_name,
        daily_digest_enabled, daily_digest_time_utc, last_digest_sent_date,
        timezone, enabled_categories, reminder_intervals_minutes, include_unverified_watched,
        channel_status, last_error, updated_by_user_id, updated_at_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (guild_id) DO UPDATE SET
        guild_name = EXCLUDED.guild_name,
        announcement_channel_id = EXCLUDED.announcement_channel_id,
        announcement_channel_name = EXCLUDED.announcement_channel_name,
        ping_role_id = EXCLUDED.ping_role_id,
        ping_role_name = EXCLUDED.ping_role_name,
        daily_digest_enabled = EXCLUDED.daily_digest_enabled,
        daily_digest_time_utc = EXCLUDED.daily_digest_time_utc,
        last_digest_sent_date = EXCLUDED.last_digest_sent_date,
        timezone = EXCLUDED.timezone,
        enabled_categories = EXCLUDED.enabled_categories,
        reminder_intervals_minutes = EXCLUDED.reminder_intervals_minutes,
        include_unverified_watched = EXCLUDED.include_unverified_watched,
        channel_status = EXCLUDED.channel_status,
        last_error = EXCLUDED.last_error,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at_utc = NOW()
      RETURNING *`,
      [
        settings.guildId,
        settings.guildName,
        settings.announcementChannelId,
        settings.announcementChannelName,
        settings.pingRoleId ?? null,
        settings.pingRoleName ?? null,
        Boolean(settings.dailyDigestEnabled),
        settings.dailyDigestTimeUtc || '13:00',
        settings.lastDigestSentDate ?? null,
        settings.timezone,
        settings.enabledCategories,
        settings.reminderIntervalsMinutes,
        settings.includeUnverifiedWatched,
        settings.channelStatus,
        settings.lastError,
        settings.updatedByUserId,
      ]
    );
    return this.mapGuildRow(res.rows[0]);
  }

  public async addWatchlistEntry(
    entry: Omit<WatchlistEntry, 'id' | 'createdAtUtc'>
  ): Promise<{ added: boolean; entry: WatchlistEntry }> {
    const slug = entry.collectionSlug.trim().toLowerCase();
    const res = await this.pool.query(
      `INSERT INTO guild_watchlists (
        guild_id, collection_slug, project_name, chain_id, contract_address, added_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (guild_id, collection_slug) DO NOTHING
      RETURNING *`,
      [entry.guildId, slug, entry.projectName, entry.chainId, entry.contractAddress, entry.addedByUserId]
    );

    if (res.rows[0]) {
      const r = res.rows[0];
      return {
        added: true,
        entry: {
          id: Number(r.id),
          guildId: String(r.guild_id),
          collectionSlug: String(r.collection_slug),
          projectName: String(r.project_name),
          chainId: r.chain_id ? Number(r.chain_id) : null,
          contractAddress: r.contract_address ? String(r.contract_address) : null,
          addedByUserId: String(r.added_by_user_id),
          createdAtUtc: new Date(String(r.created_at_utc)).toISOString(),
        },
      };
    }

    const existing = await this.pool.query(
      `SELECT * FROM guild_watchlists WHERE guild_id = $1 AND collection_slug = $2 LIMIT 1`,
      [entry.guildId, slug]
    );
    const r = existing.rows[0];
    return {
      added: false,
      entry: {
        id: Number(r.id),
        guildId: String(r.guild_id),
        collectionSlug: String(r.collection_slug),
        projectName: String(r.project_name),
        chainId: r.chain_id ? Number(r.chain_id) : null,
        contractAddress: r.contract_address ? String(r.contract_address) : null,
        addedByUserId: String(r.added_by_user_id),
        createdAtUtc: new Date(String(r.created_at_utc)).toISOString(),
      },
    };
  }

  public async getGuildWatchlist(guildId: string): Promise<WatchlistEntry[]> {
    const res = await this.pool.query(
      `SELECT * FROM guild_watchlists WHERE guild_id = $1 ORDER BY created_at_utc DESC`,
      [guildId]
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      guildId: String(r.guild_id),
      collectionSlug: String(r.collection_slug),
      projectName: String(r.project_name),
      chainId: r.chain_id ? Number(r.chain_id) : null,
      contractAddress: r.contract_address ? String(r.contract_address) : null,
      addedByUserId: String(r.added_by_user_id),
      createdAtUtc: new Date(String(r.created_at_utc)).toISOString(),
    }));
  }

  public async removeWatchlistEntry(guildId: string, collectionSlug: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM guild_watchlists WHERE guild_id = $1 AND LOWER(collection_slug) = LOWER($2)`,
      [guildId, collectionSlug.trim()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  public async scheduleReminderIfNotExists(
    reminder: ScheduledReminder
  ): Promise<{ created: boolean; reminder: ScheduledReminder }> {
    const res = await this.pool.query(
      `INSERT INTO scheduled_reminders (
        id, idempotency_key, guild_id, mint_id, interval_minutes,
        scheduled_for_utc, status, attempt_count, recovered_after_downtime,
        last_error, dispatched_at_utc, created_at_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *`,
      [
        reminder.id,
        reminder.idempotencyKey,
        reminder.guildId,
        reminder.mintId,
        reminder.intervalMinutes,
        reminder.scheduledForUtc,
        reminder.status,
        reminder.attemptCount,
        reminder.recoveredAfterDowntime,
        reminder.lastError,
        reminder.dispatchedAtUtc,
        reminder.createdAtUtc,
      ]
    );

    if (res.rows[0]) {
      return { created: true, reminder: this.mapReminderRow(res.rows[0]) };
    }

    const existing = await this.pool.query(
      `SELECT * FROM scheduled_reminders WHERE idempotency_key = $1 LIMIT 1`,
      [reminder.idempotencyKey]
    );
    return { created: false, reminder: this.mapReminderRow(existing.rows[0]) };
  }

  public async getDuePendingReminders(upToUtc: string): Promise<ScheduledReminder[]> {
    const res = await this.pool.query(
      `SELECT * FROM scheduled_reminders
       WHERE status = 'pending' AND scheduled_for_utc <= $1
       ORDER BY scheduled_for_utc ASC`,
      [upToUtc]
    );
    return res.rows.map((r) => this.mapReminderRow(r));
  }

  public async getAllScheduledReminders(guildId?: string): Promise<ScheduledReminder[]> {
    const res = guildId
      ? await this.pool.query(
          `SELECT * FROM scheduled_reminders WHERE guild_id = $1 ORDER BY scheduled_for_utc ASC`,
          [guildId]
        )
      : await this.pool.query(`SELECT * FROM scheduled_reminders ORDER BY scheduled_for_utc ASC`);
    return res.rows.map((r) => this.mapReminderRow(r));
  }

  public async updateReminderStatus(
    id: string,
    status: ReminderStatus,
    options?: {
      dispatchedAtUtc?: string | null;
      lastError?: string | null;
      recoveredAfterDowntime?: boolean;
      incrementAttempt?: boolean;
    }
  ): Promise<ScheduledReminder | null> {
    const res = await this.pool.query(
      `UPDATE scheduled_reminders
       SET status = $2,
           attempt_count = attempt_count + $3,
           dispatched_at_utc = COALESCE($4, dispatched_at_utc),
           last_error = $5,
           recovered_after_downtime = COALESCE($6, recovered_after_downtime)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        status,
        options?.incrementAttempt ? 1 : 0,
        options?.dispatchedAtUtc ?? null,
        options?.lastError ?? null,
        options?.recoveredAfterDowntime ?? null,
      ]
    );
    return res.rows[0] ? this.mapReminderRow(res.rows[0]) : null;
  }

  private mapFeedSourceRow(row: Record<string, unknown>): DiscoveryFeedSource {
    return {
      url: String(row.url),
      label: String(row.label || 'Custom Mint Website'),
      addedBy: String(row.added_by || 'admin'),
      enabled: Boolean(row.enabled),
      lastPolledUtc: row.last_polled_utc ? new Date(String(row.last_polled_utc)).toISOString() : null,
      lastDiscoveredCount: Number(row.last_discovered_count || 0),
      lastError: row.last_error ? String(row.last_error) : null,
      createdAtUtc: new Date(String(row.created_at_utc)).toISOString(),
    };
  }

  public async getFeedSources(): Promise<DiscoveryFeedSource[]> {
    const res = await this.pool.query(`SELECT * FROM discovery_feed_sources ORDER BY created_at_utc ASC`);
    return res.rows.map((r) => this.mapFeedSourceRow(r));
  }

  public async addFeedSource(url: string, label = 'Custom Mint Website', addedBy = 'admin'): Promise<DiscoveryFeedSource> {
    const cleanUrl = url.trim();
    const res = await this.pool.query(
      `INSERT INTO discovery_feed_sources (url, label, added_by, enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (url) DO UPDATE SET
         label = EXCLUDED.label,
         enabled = TRUE
       RETURNING *`,
      [cleanUrl, label.trim() || 'Custom Mint Website', addedBy]
    );
    return this.mapFeedSourceRow(res.rows[0]);
  }

  public async updateFeedSourceStatus(
    url: string,
    status: { discoveredCount: number; lastError: string | null }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE discovery_feed_sources
       SET last_polled_utc = NOW(),
           last_discovered_count = $2,
           last_error = $3
       WHERE url = $1`,
      [url.trim(), status.discoveredCount, status.lastError]
    );
  }

  public async removeFeedSource(url: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM discovery_feed_sources WHERE url = $1`, [url.trim()]);
    return (res.rowCount ?? 0) > 0;
  }
}

export async function createStorageRepository(): Promise<StorageRepository> {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (
    dbUrl &&
    dbUrl !== 'postgresql://mintpulse:mintpulse_password@localhost:5432/mintpulse' &&
    dbUrl.startsWith('postgres')
  ) {
    try {
      const pgRepo = new PostgresRepository(dbUrl);
      await pgRepo.initialize();
      logger.info('Storage', 'Connected to PostgreSQL database and verified schema migrations');
      return pgRepo;
    } catch (err) {
      logger.warn(
        'Storage',
        'PostgreSQL connection unavailable; falling back to embedded SQL-compatible persistent store',
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  const embedded = new EmbeddedSqlRepository();
  await embedded.initialize();
  logger.info('Storage', 'Initialized persistent SQL-compatible repository (.data/mintpulse-store.json)');
  return embedded;
}
