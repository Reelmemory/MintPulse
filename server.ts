/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * MintPulse Full-Stack Server & Bot Orchestrator
 * Runs:
 * 1. Modular Discovery Engine (OpenSea API v2, Custom Website Adapter, External Calendar Adapter)
 * 2. Persistent Storage (PostgreSQL with Embedded SQL-Compatible Store fallback)
 * 3. Idempotent Reminder Scheduler & Dispatcher Worker
 * 4. Discord.js v14 Gateway Bot (when DISCORD_BOT_TOKEN & DISCORD_CLIENT_ID are configured)
 * 5. Express REST API & Vite Frontend Dashboard
 */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createServer as createViteServer } from 'vite';
import { chainRegistry } from './src/core/chains.ts';
import { DiscordBotRuntime, buildDiscordSlashCommandDefinitions } from './src/core/discord/botClient.ts';
import { DiscordCommandProcessor } from './src/core/discord/commandHandler.ts';
import { DiscoveryEngine } from './src/core/discovery/adapterInterface.ts';
import { ExternalCalendarFeedAdapter } from './src/core/discovery/calendarApiAdapter.ts';
import { CustomWebsiteDiscoveryAdapter, parseCustomMintPayload } from './src/core/discovery/customWebsiteAdapter.ts';
import { OpenSeaDiscoveryAdapter } from './src/core/discovery/openSeaAdapter.ts';
import { logger } from './src/core/logger.ts';
import { ReminderEngine } from './src/core/scheduler/reminderEngine.ts';
import { safeFetchExternalUrl, validateExternalUrl } from './src/core/security/ssrfGuard.ts';
import { createStorageRepository } from './src/core/storage/database.ts';
import { runAutomatedTestSuite } from './src/core/tests/testSuite.ts';
import { COMMON_IANA_TIMEZONES } from './src/core/timezone/timezoneService.ts';
import { RawDiscoveredMint, SlashCommandInvocation } from './src/core/types.ts';
import { verifyAndNormalizeMint } from './src/core/verification/mintVerifier.ts';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // 1. Initialize Storage Repository
  const storage = await createStorageRepository();

  // Ensure two isolated default Discord guilds exist for immediate multi-server simulation
  const existingGuilds = await storage.getAllGuildSettings();
  if (existingGuilds.length === 0) {
    const g1 = await storage.getGuildSettings('109283746510293847', 'ETH Alpha Collective');
    await storage.saveGuildSettings({
      ...g1,
      announcementChannelId: '998877665544332211',
      announcementChannelName: 'nft-mint-alerts',
      pingRoleId: '776655443322110099',
      pingRoleName: 'Mint-Ping',
      timezone: 'America/New_York',
      enabledCategories: ['free', 'allowlist', 'public'],
      reminderIntervalsMinutes: [1440, 60, 15],
      channelStatus: 'active',
    });

    const g2 = await storage.getGuildSettings('204958673829104958', 'Tokyo Onchain Builders');
    await storage.saveGuildSettings({
      ...g2,
      announcementChannelId: '887766554433221100',
      announcementChannelName: 'drop-schedule',
      pingRoleId: null,
      pingRoleName: null,
      timezone: 'Asia/Tokyo',
      enabledCategories: ['free', 'public'],
      reminderIntervalsMinutes: [60, 15],
      channelStatus: 'active',
    });
  }

  // 2. Initialize Reminder Engine & Command Processor
  const reminderEngine = new ReminderEngine({ storage });
  const commandProcessor = new DiscordCommandProcessor(storage, reminderEngine);

  // 3. Initialize Modular Discovery Engine
  const customWebsiteAdapter = new CustomWebsiteDiscoveryAdapter({ storage });
  const initialDbSources = await storage.getFeedSources();
  customWebsiteAdapter.setCachedDbUrls(initialDbSources.filter((s) => s.enabled).map((s) => s.url));

  const discoveryEngine = new DiscoveryEngine();
  discoveryEngine.registerAdapter(new OpenSeaDiscoveryAdapter());
  discoveryEngine.registerAdapter(customWebsiteAdapter);
  discoveryEngine.registerAdapter(new ExternalCalendarFeedAdapter());

  // 4. Initialize Discord.js v14 Bot Runtime & Initial Discovery Cycle asynchronously
  // so HTTP server binds port 3000 without waiting on external network calls
  const discordBot = new DiscordBotRuntime(commandProcessor, reminderEngine);
  void (async () => {
    await discordBot.startIfConfigured();
    const cycle = await discoveryEngine.runDiscoveryCycle();
    for (const mint of cycle.normalizedMints) {
      await storage.upsertMint(mint);
    }
    await reminderEngine.syncSchedulesForAllGuilds();
  })();

  // Background scheduler worker loop (every 30s) & periodic website discovery sync
  const pollSeconds = Number(process.env.SCHEDULER_POLL_SECONDS) || 30;
  let tickCounter = 0;
  setInterval(async () => {
    try {
      tickCounter++;
      if (tickCounter % 10 === 0) {
        // Every ~5 minutes, poll connected website sources & discovery adapters for new upcoming mints
        const cycle = await discoveryEngine.runDiscoveryCycle();
        for (const mint of cycle.normalizedMints) {
          await storage.upsertMint(mint);
        }
      }
      await reminderEngine.syncSchedulesForAllGuilds();
      await reminderEngine.processDueReminders();
    } catch (err) {
      logger.error('SchedulerWorker', 'Background reminder cycle error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, pollSeconds * 1000);

  // ============================================================================
  // REST API Endpoints
  // ============================================================================

  app.get('/api/health', async (_req, res) => {
    const mints = await storage.getAllMints();
    const guilds = await storage.getAllGuildSettings();
    const reminders = await storage.getAllScheduledReminders();

    res.json({
      status: 'healthy',
      service: 'mintpulse-discord-nft-mint-bot',
      scope: 'nft-mints-only',
      timestampUtc: new Date().toISOString(),
      storageMode: storage.mode,
      discordGateway: discordBot.getStatus(),
      counts: {
        chains: chainRegistry.getEnabledChains().length,
        mints: mints.length,
        guilds: guilds.length,
        pendingReminders: reminders.filter((r) => r.status === 'pending').length,
        sentReminders: reminders.filter((r) => r.status === 'sent').length,
      },
      adapters: discoveryEngine.getAdapterReports(),
    });
  });

  app.get('/api/state', async (_req, res) => {
    const guilds = await storage.getAllGuildSettings();
    const watchlistsByGuild: Record<string, unknown> = {};
    for (const g of guilds) {
      watchlistsByGuild[g.guildId] = await storage.getGuildWatchlist(g.guildId);
    }

    const feedSources = await storage.getFeedSources();
    customWebsiteAdapter.setCachedDbUrls(feedSources.filter((s) => s.enabled).map((s) => s.url));

    res.json({
      serverTimeUtc: new Date().toISOString(),
      storageMode: storage.mode,
      discordGateway: discordBot.getStatus(),
      chains: chainRegistry.getEnabledChains(),
      timezones: COMMON_IANA_TIMEZONES,
      adapters: discoveryEngine.getAdapterReports(),
      feedSources,
      slashCommandDefinitions: buildDiscordSlashCommandDefinitions(),
      mints: await storage.getAllMints(),
      guilds,
      watchlistsByGuild,
      scheduledReminders: await storage.getAllScheduledReminders(),
      dispatchedNotifications: reminderEngine.getDispatchedHistory(),
      logs: logger.getRecentLogs(60),
    });
  });

  app.post('/api/discord/command', async (req, res) => {
    try {
      const invocation = req.body as SlashCommandInvocation;
      logger.info('SlashCommand', `Executing /${invocation.commandName}${invocation.subcommand ? ' ' + invocation.subcommand : ''}`, {
        guildId: invocation.guildId,
        userTag: invocation.userTag,
        hasManageGuildPermission: invocation.hasManageGuildPermission,
      });

      const result = await commandProcessor.executeCommand(invocation);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('SlashCommand', 'Command execution error', { error: msg });
      res.status(500).json({
        ephemeral: true,
        success: false,
        errorCode: 'INTERNAL_ERROR',
        embeds: [],
        content: msg,
      });
    }
  });

  app.get('/api/migration-sql', (_req, res) => {
    try {
      const migrationPath = path.resolve(process.cwd(), 'migrations', '001_initial_schema.sql');
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      res.json({ sql });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read migration SQL file' });
    }
  });

  app.post('/api/database/test-connection', async (req, res) => {
    const { connectionString } = req.body as { connectionString?: string };
    if (!connectionString || typeof connectionString !== 'string') {
      res.status(400).json({ success: false, message: 'Connection string is required.' });
      return;
    }

    const trimmed = connectionString.trim();
    if (!trimmed.startsWith('postgres://') && !trimmed.startsWith('postgresql://')) {
      res.status(400).json({
        success: false,
        message: 'Invalid URI scheme. Supabase connection strings start with postgresql:// or postgres://',
      });
      return;
    }

    const testPool = new (pg as unknown as { Pool: typeof pg.Pool }).Pool({
      connectionString: trimmed,
      max: 1,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 1000,
    });

    try {
      const client = await testPool.connect();
      try {
        const result = await client.query('SELECT version(), current_database(), current_user;');
        const versionStr = String(result.rows[0]?.version || 'PostgreSQL');
        const dbName = String(result.rows[0]?.current_database || 'postgres');
        const isSupabase = versionStr.toLowerCase().includes('supabase') || trimmed.includes('supabase.co');

        res.json({
          success: true,
          message: `Successfully connected to ${isSupabase ? 'Supabase ' : ''}PostgreSQL database "${dbName}".`,
          version: versionStr.split(' on ')[0],
          database: dbName,
        });
      } finally {
        client.release();
        await testPool.end();
      }
    } catch (err) {
      await testPool.end().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      res.json({
        success: false,
        message: `Connection failed: ${msg}. (Make sure to replace [YOUR-PASSWORD] with your actual Supabase database password).`,
      });
    }
  });

  app.post('/api/discover/run', async (_req, res) => {
    const dbSources = await storage.getFeedSources();
    customWebsiteAdapter.setCachedDbUrls(dbSources.filter((s) => s.enabled).map((s) => s.url));
    const cycle = await discoveryEngine.runDiscoveryCycle();
    for (const mint of cycle.normalizedMints) {
      await storage.upsertMint(mint);
    }
    const sync = await reminderEngine.syncSchedulesForAllGuilds();
    res.json({
      discoveredCount: cycle.normalizedMints.length,
      rejectedCount: cycle.rejectedCount,
      newlyScheduledReminders: sync.newlyScheduledCount,
      reports: cycle.reports,
      feedSources: await storage.getFeedSources(),
    });
  });

  app.post('/api/sources/add', async (req, res) => {
    const { url, label } = req.body as { url?: string; label?: string };
    const validation = await validateExternalUrl(url ?? '', { performDnsLookup: true });
    if (!validation.valid || !validation.normalizedUrl) {
      res.status(400).json({
        success: false,
        message: validation.reason || 'Invalid or unsafe website URL.',
      });
      return;
    }

    const normalizedUrl = validation.normalizedUrl;
    await storage.addFeedSource(normalizedUrl, label || 'Custom Mint Website', 'dashboard-admin');
    const allSources = await storage.getFeedSources();
    customWebsiteAdapter.setCachedDbUrls(allSources.filter((s) => s.enabled).map((s) => s.url));

    let importedCount = 0;
    let fetchError: string | null = null;
    try {
      const response = await safeFetchExternalUrl(normalizedUrl, { timeoutMs: 8000 });
      if (response.status === 200) {
        const parsed = parseCustomMintPayload(response.bodyText, response.finalUrl);
        for (const raw of parsed) {
          const verified = await verifyAndNormalizeMint(raw, { performDnsLookup: false });
          if (verified.valid && verified.mint) {
            await storage.upsertMint(verified.mint);
            importedCount++;
          }
        }
        await storage.updateFeedSourceStatus(normalizedUrl, {
          discoveredCount: importedCount,
          lastError: null,
        });
      } else {
        fetchError = `HTTP ${response.status}`;
        await storage.updateFeedSourceStatus(normalizedUrl, {
          discoveredCount: 0,
          lastError: fetchError,
        });
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
      await storage.updateFeedSourceStatus(normalizedUrl, {
        discoveredCount: 0,
        lastError: fetchError,
      });
    }

    const sync = await reminderEngine.syncSchedulesForAllGuilds();
    res.json({
      success: true,
      url: normalizedUrl,
      importedCount,
      fetchError,
      sync,
      feedSources: await storage.getFeedSources(),
    });
  });

  app.post('/api/sources/remove', async (req, res) => {
    const { url } = req.body as { url?: string };
    if (!url) {
      res.status(400).json({ success: false, message: 'URL is required' });
      return;
    }
    const removed = await storage.removeFeedSource(url);
    const allSources = await storage.getFeedSources();
    customWebsiteAdapter.setCachedDbUrls(allSources.filter((s) => s.enabled).map((s) => s.url));
    res.json({
      success: removed,
      feedSources: allSources,
    });
  });

  app.post('/api/url/validate', async (req, res) => {
    const { url, fetchMetadata, sampleHtml } = req.body as {
      url?: string;
      fetchMetadata?: boolean;
      sampleHtml?: string;
    };

    const validation = await validateExternalUrl(url ?? '', { performDnsLookup: true });
    if (!validation.valid || !validation.normalizedUrl) {
      logger.warn('SSRFGuard', `Blocked unsafe or private URL: ${url}`, {
        reason: validation.reason,
      });
      res.json({
        validation,
        extractedMints: [],
      });
      return;
    }

    let extractedMints: RawDiscoveredMint[] = [];
    let fetchError: string | undefined;

    if (sampleHtml && sampleHtml.trim()) {
      extractedMints = parseCustomMintPayload(sampleHtml, validation.normalizedUrl);
    } else if (fetchMetadata) {
      try {
        const fetched = await safeFetchExternalUrl(validation.normalizedUrl, { timeoutMs: 6000 });
        extractedMints = parseCustomMintPayload(fetched.bodyText, fetched.finalUrl);
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
      }
    }

    res.json({
      validation,
      extractedMints,
      fetchError,
    });
  });

  app.post('/api/mints/verify-toggle', async (req, res) => {
    const { mintId, verified, contractAddress, priceExact } = req.body as {
      mintId: string;
      verified: boolean;
      contractAddress?: string;
      priceExact?: string;
    };

    const existing = await storage.getMintById(mintId);
    if (!existing) {
      res.status(404).json({ error: 'Mint not found' });
      return;
    }

    const nextContract =
      contractAddress && chainRegistry.isValidEvmAddress(contractAddress)
        ? contractAddress.trim()
        : existing.contractAddress;

    const nextPrice =
      priceExact !== undefined && priceExact.trim() !== '' ? priceExact.trim() : existing.mintPriceExact;

    const updated = await storage.upsertMint({
      ...existing,
      contractAddress: nextContract,
      mintPriceExact: nextPrice,
      verificationStatus: verified ? 'verified' : 'unverified',
      verificationNotes: verified
        ? 'Verified by server moderator / contract audit'
        : 'Marked as unverified — pending independent verification',
    });

    const sync = await reminderEngine.syncSchedulesForAllGuilds();
    res.json({ mint: updated, sync });
  });

  app.post('/api/mints/edit', async (req, res) => {
    const {
      mintId,
      projectName,
      twitterHandle,
      totalSupply,
      chainId,
      mintStartUtc,
      category,
      mintPriceExact,
      sourceUrl,
    } = req.body as {
      mintId: string;
      projectName?: string;
      twitterHandle?: string;
      totalSupply?: string;
      chainId?: number;
      mintStartUtc?: string;
      category?: 'free' | 'allowlist' | 'public';
      mintPriceExact?: string | null;
      sourceUrl?: string;
    };

    const existing = await storage.getMintById(mintId);
    if (!existing) {
      res.status(404).json({ error: 'Mint not found' });
      return;
    }

    const startChanged = mintStartUtc && mintStartUtc !== existing.mintStartUtc;
    const updated = await storage.updateMintById(mintId, {
      projectName: projectName ?? existing.projectName,
      collectionName: projectName ?? existing.collectionName,
      twitterHandle: twitterHandle !== undefined ? twitterHandle : existing.twitterHandle,
      totalSupply: totalSupply !== undefined ? totalSupply : existing.totalSupply,
      chainId: chainId ? Number(chainId) : existing.chainId,
      mintStartUtc: mintStartUtc ? new Date(mintStartUtc).toISOString() : existing.mintStartUtc,
      category: category ?? existing.category,
      mintPriceExact: mintPriceExact !== undefined ? mintPriceExact : existing.mintPriceExact,
      sourceUrl: sourceUrl ?? existing.sourceUrl,
      websiteUrl: sourceUrl ?? existing.websiteUrl,
    });

    if (startChanged) {
      await storage.deletePendingRemindersForMint(mintId);
    }
    const sync = await reminderEngine.syncSchedulesForAllGuilds();
    res.json({ mint: updated, sync });
  });

  app.post('/api/mints/delete', async (req, res) => {
    const { mintId } = req.body as { mintId: string };
    const existing = await storage.getMintById(mintId);
    if (!existing) {
      res.status(404).json({ error: 'Mint not found' });
      return;
    }
    await storage.deleteMintById(mintId);
    res.json({ deleted: true, mintId, projectName: existing.projectName });
  });

  app.post('/api/reminders/sync', async (_req, res) => {
    const sync = await reminderEngine.syncSchedulesForAllGuilds();
    const dispatch = await reminderEngine.processDueReminders();
    res.json({ sync, dispatch });
  });

  app.post('/api/reminders/daily-digest', async (req, res) => {
    const { guildId } = req.body as { guildId: string };
    if (!guildId) {
      res.status(400).json({ success: false, message: 'guildId is required' });
      return;
    }
    const outcome = await reminderEngine.triggerDailyDigestNow(guildId);
    res.json(outcome);
  });

  app.post('/api/reminders/trigger', async (req, res) => {
    const { reminderId } = req.body as { reminderId: string };
    const outcome = await reminderEngine.triggerSingleReminderNow(reminderId);
    res.json(outcome);
  });

  app.post('/api/chains/register', async (req, res) => {
    const { chainId, slug, name, nativeSymbol, explorerUrl, openSeaChainIdentifier } = req.body as {
      chainId: number;
      slug: string;
      name: string;
      nativeSymbol: string;
      explorerUrl: string;
      openSeaChainIdentifier?: string;
    };

    if (!chainId || !slug || !name || !nativeSymbol || !explorerUrl) {
      res.status(400).json({ error: 'All chain fields (chainId, slug, name, nativeSymbol, explorerUrl) are required.' });
      return;
    }

    chainRegistry.registerChain({
      chainId: Number(chainId),
      slug,
      name,
      nativeSymbol,
      explorerUrl,
      openSeaChainIdentifier,
      isEnabled: true,
    });

    logger.info('ChainRegistry', `Registered EVM chain ${name} (${chainId})`);
    res.json({ chains: chainRegistry.getEnabledChains() });
  });

  app.post('/api/sandbox/seed-test-fixtures', async (_req, res) => {
    const now = new Date();
    const addHours = (h: number) => new Date(now.getTime() + h * 3600 * 1000).toISOString();

    const sandboxFixtures: RawDiscoveredMint[] = [
      {
        projectName: 'ComputersRh',
        collectionName: 'ComputersRh',
        collectionSlug: 'computersrh-nft',
        twitterHandle: '@ComputersRh',
        totalSupply: '3333',
        chainId: 747474,
        contractAddress: '0x2335022c740d17c2837f9C884Bfe4fFdbf0A95D5',
        mintStartIso: addHours(0.9), // ~54 minutes from now
        originalTimezone: 'UTC',
        category: 'free',
        mintPriceExact: '0',
        mintPriceSymbol: 'ETH',
        websiteUrl: 'https://opensea.io/collection/computersrh-nft/overview',
        sourceUrl: 'https://opensea.io/collection/computersrh-nft/overview',
        discoverySource: 'sandbox_test_fixture',
        verificationStatus: 'verified',
        verificationNotes: 'Sandbox fixture on Robinhood Chain — Free mint (Supply: 3333)',
      },
      {
        projectName: 'Unknowns_RH',
        collectionName: 'Unknowns 1111',
        collectionSlug: 'unknowns-1111',
        twitterHandle: '@Unknowns_RH',
        totalSupply: '1111',
        chainId: 747474,
        contractAddress: '0xBa5e05cb26b78eDa3A2f8e3b3814726305dcAc83',
        mintStartIso: addHours(2.2), // Today
        originalTimezone: 'UTC',
        category: 'public',
        mintPriceExact: '0.0004',
        mintPriceSymbol: 'ETH',
        websiteUrl: 'https://opensea.io/collection/unknowns-1111/overview',
        sourceUrl: 'https://opensea.io/collection/unknowns-1111/overview',
        discoverySource: 'sandbox_test_fixture',
        verificationStatus: 'verified',
        verificationNotes: 'Sandbox fixture on Robinhood Chain — 0.0004 ETH (Supply: 1111)',
      },
      {
        projectName: 'InkGenesis',
        collectionName: 'Ink Chain Genesis Citizens',
        collectionSlug: 'ink-genesis-citizens',
        twitterHandle: '@InkOnchainNFT',
        totalSupply: '2222',
        chainId: 57073,
        contractAddress: '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270',
        mintStartIso: addHours(4.5), // Today
        originalTimezone: 'UTC',
        category: 'allowlist',
        mintPriceExact: '0.001',
        mintPriceSymbol: 'ETH',
        websiteUrl: 'https://opensea.io/collection/ink-genesis-citizens/overview',
        sourceUrl: 'https://opensea.io/collection/ink-genesis-citizens/overview',
        discoverySource: 'sandbox_test_fixture',
        verificationStatus: 'verified',
        verificationNotes: 'Sandbox fixture on Ink Chain — Allowlist mint (Supply: 2222)',
      },
      {
        projectName: 'EthCuratedArt',
        collectionName: 'Ethereum Curated Generative',
        collectionSlug: 'ethereum-curated-generative',
        twitterHandle: '@EthCuratedArt',
        totalSupply: '500',
        chainId: 1,
        contractAddress: '0x1111111111111111111111111111111111111111',
        mintStartIso: addHours(18),
        originalTimezone: 'UTC',
        category: 'public',
        mintPriceExact: '0.025',
        mintPriceSymbol: 'ETH',
        websiteUrl: 'https://opensea.io/collection/ethereum-curated-generative/overview',
        sourceUrl: 'https://opensea.io/collection/ethereum-curated-generative/overview',
        discoverySource: 'sandbox_test_fixture',
        verificationStatus: 'verified',
        verificationNotes: 'Sandbox fixture on Ethereum Mainnet — Public mint (Supply: 500)',
      },
    ];

    let insertedCount = 0;
    for (const raw of sandboxFixtures) {
      const outcome = await verifyAndNormalizeMint(raw);
      if (outcome.valid && outcome.mint) {
        await storage.upsertMint(outcome.mint);
        insertedCount++;
      }
    }

    const sync = await reminderEngine.syncSchedulesForAllGuilds();
    const dispatch = await reminderEngine.processDueReminders();

    logger.info('Sandbox', `Loaded ${insertedCount} explicit test fixtures into simulator store`);
    res.json({
      insertedCount,
      sync,
      dispatch,
    });
  });

  app.post('/api/tests/run', async (_req, res) => {
    const summary = await runAutomatedTestSuite();
    res.json(summary);
  });

  // ============================================================================
  // Vite Middleware (Development) or Static Assets (Production)
  // ============================================================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    logger.info('Server', `MintPulse server & bot worker listening on http://0.0.0.0:${port}`);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error('Server', 'Unhandled Promise Rejection (recovered)', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Server', 'Uncaught Exception (recovered)', {
    error: err instanceof Error ? err.message : String(err),
  });
});

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

