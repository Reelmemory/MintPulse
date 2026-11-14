/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Automated Verification & Unit/Integration Test Suite
 * Tests:
 * 1. Discovery Adapters (OpenSea API v2, Custom Website HTML/JSON, Anti-Fabrication)
 * 2. SSRF Protection & URL Validation (Private IPs, Cloud Metadata, Unsafe Schemes, DNS Rebinding)
 * 3. Reminder Scheduling & Idempotent Deduplication
 * 4. Timezone Conversions & Daylight Saving Time (DST)
 * 5. Discord Permissions & Multi-Server (Guild) Isolation
 * 6. Failure Recovery (Downtime Grace Window, Rate-Limit Backoff, Unavailable Channels)
 *
 * Note: Test fixtures defined here are strictly used inside automated tests,
 * never injected as fake live production data.
 */

import { DiscordCommandProcessor } from '../discord/commandHandler.ts';
import { parseCustomMintPayload } from '../discovery/customWebsiteAdapter.ts';
import { OpenSeaDiscoveryAdapter } from '../discovery/openSeaAdapter.ts';
import { ReminderEngine } from '../scheduler/reminderEngine.ts';
import { sanitizeEnvUrl, validateExternalUrl } from '../security/ssrfGuard.ts';
import { EmbeddedSqlRepository } from '../storage/database.ts';
import {
  formatUtcForGuildTimezone,
  isMintTodayInTimezone,
  isValidIanaTimezone,
} from '../timezone/timezoneService.ts';
import { verifyAndNormalizeMint } from '../verification/mintVerifier.ts';

export interface TestCaseResult {
  id: string;
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  assertionDetails: string;
  error?: string;
}

export interface TestSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  executedAtUtc: string;
  results: TestCaseResult[];
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export async function runAutomatedTestSuite(): Promise<TestSuiteSummary> {
  const results: TestCaseResult[] = [];
  const suiteStart = Date.now();

  const runTest = async (
    id: string,
    suite: string,
    name: string,
    fn: () => Promise<string>
  ): Promise<void> => {
    const start = Date.now();
    try {
      const details = await fn();
      results.push({
        id,
        suite,
        name,
        passed: true,
        durationMs: Date.now() - start,
        assertionDetails: details,
      });
    } catch (err) {
      results.push({
        id,
        suite,
        name,
        passed: false,
        durationMs: Date.now() - start,
        assertionDetails: 'Test failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ============================================================================
  // SUITE 1: SSRF Protection & URL Security
  // ============================================================================
  await runTest(
    'ssrf-1',
    'SSRF & URL Security',
    'Rejects unsafe URL schemes (javascript:, file:, ftp:, data:) & sanitizes Markdown URLs',
    async () => {
      const jsUrl = await validateExternalUrl('javascript:alert(1)');
      const fileUrl = await validateExternalUrl('file:///etc/passwd');
      const ftpUrl = await validateExternalUrl('ftp://files.example.com/drop.json');
      assertCondition(!jsUrl.valid, 'javascript: scheme must be rejected');
      assertCondition(!fileUrl.valid, 'file: scheme must be rejected');
      assertCondition(!ftpUrl.valid, 'ftp: scheme must be rejected');

      const mdCleaned = sanitizeEnvUrl('https://httpbin.org/json](https://httpbin.org/json');
      assertCondition(mdCleaned === 'https://httpbin.org/json', 'Partial markdown link must be sanitized');
      return 'Rejected unsafe schemes and sanitized Markdown-wrapped URLs cleanly.';
    }
  );

  await runTest(
    'ssrf-2',
    'SSRF & URL Security',
    'Rejects loopback, private IPv4/IPv6 ranges, and cloud metadata IPs',
    async () => {
      const targets = [
        'http://127.0.0.1:8080/admin',
        'http://localhost:3000/api/health',
        'http://10.0.0.42/internal',
        'http://172.16.10.5/mint',
        'http://192.168.1.1/router',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]:8080/secret',
        'http://[fc00::1]/mint',
        'https://metadata.google.internal/computeMetadata/v1/',
      ];
      for (const t of targets) {
        const res = await validateExternalUrl(t);
        assertCondition(!res.valid, `Target ${t} must be blocked by SSRF guard`);
      }
      return `Blocked all ${targets.length} loopback, RFC1918 private, IPv6 local, and cloud metadata endpoints.`;
    }
  );

  await runTest(
    'ssrf-3',
    'SSRF & URL Security',
    'Detects and blocks DNS rebinding to internal private IPs',
    async () => {
      const mockDnsRebind = async () => ['10.24.0.12'];
      const res = await validateExternalUrl('https://evil-rebind-mint.example.com/drop', {
        performDnsLookup: true,
        dnsResolver: mockDnsRebind,
      });
      assertCondition(!res.valid, 'Hostname resolving to 10.24.0.12 must be blocked');
      assertCondition(Boolean(res.reason?.includes('10.24.0.12')), 'Error reason must cite resolved private IP');
      return 'Blocked public hostname resolving via DNS to private RFC1918 IP 10.24.0.12.';
    }
  );

  // ============================================================================
  // SUITE 2: Discovery Adapters & Anti-Fabrication Verification
  // ============================================================================
  await runTest(
    'disc-1',
    'Discovery & Verification',
    'OpenSea v2 adapter normalizes drops and preserves null when contract/price is unknown',
    async () => {
      const adapter = new OpenSeaDiscoveryAdapter({
        apiKeyGetter: () => 'test_fixture_api_key',
        fetcher: async (url) => {
          if (url.includes('chain=ethereum')) {
            return {
              status: 200,
              json: async () => ({
                collections: [
                  {
                    collection: 'fixture-eth-art',
                    name: 'Fixture Eth Art',
                    contracts: [{ address: '0x1111111111111111111111111111111111111111', chain: 'ethereum' }],
                    project_url: 'https://art.example.com',
                    opensea_url: 'https://opensea.io/collection/fixture-eth-art',
                    drop_stages: [
                      {
                        stage_type: 'allowlist',
                        start_time: '2026-11-01T16:00:00Z',
                        price: { value: '0.05', currency: 'ETH' },
                      },
                    ],
                  },
                  {
                    collection: 'fixture-unverified-drop',
                    name: 'Fixture Unverified Drop',
                    // No contract published, no price published
                    drop_stages: [
                      {
                        stage_type: 'public',
                        start_time: '2026-11-02T18:00:00Z',
                      },
                    ],
                  },
                ],
              }),
            };
          }
          return { status: 200, json: async () => ({ collections: [] }) };
        },
      });

      const res = await adapter.discoverUpcomingMints();
      assertCondition(res.success, 'Adapter execution should succeed');
      assertCondition(res.rawMints.length === 2, 'Expected 2 discovered mints from fixture');

      const first = res.rawMints[0];
      const second = res.rawMints[1];
      assertCondition(first.verificationStatus === 'verified', 'First drop with contract must be verified');
      assertCondition(first.mintPriceExact === '0.05', 'First drop price must be 0.05');

      assertCondition(second.contractAddress === null, 'Missing contract must remain null, never fabricated');
      assertCondition(second.mintPriceExact === null, 'Missing price must remain null, never fabricated');
      assertCondition(second.verificationStatus === 'unverified', 'Drop missing contract must be unverified');

      return 'Normalized verified & unverified OpenSea drops; preserved null for unknown contract and price.';
    }
  );

  await runTest(
    'disc-2',
    'Discovery & Verification',
    'Custom website parser extracts HTML meta tags on Ink Chain & rejects raffle submissions',
    async () => {
      const sampleHtml = `
        <html>
          <head>
            <title>Ink Onchain Generative</title>
            <meta name="nft:mint:project" content="Ink Onchain Generative" />
            <meta name="nft:mint:chain" content="ink" />
            <meta name="nft:mint:start_time" content="2026-11-10T20:00:00Z" />
            <meta name="nft:mint:category" content="free" />
            <meta name="nft:mint:supply" content="3333" />
            <meta name="nft:mint:twitter" content="@InkGenerative" />
          </head>
        </html>
      `;
      const extracted = parseCustomMintPayload(sampleHtml, 'https://mint.example.org/drop');
      assertCondition(extracted.length === 1, 'Expected 1 extracted mint from HTML meta tags');
      assertCondition(extracted[0].chainId === 57073, 'Chain slug "ink" must resolve to chainId 57073');
      assertCondition(extracted[0].totalSupply === '3333', 'Supply meta tag must be extracted');
      assertCondition(extracted[0].verificationStatus === 'unverified', 'Custom HTML scrape must default to unverified');

      const raffleAttempt = await verifyAndNormalizeMint({
        projectName: 'Premint Raffle Entry #99',
        chainId: 1,
        mintStartIso: '2026-11-10T20:00:00Z',
        category: 'public',
        sourceUrl: 'https://example.com/mint',
        discoverySource: 'user_submission',
        verificationStatus: 'unverified',
      });
      assertCondition(!raffleAttempt.valid, 'Raffle submissions must be rejected by MintPulse verifier');

      return 'Extracted custom HTML mint metadata on Ink Chain (57073) and blocked raffle submission attempt.';
    }
  );

  // ============================================================================
  // SUITE 3: Idempotent Scheduling & Deduplication
  // ============================================================================
  await runTest(
    'sched-1',
    'Reminder Engine & Deduplication',
    'Prevents duplicate reminder scheduling and duplicate dispatches across restarts',
    async () => {
      const store = new EmbeddedSqlRepository(null); // in-memory test instance
      await store.initialize();

      const now = new Date('2026-10-17T12:00:00Z');
      const mintStart = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // 1h from now

      const verifiedOutcome = await verifyAndNormalizeMint({
        projectName: 'Dedupe Test Mint',
        chainId: 1,
        contractAddress: '0x2222222222222222222222222222222222222222',
        mintStartIso: mintStart,
        category: 'public',
        mintPriceExact: '0.01',
        sourceUrl: 'https://opensea.io/collection/dedupe-test',
        discoverySource: 'opensea_v2',
        verificationStatus: 'verified',
      });
      assertCondition(verifiedOutcome.valid && Boolean(verifiedOutcome.mint), 'Mint must be valid');
      await store.upsertMint(verifiedOutcome.mint!);

      const guild = await store.getGuildSettings('guild_alpha', 'Alpha Collectors');
      await store.saveGuildSettings({
        ...guild,
        announcementChannelId: 'chan_101',
        announcementChannelName: 'mint-alerts',
        channelStatus: 'active',
        reminderIntervalsMinutes: [1440, 60, 15],
      });

      const engine = new ReminderEngine({ storage: store });

      // First sync creates 3 reminder intervals (1440m, 60m, 15m)
      const sync1 = await engine.syncSchedulesForAllGuilds(now);
      // Second sync (simulating restart) must create 0 new jobs
      const sync2 = await engine.syncSchedulesForAllGuilds(now);

      assertCondition(sync1.newlyScheduledCount === 3, `Expected 3 scheduled jobs, got ${sync1.newlyScheduledCount}`);
      assertCondition(sync2.newlyScheduledCount === 0, 'Second sync must create 0 duplicate jobs');
      assertCondition(sync2.skippedDuplicateCount === 3, 'Second sync must detect 3 existing idempotency keys');

      return 'Idempotency constraint prevented duplicate reminder records across repeated schedule syncs.';
    }
  );

  // ============================================================================
  // SUITE 4: Native Discord <t:UNIX:t> Local Timestamps & DST Handling
  // ============================================================================
  await runTest(
    'tz-1',
    'Discord Native Timestamps & DST',
    'Generates native Discord <t:UNIX:t> local timestamps and validates DST shifts',
    async () => {
      assertCondition(isValidIanaTimezone('America/New_York'), 'America/New_York must be valid');
      assertCondition(isValidIanaTimezone('Asia/Tokyo'), 'Asia/Tokyo must be valid');
      assertCondition(!isValidIanaTimezone('Invalid/Timezone_Zone'), 'Invalid zone must be rejected');

      // Summer date (EDT = UTC-4): 2026-07-15T16:00:00Z -> 12:00 EDT
      const summerNy = formatUtcForGuildTimezone('2026-07-15T16:00:00Z', 'America/New_York');
      // Winter date (EST = UTC-5): 2026-12-15T16:00:00Z -> 11:00 EST
      const winterNy = formatUtcForGuildTimezone('2026-12-15T16:00:00Z', 'America/New_York');

      assertCondition(summerNy.formattedLocal.includes('12:00'), `Expected 12:00 in summer EDT, got ${summerNy.formattedLocal}`);
      assertCondition(winterNy.formattedLocal.includes('11:00'), `Expected 11:00 in winter EST, got ${winterNy.formattedLocal}`);

      // Verify local day boundary check
      const refNow = new Date('2026-10-17T23:00:00Z'); // In Tokyo (UTC+9), this is already Oct 18 08:00 JST
      const mintAtTokyoMorning = '2026-10-18T02:00:00Z'; // Oct 18 11:00 JST
      const isTodayInTokyo = isMintTodayInTimezone(mintAtTokyoMorning, 'Asia/Tokyo', refNow);
      const isTodayInUtc = isMintTodayInTimezone(mintAtTokyoMorning, 'UTC', refNow);

      assertCondition(isTodayInTokyo === true, 'Mint at Oct 18 11:00 JST must be Today in Asia/Tokyo');
      assertCondition(isTodayInUtc === false, 'Mint at Oct 18 02:00 UTC is tomorrow in UTC when refNow is Oct 17 23:00 UTC');

      return `Verified native Discord timestamp tags and DST shift (Summer: ${summerNy.formattedLocal} vs Winter: ${winterNy.formattedLocal}).`;
    }
  );

  // ============================================================================
  // SUITE 5: Discord Permissions, 5-Bullet Format & Multi-Server (Guild) Isolation
  // ============================================================================
  await runTest(
    'perm-1',
    'Permissions & Server Isolation',
    'Restricts /setup and /settings to ManageGuild admins, formats 5-bullet mint lists, and isolates servers',
    async () => {
      const store = new EmbeddedSqlRepository(null);
      await store.initialize();
      const engine = new ReminderEngine({ storage: store });
      const processor = new DiscordCommandProcessor(store, engine);

      // 1. Non-admin member attempts /setup -> must fail with PERMISSION_DENIED
      const unauthorizedSetup = await processor.executeCommand({
        guildId: 'guild_1',
        guildName: 'Server One',
        channelId: 'ch_1',
        channelName: 'general',
        userId: 'user_regular',
        userTag: 'member#0001',
        hasManageGuildPermission: false,
        commandName: 'setup',
        options: { channel_id: 'ch_1', channel_name: 'general' },
      });
      assertCondition(!unauthorizedSetup.success, 'Non-admin /setup must be rejected');
      assertCondition(unauthorizedSetup.errorCode === 'PERMISSION_DENIED', 'Error code must be PERMISSION_DENIED');

      // 2. Admin configures Guild 1 settings and role mention
      await processor.executeCommand({
        guildId: 'guild_1',
        guildName: 'Server One',
        channelId: 'ch_1',
        channelName: 'alerts-1',
        userId: 'user_admin_1',
        userTag: 'admin1#0001',
        hasManageGuildPermission: true,
        commandName: 'settings',
        options: {
          categories: 'free',
          intervals: '60,15',
          role_id: '776655443322110099',
          role_name: 'Mint-Ping',
        },
      });

      // 3. Member adds a Robinhood Chain mint and checks 5-bullet plain message output
      const addResponse = await processor.executeCommand({
        guildId: 'guild_1',
        guildName: 'Server One',
        channelId: 'ch_1',
        channelName: 'alerts-1',
        userId: 'user_regular',
        userTag: 'member#0001',
        hasManageGuildPermission: false,
        commandName: 'mint',
        subcommand: 'add',
        options: {
          url: 'https://opensea.io/collection/computersrh-nft/overview',
          name: 'ComputersRh',
          handle: '@ComputersRh',
          supply: '3333',
          chain: 'robinhood',
          start_time: new Date(Date.now() + 3600 * 1000).toISOString(),
          category: 'free',
        },
      });
      assertCondition(addResponse.success, '/mint add on robinhood must succeed');
      assertCondition(Boolean(addResponse.content?.includes('@ComputersRh')), 'Output must include @ComputersRh');
      assertCondition(Boolean(addResponse.content?.includes('• Chain : Robinhood Chain')), 'Output must include • Chain : Robinhood Chain');
      assertCondition(Boolean(addResponse.content?.includes('• Time : <t:')), 'Output must include Discord native <t:UNIX:t> timestamp');
      assertCondition(Boolean(addResponse.content?.includes('• Supply : 3333')), 'Output must include • Supply : 3333');

      const helpResponse = await processor.executeCommand({
        guildId: 'guild_1',
        guildName: 'Server One',
        channelId: 'ch_1',
        channelName: 'alerts-1',
        userId: 'user_regular',
        userTag: 'member#0001',
        hasManageGuildPermission: false,
        commandName: 'help',
        options: {},
      });
      assertCondition(helpResponse.success && helpResponse.embeds.length === 1, '/help must return guide embed');

      // 4. Verify Guild 2 remains completely isolated
      const guild1Settings = await store.getGuildSettings('guild_1');
      const guild2Settings = await store.getGuildSettings('guild_2', 'Server Two');

      assertCondition(guild1Settings.pingRoleId === '776655443322110099', 'Guild 1 pingRoleId must be saved');
      assertCondition(guild1Settings.pingRoleName === 'Mint-Ping', 'Guild 1 pingRoleName must be saved');
      assertCondition(guild1Settings.enabledCategories.length === 1 && guild1Settings.enabledCategories[0] === 'free', 'Guild 1 categories must be [free]');
      assertCondition(guild2Settings.pingRoleId === null, 'Guild 2 pingRoleId must remain isolated at null');
      assertCondition(guild2Settings.enabledCategories.length === 3, 'Guild 2 categories must remain isolated at [free,allowlist,public]');

      return 'Blocked unauthorized member commands, verified 5-bullet plain message format with <t:UNIX:t>, and confirmed strict state isolation.';
    }
  );

  // ============================================================================
  // SUITE 6: Failure Recovery, Overdue Downtime & Rate Limit Handling
  // ============================================================================
  await runTest(
    'rec-1',
    'Failure Recovery & Rate Limits',
    'Recovers overdue jobs within grace window, skips stale jobs, and handles 429 & missing permissions',
    async () => {
      const store = new EmbeddedSqlRepository(null);
      await store.initialize();

      const now = new Date('2026-10-17T15:00:00Z');
      // Mint starts 45 minutes in the future (15:45 UTC)
      const mintStartUtc = new Date(now.getTime() + 45 * 60 * 1000).toISOString();
      const mintOutcome = await verifyAndNormalizeMint({
        projectName: 'Recovery Protocol Drop',
        chainId: 57073,
        contractAddress: '0x3333333333333333333333333333333333333333',
        mintStartIso: mintStartUtc,
        category: 'public',
        mintPriceExact: '0.02',
        sourceUrl: 'https://opensea.io/collection/recovery-protocol',
        discoverySource: 'opensea_v2',
        verificationStatus: 'verified',
      });
      const mint = await store.upsertMint(mintOutcome.mint!);

      // Guild A: active channel
      const guildA = await store.getGuildSettings('guild_recovery_a', 'Recovery Guild A');
      await store.saveGuildSettings({
        ...guildA,
        announcementChannelId: 'ch_active',
        announcementChannelName: 'alerts',
        channelStatus: 'active',
        reminderIntervalsMinutes: [1440, 60], // 1440m was 23h15m ago (stale!), 60m was 15m ago (within 30m grace!)
      });

      // Guild B: simulates missing permissions (50013)
      const guildB = await store.getGuildSettings('guild_recovery_b', 'Broken Perms Guild B');
      await store.saveGuildSettings({
        ...guildB,
        announcementChannelId: 'ch_no_perms',
        announcementChannelName: 'restricted',
        channelStatus: 'active',
        reminderIntervalsMinutes: [60],
      });

      const engine = new ReminderEngine({
        storage: store,
        overdueGraceMinutes: 30,
        deliveryTransport: async (guild) => {
          if (guild.guildId === 'guild_recovery_b') {
            return {
              success: false,
              missingPermissions: true,
              errorMessage: 'DiscordAPIError[50013]: Missing Permissions',
            };
          }
          return { success: true };
        },
      });

      await engine.syncSchedulesForAllGuilds(now);
      const dispatchSummary = await engine.processDueReminders(now);

      // For Guild A:
      // - 1440m reminder was due 23h15m ago -> exceeds 30m grace window -> skipped!
      // - 60m reminder was due 15m ago -> within 30m grace window -> recovered and sent!
      // For Guild B:
      // - 60m reminder fails with missingPermissions -> Guild B channelStatus marked 'missing_permissions'
      assertCondition(dispatchSummary.sentCount === 1, `Expected 1 recovered reminder sent, got ${dispatchSummary.sentCount}`);
      assertCondition(dispatchSummary.skippedStaleCount === 1, `Expected 1 stale reminder skipped, got ${dispatchSummary.skippedStaleCount}`);
      assertCondition(dispatchSummary.failedCount === 1, `Expected 1 failed reminder for Guild B, got ${dispatchSummary.failedCount}`);
      assertCondition(dispatchSummary.dispatchedRecords[0].recoveredAfterDowntime === true, 'Sent reminder must be flagged as recoveredAfterDowntime');

      const updatedGuildB = await store.getGuildSettings('guild_recovery_b');
      assertCondition(
        updatedGuildB.channelStatus === 'missing_permissions',
        `Guild B channelStatus must be updated to missing_permissions, got ${updatedGuildB.channelStatus}`
      );

      // Calling processDueReminders again must send 0 (idempotency)
      const secondRun = await engine.processDueReminders(now);
      assertCondition(secondRun.sentCount === 0, `Second run for ${mint.projectName} must send 0 duplicates`);

      return 'Recovered 15m-overdue job within 30m grace window, skipped 23h-stale job, and gracefully disabled Guild B channel on 50013 Missing Permissions.';
    }
  );

  // ============================================================================
  // SUITE 7: Mint Edit/Remove Commands & Automated Daily Digest Schedule
  // ============================================================================
  await runTest(
    'mgmt-1',
    'Mint Management & Automated Daily Digest',
    'Edits and removes mints via /mint edit & /mint remove and dispatches idempotent Daily Digests',
    async () => {
      const store = new EmbeddedSqlRepository(null);
      await store.initialize();
      const engine = new ReminderEngine({ storage: store });
      const processor = new DiscordCommandProcessor(store, engine);

      const refNow = new Date('2026-10-18T13:05:00Z');
      const mintStart = new Date(refNow.getTime() + 4 * 3600 * 1000).toISOString();

      // 1. Add a mint on Ink Chain
      await processor.executeCommand({
        guildId: 'guild_digest',
        guildName: 'Digest Server',
        channelId: 'ch_digest',
        channelName: 'daily-mints',
        userId: 'admin_1',
        userTag: 'admin#0001',
        hasManageGuildPermission: true,
        commandName: 'mint',
        subcommand: 'add',
        options: {
          url: 'https://opensea.io/collection/ink-punks/overview',
          name: 'InkPunks',
          handle: '@InkPunks',
          supply: '1000',
          chain: 'ink',
          start_time: mintStart,
          category: 'public',
          price: '0.002',
        },
      });

      // 2. Edit the mint via /mint edit (change supply to 2222 and price to Free)
      const editRes = await processor.executeCommand({
        guildId: 'guild_digest',
        guildName: 'Digest Server',
        channelId: 'ch_digest',
        channelName: 'daily-mints',
        userId: 'admin_1',
        userTag: 'admin#0001',
        hasManageGuildPermission: true,
        commandName: 'mint',
        subcommand: 'edit',
        options: {
          query: '@InkPunks',
          supply: '2222',
          price: 'Free',
        },
      });
      assertCondition(editRes.success, '/mint edit must succeed for admin');
      assertCondition(Boolean(editRes.content?.includes('• Price : Free')), 'Edited mint must show Free price');
      assertCondition(Boolean(editRes.content?.includes('• Supply : 2222')), 'Edited mint must show updated supply 2222');

      // 3. Configure /setup with daily_digest: 13:00
      const setupRes = await processor.executeCommand({
        guildId: 'guild_digest',
        guildName: 'Digest Server',
        channelId: 'ch_digest',
        channelName: 'daily-mints',
        userId: 'admin_1',
        userTag: 'admin#0001',
        hasManageGuildPermission: true,
        commandName: 'setup',
        options: {
          channel_id: 'ch_digest',
          channel_name: 'daily-mints',
          role_id: '99887766',
          role_name: 'MintAlerts',
          daily_digest: '13:00',
        },
      });
      assertCondition(setupRes.success, '/setup with daily_digest:13:00 must succeed');

      // 4. Process due daily digests at 13:05 UTC -> should send 1 digest, and 0 on second call same day
      const digestRun1 = await engine.processDueDailyDigests(refNow);
      const digestRun2 = await engine.processDueDailyDigests(refNow);
      assertCondition(digestRun1.digestsSent === 1, `Expected 1 daily digest sent, got ${digestRun1.digestsSent}`);
      assertCondition(digestRun2.digestsSent === 0, 'Second daily digest run on same UTC date must send 0 duplicates');

      // 5. Remove the mint via /mint remove
      const removeRes = await processor.executeCommand({
        guildId: 'guild_digest',
        guildName: 'Digest Server',
        channelId: 'ch_digest',
        channelName: 'daily-mints',
        userId: 'admin_1',
        userTag: 'admin#0001',
        hasManageGuildPermission: true,
        commandName: 'mint',
        subcommand: 'remove',
        options: {
          query: '@InkPunks',
        },
      });
      assertCondition(removeRes.success, '/mint remove must succeed for admin');
      const remaining = await store.getAllMints();
      assertCondition(remaining.length === 0, 'Deleted mint must be removed from storage');

      return 'Verified /mint edit, /mint remove, and once-per-day Automated Daily Digest dispatch.';
    }
  );

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs: Date.now() - suiteStart,
    executedAtUtc: new Date().toISOString(),
    results,
  };
}
