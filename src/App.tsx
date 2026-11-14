/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * MintPulse Web Management Console & Live Discord Slash-Command Simulator
 * Scope: NFT Mints Only (Free, Allowlist/Whitelist, Public). Zero raffles.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Filter,
  Globe,
  Layers,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Unlock,
} from 'lucide-react';
import type {
  DiscordEmbedPayload,
  DiscoveryFeedSource,
  EvmChainConfig,
  GuildSettings,
  MintCategory,
  NormalizedMint,
  ScheduledReminder,
  SlashCommandInvocation,
  SlashCommandResult,
  WatchlistEntry,
} from './core/types.ts';
import type { AdapterStatusReport } from './core/discovery/adapterInterface.ts';
import type { DispatchedNotificationRecord } from './core/scheduler/reminderEngine.ts';
import type { TestSuiteSummary } from './core/tests/testSuite.ts';

type ActiveSection = 'simulator' | 'mints' | 'discovery' | 'reminders' | 'setup';

interface AppStatePayload {
  serverTimeUtc: string;
  storageMode: 'postgresql' | 'embedded_sql_store';
  discordGateway: {
    configured: boolean;
    connected: boolean;
    botTag: string | null;
    clientId?: string | null;
    requirementNote: string;
  };
  chains: EvmChainConfig[];
  timezones: string[];
  adapters: AdapterStatusReport[];
  feedSources?: DiscoveryFeedSource[];
  mints: NormalizedMint[];
  guilds: GuildSettings[];
  watchlistsByGuild: Record<string, WatchlistEntry[]>;
  scheduledReminders: ScheduledReminder[];
  dispatchedNotifications: DispatchedNotificationRecord[];
}

interface SimulatorTranscriptItem {
  id: string;
  timestamp: string;
  guildId: string;
  userTag: string;
  isAdmin: boolean;
  commandText: string;
  result: SlashCommandResult;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('simulator');
  const [appState, setAppState] = useState<AppStatePayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionBanner, setActionBanner] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);

  // Selected Discord Guild in Simulator & Schedule View
  const [selectedGuildId, setSelectedGuildId] = useState<string>('109283746510293847');
  const [simulateAdminPerms, setSimulateAdminPerms] = useState<boolean>(true);

  // Slash Command Simulator Form State
  const [selectedCommand, setSelectedCommand] = useState<
    | 'setup'
    | 'mints_today'
    | 'mints_week'
    | 'mints_digest'
    | 'mint_watch'
    | 'mint_add'
    | 'mint_edit'
    | 'mint_remove'
    | 'mint_source'
    | 'settings'
    | 'help'
  >('mints_week');
  const [setupChannelName, setSetupChannelName] = useState<string>('nft-mint-alerts');
  const [setupChannelId, setSetupChannelId] = useState<string>('998877665544332211');
  const [setupRoleName, setSetupRoleName] = useState<string>('Mint-Ping');
  const [setupRoleId, setSetupRoleId] = useState<string>('776655443322110099');
  const [setupDailyDigest, setSetupDailyDigest] = useState<string>('13:00');
  const [watchQuery, setWatchQuery] = useState<string>('computersrh-nft');
  const [settingsIntervals, setSettingsIntervals] = useState<string>('1440,60,15');
  const [settingsCategories, setSettingsCategories] = useState<string>('free,allowlist,public');
  const [settingsRoleName, setSettingsRoleName] = useState<string>('Mint-Ping');
  const [settingsRoleId, setSettingsRoleId] = useState<string>('776655443322110099');
  const [settingsDailyDigest, setSettingsDailyDigest] = useState<string>('13:00');
  const [settingsIncludeUnverified, setSettingsIncludeUnverified] = useState<boolean>(false);

  // /mint add inputs
  const [mintAddUrl, setMintAddUrl] = useState<string>('https://opensea.io/collection/computersrh-nft/overview');
  const [mintAddName, setMintAddName] = useState<string>('ComputersRh');
  const [mintAddHandle, setMintAddHandle] = useState<string>('@ComputersRh');
  const [mintAddSupply, setMintAddSupply] = useState<string>('3333');
  const [mintAddChain, setMintAddChain] = useState<string>('robinhood');
  const [mintAddStartIso, setMintAddStartIso] = useState<string>(() => {
    return new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 16) + ':00Z';
  });
  const [mintAddCategory, setMintAddCategory] = useState<MintCategory>('free');
  const [mintAddPrice, setMintAddPrice] = useState<string>('0');
  const [mintAddContract, setMintAddContract] = useState<string>('');

  // /mint edit, /mint remove, & /mint source simulator inputs
  const [mintEditQuery, setMintEditQuery] = useState<string>('@ComputersRh');
  const [mintEditName, setMintEditName] = useState<string>('');
  const [mintEditHandle, setMintEditHandle] = useState<string>('');
  const [mintEditPrice, setMintEditPrice] = useState<string>('Free');
  const [mintEditSupply, setMintEditSupply] = useState<string>('3333');
  const [mintEditStartIso, setMintEditStartIso] = useState<string>('');
  const [mintRemoveQuery, setMintRemoveQuery] = useState<string>('@ComputersRh');
  const [mintSourceUrl, setMintSourceUrl] = useState<string>('');
  const [mintSourceLabel, setMintSourceLabel] = useState<string>('Custom Mint Website');

  // Website Mint Source Connector state
  const [websiteFeedUrlInput, setWebsiteFeedUrlInput] = useState<string>('');
  const [websiteFeedLabelInput, setWebsiteFeedLabelInput] = useState<string>('Primary Mint Calendar');
  const [connectingWebsite, setConnectingWebsite] = useState<boolean>(false);

  // Inline Mint Schedule table editor
  const [editingMintId, setEditingMintId] = useState<string | null>(null);
  const [inlineEditName, setInlineEditName] = useState<string>('');
  const [inlineEditHandle, setInlineEditHandle] = useState<string>('');
  const [inlineEditPrice, setInlineEditPrice] = useState<string>('');
  const [inlineEditSupply, setInlineEditSupply] = useState<string>('');
  const [inlineEditStartUtc, setInlineEditStartUtc] = useState<string>('');

  const [transcripts, setTranscripts] = useState<SimulatorTranscriptItem[]>([]);

  // Mint Schedule Filters
  const [chainFilter, setChainFilter] = useState<number | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<MintCategory | 'all'>('all');
  const [verificationFilter, setVerificationFilter] = useState<'all' | 'verified' | 'unverified'>('all');

  // SSRF & URL Validator State
  const [ssrfTestUrl, setSsrfTestUrl] = useState<string>('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  const [ssrfSampleHtml, setSsrfSampleHtml] = useState<string>('');
  const [ssrfResult, setSsrfResult] = useState<{
    validation: {
      valid: boolean;
      normalizedUrl: string | null;
      hostname: string | null;
      resolvedIps: string[];
      reason?: string;
    };
    extractedMints: unknown[];
    fetchError?: string;
  } | null>(null);

  // New EVM Chain Form State
  const [newChainId, setNewChainId] = useState<string>('7777777');
  const [newChainSlug, setNewChainSlug] = useState<string>('zora');
  const [newChainName, setNewChainName] = useState<string>('Zora Network');
  const [newChainSymbol, setNewChainSymbol] = useState<string>('ETH');
  const [newChainExplorer, setNewChainExplorer] = useState<string>('https://explorer.zora.energy');

  // Automated Test Suite State
  const [testSummary, setTestSummary] = useState<TestSuiteSummary | null>(null);
  const [runningTests, setRunningTests] = useState<boolean>(false);

  // OAuth2 Bot Invite Client ID helper
  const [inviteClientId, setInviteClientId] = useState<string>('1561118363311145031');

  // Supabase & Credentials Wizard State
  const [supabaseUri, setSupabaseUri] = useState<string>('');
  const [testingSupabase, setTestingSupabase] = useState<boolean>(false);
  const [supabaseTestResult, setSupabaseTestResult] = useState<{
    success: boolean;
    message: string;
    version?: string;
    database?: string;
  } | null>(null);
  const [copiedSql, setCopiedSql] = useState<boolean>(false);
  const [copiedEnv, setCopiedEnv] = useState<boolean>(false);
  const [wizardDiscordToken, setWizardDiscordToken] = useState<string>('');
  const [wizardDiscordClientId, setWizardDiscordClientId] = useState<string>('1561118363311145031');
  const [wizardOpenSeaKey, setWizardOpenSeaKey] = useState<string>('YOUR_OPENSEA_KEY');

  const handleCopyMigrationSql = async () => {
    try {
      const res = await fetch('/api/migration-sql');
      const data = await res.json();
      if (data.sql) {
        await navigator.clipboard.writeText(data.sql);
        setCopiedSql(true);
        setTimeout(() => setCopiedSql(false), 3000);
        setActionBanner({
          type: 'success',
          text: 'Copied full PostgreSQL migration SQL to clipboard. You can now paste and run this inside Supabase SQL Editor.',
        });
      }
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to copy migration SQL: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleTestSupabaseConnection = async () => {
    if (!supabaseUri.trim()) {
      setActionBanner({ type: 'error', text: 'Please enter a Supabase connection string to test.' });
      return;
    }
    setTestingSupabase(true);
    setSupabaseTestResult(null);
    try {
      const res = await fetch('/api/database/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString: supabaseUri }),
      });
      const data = await res.json();
      setSupabaseTestResult(data);
    } catch (err) {
      setSupabaseTestResult({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingSupabase(false);
    }
  };

  const handleCopyGeneratedEnv = async () => {
    const lines = [
      '# MintPulse Configuration (.env)',
      `DISCORD_BOT_TOKEN="${wizardDiscordToken.trim() || 'YOUR_DISCORD_BOT_TOKEN_HERE'}"`,
      `DISCORD_CLIENT_ID="${wizardDiscordClientId.trim() || 'YOUR_DISCORD_APPLICATION_CLIENT_ID_HERE'}"`,
      `DATABASE_URL="${supabaseUri.trim() || 'postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres'}"`,
      `OPENSEA_API_KEY="${wizardOpenSeaKey.trim() || 'YOUR_OPENSEA_API_KEY'}"`,
      'DEFAULT_REMINDER_INTERVALS="1440,60,15"',
      'OVERDUE_GRACE_MINUTES="30"',
      'PORT="3000"',
      'LOG_LEVEL="info"',
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopiedEnv(true);
    setTimeout(() => setCopiedEnv(false), 3000);
    setActionBanner({
      type: 'success',
      text: 'Copied configured .env content to clipboard!',
    });
  };

  const fetchState = useCallback(async () => {
    try {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as AppStatePayload;
      setAppState(data);
      if (data.discordGateway?.clientId) {
        setInviteClientId(data.discordGateway.clientId);
        setWizardDiscordClientId(data.discordGateway.clientId);
      }
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to load bot state: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  const currentGuild = useMemo(() => {
    if (!appState) return null;
    return appState.guilds.find((g) => g.guildId === selectedGuildId) ?? appState.guilds[0] ?? null;
  }, [appState, selectedGuildId]);

  const currentWatchlist = useMemo(() => {
    if (!appState || !currentGuild) return [];
    return appState.watchlistsByGuild[currentGuild.guildId] ?? [];
  }, [appState, currentGuild]);

  const filteredMints = useMemo(() => {
    if (!appState) return [];
    return appState.mints.filter((m) => {
      if (chainFilter !== 'all' && m.chainId !== chainFilter) return false;
      if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
      if (verificationFilter !== 'all' && m.verificationStatus !== verificationFilter) return false;
      return true;
    });
  }, [appState, chainFilter, categoryFilter, verificationFilter]);

  const handleSeedSandboxFixtures = async () => {
    try {
      const res = await fetch('/api/sandbox/seed-test-fixtures', { method: 'POST' });
      const data = await res.json();
      await fetchState();
      setActionBanner({
        type: 'success',
        text: `Loaded ${data.insertedCount} explicit test sandbox fixtures and synchronized ${data.sync?.newlyScheduledCount ?? 0} reminder jobs.`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to load sandbox fixtures: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleExecuteSlashCommand = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentGuild) return;

    let commandName: SlashCommandInvocation['commandName'] = 'mints';
    let subcommand: SlashCommandInvocation['subcommand'] = undefined;
    let options: Record<string, string | boolean | number | undefined> = {};
    let commandText = '';

    if (selectedCommand === 'setup') {
      commandName = 'setup';
      options = {
        channel_id: setupChannelId,
        channel_name: setupChannelName,
        role_id: setupRoleId.trim() || 'none',
        role_name: setupRoleName.trim() || 'none',
        daily_digest: setupDailyDigest.trim() || undefined,
      };
      commandText = `/setup channel:#${setupChannelName}${
        setupRoleName.trim() ? ` role:@${setupRoleName.replace(/^@/, '')}` : ''
      }${setupDailyDigest.trim() ? ` daily_digest:${setupDailyDigest.trim()}` : ''}`;
    } else if (selectedCommand === 'mints_today') {
      commandName = 'mints';
      subcommand = 'today';
      commandText = '/mints today';
    } else if (selectedCommand === 'mints_week') {
      commandName = 'mints';
      subcommand = 'week';
      commandText = '/mints week';
    } else if (selectedCommand === 'mints_digest') {
      commandName = 'mints';
      subcommand = 'digest';
      commandText = '/mints digest';
    } else if (selectedCommand === 'mint_watch') {
      commandName = 'mint';
      subcommand = 'watch';
      options = { collection: watchQuery };
      commandText = `/mint watch collection:${watchQuery}`;
    } else if (selectedCommand === 'mint_add') {
      commandName = 'mint';
      subcommand = 'add';
      options = {
        url: mintAddUrl,
        name: mintAddName,
        handle: mintAddHandle,
        supply: mintAddSupply,
        chain: mintAddChain,
        start_time: mintAddStartIso,
        category: mintAddCategory,
        price: mintAddPrice,
        contract: mintAddContract,
      };
      commandText = `/mint add url:${mintAddUrl} name:"${mintAddName}" handle:${mintAddHandle} supply:${mintAddSupply} chain:${mintAddChain} start_time:${mintAddStartIso} category:${mintAddCategory}`;
    } else if (selectedCommand === 'mint_edit') {
      commandName = 'mint';
      subcommand = 'edit';
      options = {
        query: mintEditQuery,
        name: mintEditName.trim() || undefined,
        handle: mintEditHandle.trim() || undefined,
        price: mintEditPrice.trim() || undefined,
        supply: mintEditSupply.trim() || undefined,
        start_time: mintEditStartIso.trim() || undefined,
      };
      commandText = `/mint edit query:${mintEditQuery}${mintEditPrice.trim() ? ` price:${mintEditPrice}` : ''}${
        mintEditSupply.trim() ? ` supply:${mintEditSupply}` : ''
      }${mintEditHandle.trim() ? ` handle:${mintEditHandle}` : ''}`;
    } else if (selectedCommand === 'mint_remove') {
      commandName = 'mint';
      subcommand = 'remove';
      options = {
        query: mintRemoveQuery,
      };
      commandText = `/mint remove query:${mintRemoveQuery}`;
    } else if (selectedCommand === 'mint_source') {
      commandName = 'mint';
      subcommand = 'source';
      options = {
        url: mintSourceUrl.trim() || 'list',
        label: mintSourceLabel.trim() || undefined,
      };
      commandText = `/mint source url:${mintSourceUrl.trim() || 'list'}${
        mintSourceLabel.trim() ? ` label:"${mintSourceLabel.trim()}"` : ''
      }`;
    } else if (selectedCommand === 'settings') {
      commandName = 'settings';
      options = {
        intervals: settingsIntervals,
        categories: settingsCategories,
        role_id: settingsRoleId.trim() || 'none',
        role_name: settingsRoleName.trim() || 'none',
        daily_digest: settingsDailyDigest.trim() || undefined,
        include_unverified_watched: settingsIncludeUnverified,
      };
      commandText = `/settings intervals:${settingsIntervals} categories:${settingsCategories}${
        settingsRoleName.trim() ? ` role:@${settingsRoleName.replace(/^@/, '')}` : ''
      }${settingsDailyDigest.trim() ? ` daily_digest:${settingsDailyDigest.trim()}` : ''} include_unverified_watched:${settingsIncludeUnverified}`;
    } else if (selectedCommand === 'help') {
      commandName = 'help';
      commandText = '/help';
    }

    const invocation: SlashCommandInvocation = {
      guildId: currentGuild.guildId,
      guildName: currentGuild.guildName,
      channelId: currentGuild.announcementChannelId || '998877665544332211',
      channelName: currentGuild.announcementChannelName || 'general',
      userId: simulateAdminPerms ? 'admin_user_01' : 'member_user_99',
      userTag: simulateAdminPerms ? 'moderator#0001' : 'collector#4092',
      hasManageGuildPermission: simulateAdminPerms,
      commandName,
      subcommand,
      options,
    };

    try {
      const response = await fetch('/api/discord/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invocation),
      });
      const result = (await response.json()) as SlashCommandResult;
      setTranscripts((prev) => [
        {
          id: `cmd_${Date.now()}`,
          timestamp: new Date().toISOString(),
          guildId: currentGuild.guildId,
          userTag: invocation.userTag,
          isAdmin: simulateAdminPerms,
          commandText,
          result,
        },
        ...prev,
      ]);
      await fetchState();
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Command execution error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleConnectWebsiteSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!websiteFeedUrlInput.trim()) return;
    setConnectingWebsite(true);
    try {
      const res = await fetch('/api/sources/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: websiteFeedUrlInput.trim(),
          label: websiteFeedLabelInput.trim() || 'Custom Mint Website',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionBanner({
          type: 'error',
          text: data.message || 'Could not connect website URL.',
        });
      } else {
        setWebsiteFeedUrlInput('');
        await fetchState();
        setActionBanner({
          type: 'success',
          text: `Connected ${data.url} — imported ${data.importedCount} upcoming mint(s)${
            data.fetchError ? ` (${data.fetchError})` : ''
          }.`,
        });
      }
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to connect website: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setConnectingWebsite(false);
    }
  };

  const handleRemoveWebsiteSource = async (url: string) => {
    try {
      await fetch('/api/sources/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      await fetchState();
      setActionBanner({
        type: 'info',
        text: `Disconnected website source: ${url}`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to remove website source: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleRunDiscovery = async () => {
    try {
      const res = await fetch('/api/discover/run', { method: 'POST' });
      const data = await res.json();
      await fetchState();
      setActionBanner({
        type: 'info',
        text: `Discovery cycle completed: ${data.discoveredCount} normalized mints, ${data.newlyScheduledReminders} new reminder jobs scheduled.`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Discovery error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleValidateUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/url/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ssrfTestUrl,
          fetchMetadata: false,
          sampleHtml: ssrfSampleHtml,
        }),
      });
      const data = await res.json();
      setSsrfResult(data);
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Validation request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleToggleMintVerification = async (mint: NormalizedMint) => {
    try {
      const res = await fetch('/api/mints/verify-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mintId: mint.id,
          verified: mint.verificationStatus !== 'verified',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchState();
      setActionBanner({
        type: 'success',
        text: `Updated "${mint.projectName}" verification status to ${
          mint.verificationStatus !== 'verified' ? 'verified' : 'unverified'
        } and synchronized reminder schedules.`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to toggle verification: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleTriggerSingleReminder = async (reminderId: string) => {
    try {
      const res = await fetch('/api/reminders/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderId }),
      });
      const data = await res.json();
      await fetchState();
      setActionBanner({
        type: data.success ? 'success' : 'error',
        text: data.message,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleTriggerDailyDigest = async (guildId: string) => {
    try {
      const res = await fetch('/api/reminders/daily-digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId }),
      });
      const data = await res.json();
      await fetchState();
      setActionBanner({
        type: data.success ? 'success' : 'error',
        text: data.message || 'Dispatched Daily Digest.',
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Daily digest dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleStartInlineEdit = (mint: NormalizedMint) => {
    setEditingMintId(mint.id);
    setInlineEditName(mint.projectName);
    setInlineEditHandle(mint.twitterHandle || `@${mint.projectName.replace(/\s+/g, '')}`);
    setInlineEditPrice(mint.mintPriceExact ?? '0');
    setInlineEditSupply(mint.totalSupply ?? 'TBA');
    setInlineEditStartUtc(mint.mintStartUtc.slice(0, 16) + ':00Z');
  };

  const handleSaveInlineEdit = async (mintId: string) => {
    try {
      const res = await fetch('/api/mints/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mintId,
          projectName: inlineEditName.trim(),
          twitterHandle: inlineEditHandle.trim(),
          mintPriceExact: inlineEditPrice.trim().toLowerCase() === 'free' ? '0' : inlineEditPrice.trim(),
          totalSupply: inlineEditSupply.trim(),
          mintStartUtc: inlineEditStartUtc.trim(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingMintId(null);
      await fetchState();
      setActionBanner({
        type: 'success',
        text: `Updated "${inlineEditName}" and rescheduled pending reminders.`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to save mint edits: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleDeleteMint = async (mint: NormalizedMint) => {
    try {
      const res = await fetch('/api/mints/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintId: mint.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchState();
      setActionBanner({
        type: 'info',
        text: `Removed "${mint.projectName}" and cleared its pending reminders.`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Failed to delete mint: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleRegisterChain = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/chains/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: Number(newChainId),
          slug: newChainSlug,
          name: newChainName,
          nativeSymbol: newChainSymbol,
          explorerUrl: newChainExplorer,
          openSeaChainIdentifier: newChainSlug,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to register chain');
      await fetchState();
      setActionBanner({
        type: 'success',
        text: `Registered EVM chain ${newChainName} (Chain ID ${newChainId}) in the active Chain Registry.`,
      });
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleRunAutomatedTests = async () => {
    setRunningTests(true);
    try {
      const res = await fetch('/api/tests/run', { method: 'POST' });
      const data = (await res.json()) as TestSuiteSummary;
      setTestSummary(data);
    } catch (err) {
      setActionBanner({
        type: 'error',
        text: `Test runner failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setRunningTests(false);
    }
  };

  if (loading && !appState) {
    return (
      <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex items-center justify-center p-8">
        <div className="max-w-md w-full space-y-4">
          <div className="h-6 w-48 bg-slate-800 rounded animate-pulse" />
          <div className="h-4 w-full bg-slate-800/70 rounded animate-pulse" />
          <div className="h-4 w-3/4 bg-slate-800/70 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex flex-col">
      {/* Top Bar Contract: Strictly 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800/80 bg-[#0B0F19]/95 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#simulator"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('simulator');
          }}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          MintPulse
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveSection('simulator')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'simulator' ? 'text-white underline underline-offset-8 decoration-indigo-500 decoration-2' : ''
            }`}
          >
            Discord Simulator
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('mints')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'mints' ? 'text-white underline underline-offset-8 decoration-indigo-500 decoration-2' : ''
            }`}
          >
            Mint Schedule
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('discovery')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'discovery' ? 'text-white underline underline-offset-8 decoration-indigo-500 decoration-2' : ''
            }`}
          >
            Discovery & SSRF
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('reminders')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'reminders' ? 'text-white underline underline-offset-8 decoration-indigo-500 decoration-2' : ''
            }`}
          >
            Reminder Queue
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('setup')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'setup' ? 'text-white underline underline-offset-8 decoration-indigo-500 decoration-2' : ''
            }`}
          >
            Setup & Supabase
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleRunDiscovery}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Sync Live Mints Now
          </button>
        </div>
      </header>

      {/* Mobile Navigation Bar */}
      <div className="flex md:hidden items-center gap-2 px-4 py-2.5 border-b border-slate-800 overflow-x-auto">
        {(
          [
            ['simulator', 'Discord Simulator'],
            ['mints', 'Mint Schedule'],
            ['discovery', 'Discovery & SSRF'],
            ['reminders', 'Reminder Queue'],
            ['setup', 'Setup & Supabase'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveSection(key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
              activeSection === key ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1380px] w-full mx-auto px-6 py-8 space-y-8">
        {/* Operational Context Header & Metrics Strip */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6 border-b border-slate-800/80">
          <div className="space-y-2 max-w-2xl">
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              Storage:{' '}
              <span className={appState?.storageMode === 'postgresql' ? 'text-emerald-400 font-semibold' : 'text-slate-300'}>
                {appState?.storageMode === 'postgresql' ? 'Supabase PostgreSQL (Connected)' : 'SQL-Compatible Local Store'}
              </span>{' '}
              · Discord Bot:{' '}
              <span className={appState?.discordGateway.connected ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>
                {appState?.discordGateway.connected
                  ? `${appState.discordGateway.botTag} (Online · App ID ${appState.discordGateway.clientId})`
                  : 'Web Simulator Mode'}
              </span>{' '}
              · OpenSea v2:{' '}
              <span
                className={
                  appState?.adapters.find((a) => a.adapterId === 'opensea_v2')?.configured
                    ? 'text-emerald-400 font-semibold'
                    : 'text-slate-400'
                }
              >
                {appState?.adapters.find((a) => a.adapterId === 'opensea_v2')?.configured ? 'Authenticated' : 'Unconfigured'}
              </span>
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white text-balance">
              Multi-Server EVM Mint Discovery & Scheduled Reminder Engine
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Discovers and validates upcoming NFT mints across {appState?.chains.map((c) => c.name).join(', ')}. Unknown prices or smart contracts are never fabricated. Raffles are strictly excluded.
              {appState?.discordGateway.clientId && (
                <>
                  {' '}
                  <a
                    href={`https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(
                      appState.discordGateway.clientId
                    )}&permissions=84992&scope=bot%20applications.commands`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-400 hover:underline font-medium inline-flex items-center gap-1"
                  >
                    <span>Invite {appState.discordGateway.botTag || 'Bot'} to Discord</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </>
              )}
            </p>
          </div>

          {/* Tabular Metrics Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 shrink-0 pt-2 lg:pt-0">
            <div>
              <div className="text-xs text-slate-400">Tracked NFT Mints</div>
              <div className="text-2xl font-bold text-white font-mono tabular-nums mt-0.5">
                {appState?.mints.length ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                {appState?.mints.filter((m) => m.verificationStatus === 'verified').length ?? 0} verified ·{' '}
                {appState?.mints.filter((m) => m.verificationStatus === 'unverified').length ?? 0} unverified
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Allowed EVM Chains</div>
              <div className="text-2xl font-bold text-white font-mono tabular-nums mt-0.5">
                {appState?.chains.length ?? 3}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Ethereum · Robinhood · Ink
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Queued Reminders</div>
              <div className="text-2xl font-bold text-white font-mono tabular-nums mt-0.5">
                {appState?.scheduledReminders.filter((r) => r.status === 'pending').length ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                {appState?.scheduledReminders.filter((r) => r.status === 'sent').length ?? 0} dispatched
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Isolated Servers</div>
              <div className="text-2xl font-bold text-white font-mono tabular-nums mt-0.5">
                {appState?.guilds.length ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Per-guild timezone & @Role
              </div>
            </div>
          </div>
        </section>

        {/* Action Notification Banner */}
        {actionBanner && (
          <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-slate-700 bg-slate-900/90 text-sm">
            <div className="flex items-center gap-2.5 text-slate-200">
              {actionBanner.type === 'error' ? (
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span>{actionBanner.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setActionBanner(null)}
              className="text-xs text-slate-400 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* =====================================================================
            VIEW 1: LIVE DISCORD INTERACTION SIMULATOR
           ===================================================================== */}
        {activeSection === 'simulator' && currentGuild && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Server Context & Slash Command Composer (5 cols) */}
            <div className="lg:col-span-5 space-y-6 border border-slate-800 rounded-xl p-6 bg-[#111827]/70">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-white">01. Discord Server & Permission Context</h2>
                <p className="text-xs text-slate-400">
                  Switch Discord servers or toggle member permissions to verify server isolation and admin command locks.
                </p>
              </div>

              {/* Server Selector */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-300">Active Discord Server (Guild Isolation)</label>
                <div className="grid grid-cols-1 gap-2">
                  {appState?.guilds.map((g) => (
                    <button
                      key={g.guildId}
                      type="button"
                      onClick={() => {
                        setSelectedGuildId(g.guildId);
                        setSettingsIntervals(g.reminderIntervalsMinutes.join(','));
                        setSettingsCategories(g.enabledCategories.join(','));
                        setSetupRoleName(g.pingRoleName ?? '');
                        setSetupRoleId(g.pingRoleId ?? '');
                        setSetupDailyDigest(g.dailyDigestEnabled ? g.dailyDigestTimeUtc || '13:00' : 'off');
                        setSettingsRoleName(g.pingRoleName ?? '');
                        setSettingsRoleId(g.pingRoleId ?? '');
                        setSettingsDailyDigest(g.dailyDigestEnabled ? g.dailyDigestTimeUtc || '13:00' : 'off');
                      }}
                      className={`text-left px-3.5 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                        g.guildId === currentGuild.guildId
                          ? 'border-indigo-500 bg-indigo-950/30 text-white'
                          : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{g.guildName}</span>
                        <span className="text-xs font-mono tabular-nums text-emerald-400">
                          {g.dailyDigestEnabled ? `Digest: ${g.dailyDigestTimeUtc || '13:00'} UTC` : 'Digest: Off'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
                        Channel: #{g.announcementChannelName || 'unconfigured'} · Role:{' '}
                        <span className={g.pingRoleId ? 'text-indigo-400 font-semibold' : 'text-slate-500'}>
                          {g.pingRoleName ? `@${g.pingRoleName.replace(/^@/, '')}` : g.pingRoleId ? `<@&${g.pingRoleId}>` : 'None'}
                        </span>{' '}
                        · Lead: {g.reminderIntervalsMinutes.join('m, ')}m
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Permission Role Switch */}
              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                <label className="block text-xs font-medium text-slate-300">Simulated Discord Member Permissions</label>
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setSimulateAdminPerms(true)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      simulateAdminPerms ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    Server Admin (ManageGuild)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSimulateAdminPerms(false)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      !simulateAdminPerms ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    Regular Member (No Admin)
                  </button>
                </div>
              </div>

              {/* Slash Command Picker */}
              <form onSubmit={handleExecuteSlashCommand} className="space-y-4 pt-3 border-t border-slate-800/80">
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-300">Select Slash Command (10 Commands & Subcommands)</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {(
                      [
                        ['setup', '/setup'],
                        ['mints_today', '/mints today'],
                        ['mints_week', '/mints week'],
                        ['mints_digest', '/mints digest'],
                        ['mint_watch', '/mint watch'],
                        ['mint_add', '/mint add'],
                        ['mint_edit', '/mint edit'],
                        ['mint_remove', '/mint remove'],
                        ['mint_source', '/mint source'],
                        ['settings', '/settings'],
                        ['help', '/help'],
                      ] as const
                    ).map(([cmdKey, cmdLabel]) => (
                      <button
                        key={cmdKey}
                        type="button"
                        onClick={() => setSelectedCommand(cmdKey)}
                        className={`px-3 py-2 text-xs font-mono font-medium rounded-lg border text-left transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          selectedCommand === cmdKey
                            ? 'border-indigo-500 bg-indigo-600/20 text-white'
                            : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        {cmdLabel}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Dynamic Command Arguments */}
                {selectedCommand === 'setup' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Channel Name</label>
                        <input
                          type="text"
                          value={setupChannelName}
                          onChange={(e) => setSetupChannelName(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Channel Snowflake ID</label>
                        <input
                          type="text"
                          value={setupChannelId}
                          onChange={(e) => setSetupChannelId(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Tagged Role Name (Optional)</label>
                        <input
                          type="text"
                          value={setupRoleName}
                          onChange={(e) => setSetupRoleName(e.target.value)}
                          placeholder="e.g. Mint-Ping (or leave blank)"
                          className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Role Snowflake ID (Optional)</label>
                        <input
                          type="text"
                          value={setupRoleId}
                          onChange={(e) => setSetupRoleId(e.target.value)}
                          placeholder="e.g. 776655443322110099"
                          className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Automated Daily Digest Time (HH:MM in UTC or &apos;off&apos;)
                      </label>
                      <input
                        type="text"
                        value={setupDailyDigest}
                        onChange={(e) => setSetupDailyDigest(e.target.value)}
                        placeholder="e.g. 13:00 or off"
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                  </div>
                )}

                {selectedCommand === 'mints_digest' && (
                  <div className="p-3 rounded-lg border border-slate-800 bg-slate-900/50 text-xs text-slate-300">
                    Dispatches the server&apos;s Daily NFT Mint Digest immediately to <strong>#{currentGuild.announcementChannelName || 'nft-mint-alerts'}</strong> with optional <code>@Role</code> tag and spaced 5-bullet blocks.
                  </div>
                )}

                {selectedCommand === 'mint_watch' && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Collection Slug, Project Name, or 0x Contract Address
                    </label>
                    <input
                      type="text"
                      value={watchQuery}
                      onChange={(e) => setWatchQuery(e.target.value)}
                      placeholder="e.g. computersrh-nft or 0x233502..."
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                    />
                  </div>
                )}

                {selectedCommand === 'mint_edit' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Target Mint Identifier (slug, @handle, project name, or 0x contract)
                      </label>
                      <input
                        type="text"
                        value={mintEditQuery}
                        onChange={(e) => setMintEditQuery(e.target.value)}
                        placeholder="e.g. @ComputersRh or computersrh-nft"
                        className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">New Price (Optional)</label>
                        <input
                          type="text"
                          value={mintEditPrice}
                          onChange={(e) => setMintEditPrice(e.target.value)}
                          placeholder="e.g. Free or 0.0004"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">New Supply (Optional)</label>
                        <input
                          type="text"
                          value={mintEditSupply}
                          onChange={(e) => setMintEditSupply(e.target.value)}
                          placeholder="e.g. 3333"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">New @Handle (Optional)</label>
                        <input
                          type="text"
                          value={mintEditHandle}
                          onChange={(e) => setMintEditHandle(e.target.value)}
                          placeholder="@ComputersRh"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">New Start UTC (Optional)</label>
                        <input
                          type="text"
                          value={mintEditStartIso}
                          onChange={(e) => setMintEditStartIso(e.target.value)}
                          placeholder="2026-10-19T18:00:00Z"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {selectedCommand === 'mint_remove' && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Mint to Remove (slug, @handle, project name, or 0x contract)
                    </label>
                    <input
                      type="text"
                      value={mintRemoveQuery}
                      onChange={(e) => setMintRemoveQuery(e.target.value)}
                      placeholder="e.g. @ComputersRh or computersrh-nft"
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                    />
                  </div>
                )}

                {selectedCommand === 'mint_source' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Website or Feed URL (or &apos;list&apos; / &apos;clear&apos;)
                      </label>
                      <input
                        type="text"
                        value={mintSourceUrl}
                        onChange={(e) => setMintSourceUrl(e.target.value)}
                        placeholder="https://your-mint-website.com (or 'list')"
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Source Label (Optional)</label>
                      <input
                        type="text"
                        value={mintSourceLabel}
                        onChange={(e) => setMintSourceLabel(e.target.value)}
                        placeholder="Custom Mint Website"
                        className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                  </div>
                )}

                {selectedCommand === 'settings' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Reminder Intervals Before Mint (minutes, comma-separated)
                      </label>
                      <input
                        type="text"
                        value={settingsIntervals}
                        onChange={(e) => setSettingsIntervals(e.target.value)}
                        placeholder="1440,60,15"
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Enabled Mint Categories (free,allowlist,public)
                      </label>
                      <input
                        type="text"
                        value={settingsCategories}
                        onChange={(e) => setSettingsCategories(e.target.value)}
                        placeholder="free,allowlist,public"
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Tagged Role Name (@mention)</label>
                        <input
                          type="text"
                          value={settingsRoleName}
                          onChange={(e) => setSettingsRoleName(e.target.value)}
                          placeholder="e.g. Mint-Ping (or 'none')"
                          className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Role Snowflake ID</label>
                        <input
                          type="text"
                          value={settingsRoleId}
                          onChange={(e) => setSettingsRoleId(e.target.value)}
                          placeholder="e.g. 776655443322110099"
                          className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Automated Daily Digest Schedule (HH:MM UTC or &apos;off&apos;)
                      </label>
                      <input
                        type="text"
                        value={settingsDailyDigest}
                        onChange={(e) => setSettingsDailyDigest(e.target.value)}
                        placeholder="e.g. 13:00 or off"
                        className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settingsIncludeUnverified}
                        onChange={(e) => setSettingsIncludeUnverified(e.target.checked)}
                        className="rounded border-slate-700"
                      />
                      <span>Include unverified mints if collection is on server watchlist</span>
                    </label>
                  </div>
                )}

                {selectedCommand === 'help' && (
                  <div className="p-3 rounded-lg border border-slate-800 bg-slate-900/50 text-xs text-slate-300">
                    Displays the full interactive guide for all MintPulse commands, <code>/mint edit</code>, <code>/mint remove</code>, automated Daily Digests, <code>&lt;t:UNIX:t&gt;</code> local timestamps, and allowed EVM chains (<strong>Ethereum</strong>, <strong>Robinhood Chain</strong>, <strong>Ink Chain</strong>).
                  </div>
                )}

                {selectedCommand === 'mint_add' && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Mint Page URL (Validated by SSRF Guard)</label>
                      <input
                        type="text"
                        value={mintAddUrl}
                        onChange={(e) => setMintAddUrl(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Project Name</label>
                        <input
                          type="text"
                          value={mintAddName}
                          onChange={(e) => setMintAddName(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Project @Handle</label>
                        <input
                          type="text"
                          value={mintAddHandle}
                          onChange={(e) => setMintAddHandle(e.target.value)}
                          placeholder="@ComputersRh"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">EVM Chain</label>
                        <select
                          value={mintAddChain}
                          onChange={(e) => setMintAddChain(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        >
                          {appState?.chains.map((c) => (
                            <option key={c.chainId} value={c.slug}>
                              {c.name} ({c.chainId})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Total Supply</label>
                        <input
                          type="text"
                          value={mintAddSupply}
                          onChange={(e) => setMintAddSupply(e.target.value)}
                          placeholder="e.g. 3333"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Mint Start (ISO-8601 UTC)</label>
                        <input
                          type="text"
                          value={mintAddStartIso}
                          onChange={(e) => setMintAddStartIso(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Category</label>
                        <select
                          value={mintAddCategory}
                          onChange={(e) => setMintAddCategory(e.target.value as MintCategory)}
                          className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-white"
                        >
                          <option value="free">Free Mint</option>
                          <option value="allowlist">Allowlist / Whitelist</option>
                          <option value="public">Public Mint</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Mint Price (0 for Free)</label>
                        <input
                          type="text"
                          value={mintAddPrice}
                          onChange={(e) => setMintAddPrice(e.target.value)}
                          placeholder="e.g. 0.0004"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">0x Contract (Optional)</label>
                        <input
                          type="text"
                          value={mintAddContract}
                          onChange={(e) => setMintAddContract(e.target.value)}
                          placeholder="Optional 0x..."
                          className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                        />
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  Execute Slash Command in #{currentGuild.announcementChannelName || 'general'}
                </button>
              </form>

              {/* Current Guild Watchlist Summary */}
              <div className="pt-3 border-t border-slate-800/80 space-y-2">
                <div className="text-xs font-medium text-slate-300">
                  Server Watchlist ({currentWatchlist.length} collections)
                </div>
                {currentWatchlist.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No collections watched yet on {currentGuild.guildName}. Run <code>/mint watch</code> above.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {currentWatchlist.map((w) => (
                      <div key={w.id} className="flex items-center justify-between text-xs text-slate-300 font-mono">
                        <span>{w.projectName} ({w.collectionSlug})</span>
                        <span className="text-slate-500">{w.contractAddress ? `${w.contractAddress.slice(0, 8)}...` : 'No contract'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Discord Channel Feed & Message Output (7 cols) */}
            <div className="lg:col-span-7 border border-slate-800 rounded-xl bg-[#1E1F22] overflow-hidden flex flex-col min-h-[620px]">
              {/* Discord Channel Top Header */}
              <div className="px-5 py-3.5 bg-[#2B2D31] border-b border-black/30 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <span className="text-slate-400 font-mono">#</span>
                  <span>{currentGuild.announcementChannelName || 'nft-mint-alerts'}</span>
                  <span className="text-xs font-normal text-slate-400">
                    · {currentGuild.guildName} · Local Time Auto (&lt;t:UNIX:t&gt;)
                  </span>
                </div>
                <span className="text-xs text-slate-400 font-mono tabular-nums">
                  {transcripts.length} interactions
                </span>
              </div>

              {/* Channel Stream */}
              <div className="flex-1 p-5 space-y-6 overflow-y-auto max-h-[680px]">
                {appState?.mints.length === 0 && transcripts.length === 0 && (
                  <div className="border border-slate-700/70 rounded-lg p-5 bg-[#2B2D31]/60 space-y-3">
                    <div className="text-sm font-semibold text-white">
                      Ready to Preview 5-Bullet Discord Mint Messages
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Click <strong>Load Sample Mints (Robinhood, Ink, ETH)</strong> below or run <code>/mints week</code> to see the exact <code>@Handle</code> + 5-bullet Discord message format with automatic local timestamps.
                    </p>
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={handleSeedSandboxFixtures}
                        className="px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-md transition-colors cursor-pointer"
                      >
                        Load Sample Mints (Robinhood, Ink, ETH)
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleExecuteSlashCommand()}
                        className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors cursor-pointer"
                      >
                        Run /mints week Now
                      </button>
                    </div>
                  </div>
                )}

                {transcripts.map((item) => (
                  <div key={item.id} className="space-y-2">
                    {/* Slash Command Invocation Header */}
                    <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                      <span className="text-indigo-400 font-semibold">{item.userTag}</span>
                      <span>used</span>
                      <code className="px-1.5 py-0.5 bg-black/30 rounded text-slate-200">{item.commandText}</code>
                      <span>·</span>
                      <span>{item.isAdmin ? 'Admin' : 'Member'}</span>
                      {item.result.ephemeral && <span className="text-amber-400">· Ephemeral (Only you can see this)</span>}
                    </div>

                    {/* Bot Response Message */}
                    <div className="rounded-lg border border-slate-800/80 p-4 bg-[#313338] space-y-3">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-white">MintPulse</span>
                        <span className="px-1.5 py-0.5 rounded bg-[#5865F2] text-[10px] font-semibold uppercase tracking-wider text-white">
                          APP
                        </span>
                        <span className="text-slate-400 text-[11px] tabular-nums">
                          Today at {new Date(item.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>

                      {item.result.content && <DiscordPlainMessageView content={item.result.content} />}

                      {item.result.embeds.map((embed, idx) => (
                        <DiscordEmbedView key={idx} embed={embed} />
                      ))}
                    </div>
                  </div>
                ))}

                {/* Also display any Dispatched Scheduled Reminders for this Guild */}
                {appState?.dispatchedNotifications
                  .filter((d) => d.guildId === currentGuild.guildId)
                  .map((notif) => (
                    <div key={notif.id} className="space-y-2 pt-3 border-t border-slate-800/60">
                      <div className="flex items-center gap-2 text-xs text-emerald-400 font-mono">
                        <Clock className="w-3.5 h-3.5" />
                        <span>Scheduled Automated Dispatch ({notif.intervalMinutes}m lead time)</span>
                        <span>·</span>
                        <span>Idempotency Key: {notif.idempotencyKey}</span>
                      </div>
                      <div className="rounded-lg border border-slate-800/80 p-4 bg-[#313338] space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-white">MintPulse</span>
                          <span className="px-1.5 py-0.5 rounded bg-[#5865F2] text-[10px] font-semibold uppercase tracking-wider text-white">
                            APP
                          </span>
                          <span className="text-slate-400 text-[11px] tabular-nums">
                            {new Date(notif.dispatchedAtUtc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                          </span>
                        </div>
                        {notif.content ? (
                          <DiscordPlainMessageView content={notif.content} />
                        ) : (
                          <DiscordEmbedView embed={notif.embed} />
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* =====================================================================
            VIEW 2: NORMALIZED NFT MINT SCHEDULE & VERIFICATION MANAGER
           ===================================================================== */}
        {activeSection === 'mints' && (
          <div className="space-y-6">
            {/* Connect Custom Mint Website Source Bar */}
            <div className="border border-slate-800 rounded-xl p-5 bg-[#111827]/70 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Connect Your Mint Info Website (or Run <code>/mint source</code> in Discord)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Paste the website or JSON feed URL where MintPulse should pull upcoming NFT mints from. OpenSea collections without an explicit upcoming drop stage are automatically ignored.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRunDiscovery}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Sync All Sources Now
                </button>
              </div>

              <form onSubmit={handleConnectWebsiteSource} className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-6">
                  <input
                    type="url"
                    required
                    value={websiteFeedUrlInput}
                    onChange={(e) => setWebsiteFeedUrlInput(e.target.value)}
                    placeholder="https://your-mint-calendar-website.com/..."
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                  />
                </div>
                <div className="md:col-span-3">
                  <input
                    type="text"
                    value={websiteFeedLabelInput}
                    onChange={(e) => setWebsiteFeedLabelInput(e.target.value)}
                    placeholder="Source Label (e.g. Mint Calendar)"
                    className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-lg text-white"
                  />
                </div>
                <div className="md:col-span-3">
                  <button
                    type="submit"
                    disabled={connectingWebsite}
                    className="w-full px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                  >
                    {connectingWebsite ? 'Connecting & Syncing...' : 'Connect & Sync Website'}
                  </button>
                </div>
              </form>

              {appState?.feedSources && appState.feedSources.length > 0 && (
                <div className="pt-3 border-t border-slate-800/80 space-y-2">
                  <div className="text-xs font-medium text-slate-300">Connected Mint Websites:</div>
                  <div className="divide-y divide-slate-800/60">
                    {appState.feedSources.map((src) => (
                      <div key={src.url} className="py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="space-x-2">
                          <span className="font-semibold text-white">{src.label}</span>
                          <span className="font-mono text-indigo-300">{src.url}</span>
                          <span className="text-slate-400 font-mono">
                            · Mints synced: {src.lastDiscoveredCount}
                            {src.lastError ? ` · Error: ${src.lastError}` : ''}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRemoveWebsiteSource(src.url)}
                          className="text-rose-400 hover:text-rose-300 font-medium cursor-pointer"
                        >
                          Disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Filter Controls Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div className="flex flex-wrap items-center gap-3">
                {/* Chain Filter Segmented Control */}
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setChainFilter('all')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      chainFilter === 'all' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    All Chains
                  </button>
                  {appState?.chains.map((chain) => (
                    <button
                      key={chain.chainId}
                      type="button"
                      onClick={() => setChainFilter(chain.chainId)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        chainFilter === chain.chainId ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {chain.name}
                    </button>
                  ))}
                </div>

                {/* Category Filter */}
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  {(
                    [
                      ['all', 'All Categories'],
                      ['free', 'Free'],
                      ['allowlist', 'Allowlist'],
                      ['public', 'Public'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setCategoryFilter(val)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        categoryFilter === val ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Verification Filter */}
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-lg border border-slate-800">
                  {(
                    [
                      ['all', 'All Statuses'],
                      ['verified', 'Verified Only'],
                      ['unverified', 'Unverified'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setVerificationFilter(val)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        verificationFilter === val ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-xs text-slate-400 font-mono tabular-nums">
                Displaying {filteredMints.length} of {appState?.mints.length ?? 0} normalized mints
              </div>
            </div>

            {/* Mints Data Table */}
            {filteredMints.length === 0 ? (
              <div className="border border-slate-800 rounded-xl p-10 text-center space-y-3 bg-[#111827]/40">
                <div className="text-base font-semibold text-white">No Upcoming NFT Mints Match Current Filters</div>
                <p className="text-xs text-slate-400 max-w-lg mx-auto">
                  MintPulse never fabricates fake live production drops. Add a mint via <code>/mint add</code> in the Discord Simulator, configure <code>OPENSEA_API_KEY</code>, or load explicit sandbox test fixtures.
                </p>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleSeedSandboxFixtures}
                    className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer"
                  >
                    Load Sandbox Test Fixtures
                  </button>
                </div>
              </div>
            ) : (
              <div className="border border-slate-800 rounded-xl overflow-x-auto bg-[#111827]/60">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs font-medium text-slate-400">
                      <th className="py-3.5 px-4">Project & Collection</th>
                      <th className="py-3.5 px-4">Chain & Contract</th>
                      <th className="py-3.5 px-4">Mint Start (UTC)</th>
                      <th className="py-3.5 px-4">Category & Price</th>
                      <th className="py-3.5 px-4">Source & Verification</th>
                      <th className="py-3.5 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 text-sm">
                    {filteredMints.map((mint) => {
                      const chain = appState?.chains.find((c) => c.chainId === mint.chainId);
                      const isEditing = editingMintId === mint.id;
                      return (
                        <tr key={mint.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3.5 px-4">
                            {isEditing ? (
                              <div className="space-y-1.5">
                                <input
                                  type="text"
                                  value={inlineEditName}
                                  onChange={(e) => setInlineEditName(e.target.value)}
                                  placeholder="Project Name"
                                  className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded text-white"
                                />
                                <input
                                  type="text"
                                  value={inlineEditHandle}
                                  onChange={(e) => setInlineEditHandle(e.target.value)}
                                  placeholder="@Handle"
                                  className="w-full px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-indigo-300"
                                />
                              </div>
                            ) : (
                              <>
                                <div className="font-semibold text-white">{mint.projectName}</div>
                                <div className="text-xs text-slate-400 font-mono">
                                  {mint.twitterHandle ? `${mint.twitterHandle} · ` : ''}slug: {mint.collectionSlug}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="py-3.5 px-4 font-mono tabular-nums text-xs">
                            <div className="text-slate-200">
                              {chain ? `${chain.name} (${chain.chainId})` : `Chain ${mint.chainId}`}
                            </div>
                            <div className="text-slate-400 mt-0.5">
                              {mint.contractAddress ? (
                                <span>{mint.contractAddress.slice(0, 10)}...{mint.contractAddress.slice(-6)}</span>
                              ) : (
                                <span className="text-amber-400/90">Unverified / Not Published</span>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-mono tabular-nums text-xs">
                            {isEditing ? (
                              <input
                                type="text"
                                value={inlineEditStartUtc}
                                onChange={(e) => setInlineEditStartUtc(e.target.value)}
                                className="w-44 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-white"
                              />
                            ) : (
                              <>
                                <div className="text-slate-200">{mint.mintStartUtc.replace('T', ' ').slice(0, 16)} UTC</div>
                                <div className="text-slate-500 mt-0.5">
                                  &lt;t:{Math.floor(new Date(mint.mintStartUtc).getTime() / 1000)}:t&gt;
                                </div>
                              </>
                            )}
                          </td>
                          <td className="py-3.5 px-4 font-mono tabular-nums text-xs">
                            {isEditing ? (
                              <div className="space-y-1.5">
                                <input
                                  type="text"
                                  value={inlineEditPrice}
                                  onChange={(e) => setInlineEditPrice(e.target.value)}
                                  placeholder="Price (0 for Free)"
                                  className="w-28 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-white"
                                />
                                <input
                                  type="text"
                                  value={inlineEditSupply}
                                  onChange={(e) => setInlineEditSupply(e.target.value)}
                                  placeholder="Supply"
                                  className="w-28 px-2 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-white"
                                />
                              </div>
                            ) : (
                              <>
                                <div className="text-slate-200 capitalize">
                                  {mint.category} · Supply: {mint.totalSupply || 'TBA'}
                                </div>
                                <div className="text-slate-400 mt-0.5">
                                  {mint.mintPriceExact === '0'
                                    ? 'Free'
                                    : mint.mintPriceExact !== null
                                    ? `${mint.mintPriceExact} ${mint.mintPriceSymbol || 'ETH'}`
                                    : 'TBA'}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-xs">
                            <div className="flex items-center gap-1.5">
                              {mint.verificationStatus === 'verified' ? (
                                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                              ) : (
                                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                              )}
                              <span
                                className={
                                  mint.verificationStatus === 'verified'
                                    ? 'text-emerald-400 font-medium'
                                    : 'text-amber-400 font-medium'
                                }
                              >
                                {mint.verificationStatus === 'verified' ? 'Verified' : 'Unverified'}
                              </span>
                              <span className="text-slate-500">·</span>
                              <span className="text-slate-400 font-mono">{mint.discoverySource}</span>
                            </div>
                            {mint.verificationNotes && (
                              <div className="text-slate-500 mt-0.5 max-w-xs truncate" title={mint.verificationNotes}>
                                {mint.verificationNotes}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void handleSaveInlineEdit(mint.id)}
                                    className="px-2.5 py-1 text-xs font-semibold rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingMintId(null)}
                                    className="px-2 py-1 text-xs font-medium rounded border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleStartInlineEdit(mint)}
                                    className="px-2.5 py-1 text-xs font-medium rounded border border-slate-700 hover:border-indigo-500 text-slate-200 transition-colors cursor-pointer"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleToggleMintVerification(mint)}
                                    className="px-2.5 py-1 text-xs font-medium rounded border border-slate-700 hover:border-slate-500 text-slate-200 transition-colors cursor-pointer"
                                  >
                                    {mint.verificationStatus === 'verified' ? 'Unverify' : 'Verify'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteMint(mint)}
                                    className="px-2 py-1 text-xs font-medium rounded border border-rose-900/70 hover:border-rose-500 text-rose-300 transition-colors cursor-pointer"
                                  >
                                    Remove
                                  </button>
                                  <a
                                    href={mint.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="p-1.5 text-slate-400 hover:text-white"
                                    title="Open Source Link"
                                  >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* =====================================================================
            VIEW 3: DISCOVERY ADAPTERS, SSRF WORKBENCH & CHAIN REGISTRY
           ===================================================================== */}
        {activeSection === 'discovery' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Modular Discovery Adapters & EVM Chain Registry (6 cols) */}
            <div className="lg:col-span-6 space-y-6">
              <div className="border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-white">01. Modular Discovery Source Adapters</h2>
                    <p className="text-xs text-slate-400">
                      Extensible adapter registry polling OpenSea v2, custom mint websites, and JSON calendars.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRunDiscovery}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Poll Adapters
                  </button>
                </div>

                <div className="divide-y divide-slate-800/80">
                  {appState?.adapters.map((adapter) => (
                    <div key={adapter.adapterId} className="py-3.5 first:pt-0 last:pb-0 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white">{adapter.adapterName}</span>
                        <span className="text-xs font-mono text-slate-400">
                          {adapter.configured ? 'Configured' : 'Awaiting .env Credentials'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">{adapter.statusMessage}</p>
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        Adapter ID: {adapter.adapterId} · Discovered last cycle: {adapter.discoveredCount}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Configurable EVM Chain Registry */}
              <div className="border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-white">02. Configurable EVM Chain Registry</h2>
                  <p className="text-xs text-slate-400">
                    Active EVM chains for contract validation, explorer links, and OpenSea drop discovery.
                  </p>
                </div>

                <div className="divide-y divide-slate-800/70 text-xs font-mono tabular-nums">
                  {appState?.chains.map((chain) => (
                    <div key={chain.chainId} className="py-2.5 flex items-center justify-between gap-4">
                      <div>
                        <span className="text-white font-semibold">{chain.name}</span>
                        <span className="text-slate-500"> · slug: {chain.slug} · ID: {chain.chainId}</span>
                      </div>
                      <span className="text-slate-400">{chain.explorerUrl}</span>
                    </div>
                  ))}
                </div>

                <form onSubmit={handleRegisterChain} className="pt-4 border-t border-slate-800 space-y-3">
                  <div className="text-xs font-semibold text-slate-300">Register Additional EVM Chain</div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Chain ID</label>
                      <input
                        type="number"
                        value={newChainId}
                        onChange={(e) => setNewChainId(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Slug</label>
                      <input
                        type="text"
                        value={newChainSlug}
                        onChange={(e) => setNewChainSlug(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Symbol</label>
                      <input
                        type="text"
                        value={newChainSymbol}
                        onChange={(e) => setNewChainSymbol(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Network Name</label>
                      <input
                        type="text"
                        value={newChainName}
                        onChange={(e) => setNewChainName(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Block Explorer URL</label>
                      <input
                        type="text"
                        value={newChainExplorer}
                        onChange={(e) => setNewChainExplorer(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors cursor-pointer"
                  >
                    Add Chain to Registry
                  </button>
                </form>
              </div>
            </div>

            {/* Right Column: SSRF Protection & Custom Website Parser Workbench (6 cols) */}
            <div className="lg:col-span-6 space-y-6">
              <div className="border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-white">03. SSRF Protection & Custom Mint Website Validator</h2>
                  <p className="text-xs text-slate-400">
                    Test how MintPulse validates submitted URLs against unsafe schemes, private RFC1918 networks, loopback addresses, and cloud metadata IPs before making any HTTP requests.
                  </p>
                </div>

                {/* Preset SSRF Vector Buttons */}
                <div className="space-y-1.5">
                  <div className="text-xs text-slate-400">Quick Security Test Presets:</div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setSsrfTestUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
                        setSsrfSampleHtml('');
                      }}
                      className="px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded hover:border-slate-500 text-slate-300 cursor-pointer"
                    >
                      Cloud Metadata (169.254.169.254)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSsrfTestUrl('http://127.0.0.1:5432/postgres');
                        setSsrfSampleHtml('');
                      }}
                      className="px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded hover:border-slate-500 text-slate-300 cursor-pointer"
                    >
                      Loopback (127.0.0.1)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSsrfTestUrl('http://10.0.14.88/internal-admin');
                        setSsrfSampleHtml('');
                      }}
                      className="px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded hover:border-slate-500 text-slate-300 cursor-pointer"
                    >
                      Private Network (10.0.14.88)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSsrfTestUrl('javascript:fetch("https://evil.example/steal")');
                        setSsrfSampleHtml('');
                      }}
                      className="px-2.5 py-1 text-xs font-mono bg-slate-900 border border-slate-700 rounded hover:border-slate-500 text-slate-300 cursor-pointer"
                    >
                      Unsafe Scheme (javascript:)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSsrfTestUrl('https://opensea.io/collection/ink-genesis-citizens/overview');
                        setSsrfSampleHtml(
                          `<meta name="nft:mint:project" content="Ink Genesis Citizens" />\n<meta name="nft:mint:chain" content="ink" />\n<meta name="nft:mint:start_time" content="2026-11-15T18:00:00Z" />\n<meta name="nft:mint:category" content="public" />\n<meta name="nft:mint:price" content="0.001" />\n<meta name="nft:mint:supply" content="2222" />`
                        );
                      }}
                      className="px-2.5 py-1 text-xs font-mono bg-indigo-950/50 border border-indigo-700 rounded hover:border-indigo-500 text-indigo-200 cursor-pointer"
                    >
                      Valid HTTPS + Meta Tags
                    </button>
                  </div>
                </div>

                <form onSubmit={handleValidateUrl} className="space-y-3">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Target URL to Validate</label>
                    <input
                      type="text"
                      value={ssrfTestUrl}
                      onChange={(e) => setSsrfTestUrl(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Optional Custom Mint HTML / JSON Payload (to test metadata parser)
                    </label>
                    <textarea
                      rows={4}
                      value={ssrfSampleHtml}
                      onChange={(e) => setSsrfSampleHtml(e.target.value)}
                      placeholder='<meta name="nft:mint:project" content="..." />'
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer"
                  >
                    Run SSRF & Metadata Inspector
                  </button>
                </form>

                {ssrfResult && (
                  <div className="pt-4 border-t border-slate-800 space-y-2 text-xs font-mono">
                    <div className="flex items-center gap-2">
                      {ssrfResult.validation.valid ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span className={ssrfResult.validation.valid ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                        {ssrfResult.validation.valid ? 'URL ALLOWED BY SSRF GUARD' : 'URL BLOCKED BY SSRF GUARD'}
                      </span>
                    </div>
                    {ssrfResult.validation.reason && (
                      <div className="text-rose-300">Reason: {ssrfResult.validation.reason}</div>
                    )}
                    {ssrfResult.validation.resolvedIps.length > 0 && (
                      <div className="text-slate-400">
                        Resolved DNS IPs: {ssrfResult.validation.resolvedIps.join(', ')}
                      </div>
                    )}
                    {ssrfResult.extractedMints.length > 0 && (
                      <div className="pt-2">
                        <div className="text-slate-300 mb-1">Parsed Normalized Mint Metadata:</div>
                        <pre className="p-3 bg-slate-950 rounded border border-slate-800 overflow-x-auto text-[11px] text-slate-300">
                          {JSON.stringify(ssrfResult.extractedMints, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* =====================================================================
            VIEW 4: PERSISTENT REMINDER QUEUE & IDEMPOTENCY ENGINE
           ===================================================================== */}
        {activeSection === 'reminders' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div>
                <h2 className="text-base font-semibold text-white">
                  Persistent Scheduled Reminders & Deduplication Queue
                </h2>
                <p className="text-xs text-slate-400">
                  Every reminder is keyed by <code>guild:&#123;guildId&#125;:mint:&#123;mintId&#125;:interval:&#123;minutes&#125;</code> with a unique database constraint to guarantee zero duplicate notifications across restarts.
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                {currentGuild && (
                  <button
                    type="button"
                    onClick={() => void handleTriggerDailyDigest(currentGuild.guildId)}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Dispatch Daily Digest Now ({currentGuild.guildName})
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetch('/api/reminders/sync', { method: 'POST' });
                    const data = await res.json();
                    await fetchState();
                    setActionBanner({
                      type: 'info',
                      text: `Synced schedules (${data.sync.newlyScheduledCount} new, ${data.sync.skippedDuplicateCount} deduplicated) and processed due queue (${data.dispatch.sentCount} sent, ${data.dispatch.skippedStaleCount} stale skipped).`,
                    });
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Sync & Process Due Queue Now
                </button>
              </div>
            </div>

            {appState?.scheduledReminders.length === 0 ? (
              <div className="border border-slate-800 rounded-xl p-10 text-center space-y-3 bg-[#111827]/40">
                <div className="text-base font-semibold text-white">No Scheduled Reminders in Queue</div>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Reminders are automatically generated for verified upcoming mints matching each server’s configured categories and intervals (24h, 1h, 15m).
                </p>
                <button
                  type="button"
                  onClick={handleSeedSandboxFixtures}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer"
                >
                  Load Sandbox Fixtures to Populate Queue
                </button>
              </div>
            ) : (
              <div className="border border-slate-800 rounded-xl overflow-x-auto bg-[#111827]/60">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs font-medium text-slate-400">
                      <th className="py-3.5 px-4">Idempotency Key</th>
                      <th className="py-3.5 px-4">Server (Guild)</th>
                      <th className="py-3.5 px-4">Lead Interval</th>
                      <th className="py-3.5 px-4">Scheduled For (UTC)</th>
                      <th className="py-3.5 px-4">Status</th>
                      <th className="py-3.5 px-4 text-right">Test Dispatch</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 text-xs font-mono tabular-nums">
                    {appState?.scheduledReminders.map((rem) => {
                      const guild = appState.guilds.find((g) => g.guildId === rem.guildId);
                      const mint = appState.mints.find((m) => m.id === rem.mintId);
                      return (
                        <tr key={rem.id} className="hover:bg-slate-800/30">
                          <td className="py-3 px-4">
                            <div className="text-slate-200">{rem.idempotencyKey}</div>
                            <div className="text-slate-500 font-sans">
                              Mint: {mint?.projectName ?? rem.mintId}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-sans">
                            <div className="text-slate-200 font-medium">{guild?.guildName ?? rem.guildId}</div>
                            <div className="text-slate-500 font-mono">
                              #{guild?.announcementChannelName ?? 'unconfigured'} ({guild?.timezone ?? 'UTC'})
                            </div>
                          </td>
                          <td className="py-3 px-4 text-slate-300">
                            {rem.intervalMinutes} min ({rem.intervalMinutes >= 60 ? `${rem.intervalMinutes / 60}h` : `${rem.intervalMinutes}m`})
                          </td>
                          <td className="py-3 px-4 text-slate-300">
                            {rem.scheduledForUtc.replace('T', ' ').slice(0, 19)} UTC
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={
                                rem.status === 'sent'
                                  ? 'text-emerald-400 font-semibold'
                                  : rem.status === 'pending'
                                  ? 'text-indigo-400 font-semibold'
                                  : rem.status === 'skipped'
                                  ? 'text-amber-400'
                                  : 'text-rose-400'
                              }
                            >
                              {rem.status.toUpperCase()}
                            </span>
                            {rem.dispatchedAtUtc && (
                              <div className="text-slate-500">
                                Sent: {rem.dispatchedAtUtc.slice(11, 19)} UTC
                              </div>
                            )}
                            {rem.lastError && <div className="text-rose-400">{rem.lastError}</div>}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => void handleTriggerSingleReminder(rem.id)}
                              className="px-2.5 py-1 text-xs font-sans font-medium rounded border border-slate-700 hover:border-indigo-500 text-slate-200 transition-colors cursor-pointer"
                            >
                              {rem.status === 'sent' ? 'Test Duplicate Block' : 'Dispatch Now'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* =====================================================================
            VIEW 5: SETUP & SUPABASE CREDENTIALS WIZARD
           ===================================================================== */}
        {activeSection === 'setup' && (
          <div className="space-y-8">
            <div className="border-b border-slate-800 pb-4">
              <h2 className="text-xl font-bold text-white">Setup Guide & Supabase Database Configuration</h2>
              <p className="text-xs text-slate-400 mt-1">
                Follow this guided walkthrough to connect your Supabase PostgreSQL database, obtain your Discord Bot credentials, and configure your environment.
              </p>
            </div>

            {/* 3 Step Cards Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Card 1: OpenSea API Key */}
              <div className="border border-slate-800 rounded-xl p-5 bg-[#111827]/70 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">1. OpenSea API Key</div>
                  <span className="text-[11px] font-mono text-emerald-400">
                    {appState?.adapters.find((a) => a.adapterId === 'opensea_v2')?.configured
                      ? 'Connected in Secrets'
                      : 'Ready'}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  You already have this! The OpenSea API key allows MintPulse to poll verified drop schedules on Ethereum, Base, Polygon, Arbitrum, and Optimism.
                </p>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Your OpenSea Key (for .env builder)</label>
                  <input
                    type="password"
                    value={wizardOpenSeaKey}
                    onChange={(e) => setWizardOpenSeaKey(e.target.value)}
                    placeholder="Paste your OpenSea key"
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-white"
                  />
                </div>
                <div className="text-[11px] text-slate-500">
                  Target variable: <code>OPENSEA_API_KEY</code>
                </div>
              </div>

              {/* Card 2: Discord Application & Bot Token */}
              <div className="border border-slate-800 rounded-xl p-5 bg-[#111827]/70 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">2. Discord Bot Credentials</div>
                  <span className="text-[11px] font-mono text-emerald-400">
                    {appState?.discordGateway.connected
                      ? `Online (${appState.discordGateway.botTag})`
                      : 'Developer Portal'}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {appState?.discordGateway.connected
                    ? `Live Gateway connected as ${appState.discordGateway.botTag} with Application ID ${appState.discordGateway.clientId}.`
                    : 'Create an application, copy the Application ID (Client ID), go to the Bot tab, and click Reset Token.'}
                </p>
                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-0.5">Application Client ID</label>
                    <input
                      type="text"
                      value={wizardDiscordClientId}
                      onChange={(e) => {
                        setWizardDiscordClientId(e.target.value);
                        setInviteClientId(e.target.value);
                      }}
                      className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-0.5">Bot Secret Token</label>
                    <input
                      type="password"
                      value={wizardDiscordToken}
                      onChange={(e) => setWizardDiscordToken(e.target.value)}
                      placeholder="Paste bot token (keep secret)"
                      className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-white"
                    />
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">
                  Target variables: <code>DISCORD_CLIENT_ID</code>, <code>DISCORD_BOT_TOKEN</code>
                </div>
              </div>

              {/* Card 3: Supabase PostgreSQL */}
              <div className="border border-slate-800 rounded-xl p-5 bg-[#111827]/70 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">3. Supabase Database</div>
                  <span className="text-[11px] font-mono text-emerald-400">
                    {appState?.storageMode === 'postgresql' ? 'Connected Live' : 'Supabase'}
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  MintPulse is 100% compatible with Supabase. Copy your project connection string and apply the migration schema in Supabase SQL Editor.
                </p>
                <div className="pt-1 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handleCopyMigrationSql}
                    className="w-full py-2 px-3 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors cursor-pointer"
                  >
                    {copiedSql ? '✓ Migration SQL Copied!' : 'Copy Migration SQL for Supabase'}
                  </button>
                  <div className="text-[11px] text-slate-400">
                    Paste and run inside Supabase <strong>SQL Editor</strong> &rarr; <strong>New Query</strong>.
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">
                  Target variable: <code>DATABASE_URL</code>
                </div>
              </div>
            </div>

            {/* Supabase Connection Tester & Syntax Checker */}
            <div className="border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-semibold text-white">Supabase Connection URI Validator</h3>
                  <p className="text-xs text-slate-400">
                    Test your Supabase connection string directly to verify connectivity, database credentials, and port accessibility before saving.
                  </p>
                </div>
                <a
                  href="https://supabase.com/dashboard/project/_/settings/database"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-indigo-400 hover:underline flex items-center gap-1 shrink-0"
                >
                  <span>Project Settings &rarr; Database</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Supabase PostgreSQL Connection URI (URI tab under Database Settings)
                  </label>
                  <input
                    type="text"
                    value={supabaseUri}
                    onChange={(e) => {
                      setSupabaseUri(e.target.value);
                      setSupabaseTestResult(null);
                    }}
                    placeholder="postgresql://postgres.[REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres"
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-700 rounded-lg text-white"
                  />
                </div>

                {supabaseUri.includes('[YOUR-PASSWORD]') && (
                  <div className="flex items-center gap-2 text-xs text-amber-400">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Remember to replace <code>[YOUR-PASSWORD]</code> with your actual Supabase database password!</span>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={testingSupabase || !supabaseUri.trim()}
                    onClick={handleTestSupabaseConnection}
                    className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {testingSupabase ? 'Testing Connection...' : 'Test Supabase Connection'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyMigrationSql}
                    className="px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors cursor-pointer"
                  >
                    {copiedSql ? '✓ Copied SQL!' : 'Copy Schema Migration SQL'}
                  </button>
                </div>

                {supabaseTestResult && (
                  <div
                    className={`p-3.5 rounded-lg border text-xs font-mono ${
                      supabaseTestResult.success
                        ? 'bg-emerald-950/40 border-emerald-700 text-emerald-200'
                        : 'bg-rose-950/40 border-rose-700 text-rose-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {supabaseTestResult.success ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      )}
                      <span className="font-semibold">{supabaseTestResult.message}</span>
                    </div>
                    {supabaseTestResult.version && (
                      <div className="mt-1 text-slate-400">Engine: {supabaseTestResult.version}</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Generated .env Configuration Exporter */}
            <div className="border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-semibold text-white">Generated .env Configuration</h3>
                  <p className="text-xs text-slate-400">
                    Live environment file generated from your keys and database URI above.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyGeneratedEnv}
                  className="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer"
                >
                  {copiedEnv ? '✓ .env Copied!' : 'Copy .env File'}
                </button>
              </div>

              <pre className="p-4 bg-slate-950 rounded-lg border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto">
{`# MintPulse Configuration (.env)
DISCORD_BOT_TOKEN="${wizardDiscordToken.trim() || 'YOUR_DISCORD_BOT_TOKEN_HERE'}"
DISCORD_CLIENT_ID="${wizardDiscordClientId.trim() || 'YOUR_DISCORD_APPLICATION_CLIENT_ID_HERE'}"
DATABASE_URL="${supabaseUri.trim() || 'postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres'}"
OPENSEA_API_KEY="${wizardOpenSeaKey.trim() || 'YOUR_OPENSEA_API_KEY'}"
DEFAULT_REMINDER_INTERVALS="1440,60,15"
OVERDUE_GRACE_MINUTES="30"
PORT="3000"
LOG_LEVEL="info"`}
              </pre>
            </div>

            {/* Discord Bot Invitation URL & Automated Tests */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Bot Invitation Card (6 cols) */}
              <div className="lg:col-span-6 border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
                <h3 className="text-base font-semibold text-white">Discord Bot Server Invite URL</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Requires <code>bot</code> and <code>applications.commands</code> scopes with permission integer <code>84992</code> (View Channels, Send Messages, Embed Links, Read Message History).
                </p>
                <pre className="p-3 bg-slate-950 rounded border border-slate-800 text-[11px] font-mono text-indigo-300 overflow-x-auto">
                  {`https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(
                    wizardDiscordClientId.trim() || 'YOUR_CLIENT_ID'
                  )}&permissions=84992&scope=bot%20applications.commands`}
                </pre>
                <a
                  href={`https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(
                    wizardDiscordClientId.trim() || '129485761029384756'
                  )}&permissions=84992&scope=bot%20applications.commands`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                >
                  <span>Authorize & Invite Bot to Server</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>

              {/* Automated Reliability Test Suite (6 cols) */}
              <div className="lg:col-span-6 border border-slate-800 rounded-xl p-6 bg-[#111827]/70 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-base font-semibold text-white">Automated Test Verification</h3>
                    <p className="text-xs text-slate-400">
                      Tests SSRF protection, discovery, idempotency, DST timezones, and permissions.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={runningTests}
                    onClick={handleRunAutomatedTests}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {runningTests ? 'Testing...' : 'Run All Tests'}
                  </button>
                </div>

                {testSummary ? (
                  <div className="space-y-2 text-xs font-mono">
                    <div className="flex items-center justify-between text-emerald-400 font-semibold">
                      <span>✓ All {testSummary.passed} / {testSummary.total} Tests Passed</span>
                      <span className="text-slate-400 tabular-nums">{testSummary.durationMs}ms</span>
                    </div>
                    <div className="space-y-1 divide-y divide-slate-800/60 max-h-48 overflow-y-auto">
                      {testSummary.results.map((t) => (
                        <div key={t.id} className="pt-1.5 flex items-center justify-between text-[11px]">
                          <span className="text-slate-300">{t.name}</span>
                          <span className="text-slate-500 tabular-nums">{t.durationMs}ms</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 font-mono">
                    Click "Run All Tests" or run <code>npm test</code> in your terminal.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Quiet Open-Source Footer */}
      <footer className="mt-auto border-t border-slate-800/80 px-6 py-4 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4 max-w-[1380px] w-full mx-auto">
        <div>MintPulse Open-Source Discord NFT Mint Reminder Bot · MIT License</div>
        <div className="font-mono tabular-nums">
          Allowed Chains: Ethereum (1) · Robinhood Chain (747474) · Ink Chain (57073)
        </div>
      </footer>
    </div>
  );
}

/**
 * Renders a faithful plain Discord message matching the user's screenshot:
 * - @Handle lines rendered as Discord blurple mention pills
 * - <t:UNIX:t> tags rendered in the viewer's local browser timezone pill
 * - https://... URLs rendered as clickable blue Discord links
 */
function DiscordPlainMessageView({ content }: { content: string }) {
  const lines = content.split('\n');

  const renderLine = (line: string, idx: number) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return <div key={idx} className="h-3" />;
    }

    // Role mention line (<@&123456>)
    if (/^<@&\d+>/.test(trimmed)) {
      return (
        <div key={idx} className="pb-1">
          <span className="px-1.5 py-0.5 rounded bg-[#5865F2]/30 text-[#C9CDFB] font-medium text-xs">
            {trimmed}
          </span>
        </div>
      );
    }

    // @Handle header line
    if (trimmed.startsWith('@')) {
      return (
        <div key={idx} className="pt-0.5">
          <span className="px-1 py-0.5 rounded bg-[#5865F2]/30 text-[#C9CDFB] hover:bg-[#5865F2] hover:text-white transition-colors font-medium text-[15px] cursor-pointer">
            {trimmed}
          </span>
        </div>
      );
    }

    // Bullet line with <t:UNIX:t>
    const timeMatch = trimmed.match(/^(•\s*Time\s*:\s*)<t:(\d+):([tTdDfFR])>(.*)$/i);
    if (timeMatch) {
      const prefix = timeMatch[1];
      const unixSec = Number(timeMatch[2]);
      const dateObj = new Date(unixSec * 1000);
      const localShortTime = dateObj.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const fullTooltip = dateObj.toLocaleString([], {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      return (
        <div key={idx} className="text-[15px] text-[#DBDEE1] leading-snug pl-2 flex items-center gap-1.5 flex-wrap">
          <span>{prefix}</span>
          <span
            title={`${fullTooltip} (Discord <t:${unixSec}:t> Auto Local Time)`}
            className="px-1.5 py-0.5 rounded bg-[#383A40] text-[#F2F3F5] text-sm font-medium cursor-help"
          >
            {localShortTime}
          </span>
        </div>
      );
    }

    // Bullet line with URL (• Mint page : https://...)
    const urlMatch = trimmed.match(/^(•\s*Mint page\s*:\s*)(https?:\/\/\S+)(.*)$/i);
    if (urlMatch) {
      const prefix = urlMatch[1];
      const url = urlMatch[2];
      return (
        <div key={idx} className="text-[15px] text-[#DBDEE1] leading-snug pl-2 break-all">
          <span>{prefix}</span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-[#00A8FC] hover:underline"
          >
            {url}
          </a>
        </div>
      );
    }

    // Standard bullet line (• Chain : ..., • Price : ..., • Supply : ...)
    if (trimmed.startsWith('•')) {
      return (
        <div key={idx} className="text-[15px] text-[#DBDEE1] leading-snug pl-2">
          {trimmed}
        </div>
      );
    }

    return (
      <div key={idx} className="text-sm text-[#DBDEE1] leading-relaxed">
        {line}
      </div>
    );
  };

  return <div className="space-y-0.5 font-sans select-text">{lines.map((line, i) => renderLine(line, i))}</div>;
}

/**
 * Renders a faithful Discord Embed preview inside the Simulator
 */
function DiscordEmbedView({ embed }: { embed: DiscordEmbedPayload }) {
  const accentClass =
    embed.color === 0x10b981
      ? 'border-emerald-500'
      : embed.color === 0xef4444
      ? 'border-rose-500'
      : embed.color === 0xf59e0b
      ? 'border-amber-500'
      : 'border-indigo-500';

  return (
    <div
      className={`rounded bg-[#2B2D31] border border-black/20 border-t-2 ${accentClass} p-4 max-w-2xl space-y-3`}
    >
      <div className="space-y-1">
        {embed.url ? (
          <a
            href={embed.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold text-indigo-400 hover:underline inline-flex items-center gap-1"
          >
            <span>{embed.title}</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <div className="text-sm font-semibold text-white">{embed.title}</div>
        )}
        <p className="text-xs text-slate-300 whitespace-pre-line leading-relaxed">{embed.description}</p>
      </div>

      {embed.fields.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {embed.fields.map((f, i) => (
            <div key={i} className={f.inline ? 'col-span-1' : 'col-span-1 sm:col-span-2'}>
              <div className="text-[11px] font-semibold text-slate-400">{f.name}</div>
              <div className="text-xs text-slate-200 font-mono whitespace-pre-line mt-0.5">{f.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="pt-2 border-t border-slate-700/50 flex items-center justify-between text-[11px] text-slate-400 font-mono tabular-nums">
        <span>{embed.footer.text}</span>
        <span>{new Date(embed.timestamp).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
