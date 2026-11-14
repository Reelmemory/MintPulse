/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Discord.js v14 Gateway Client & Slash Command Registrar
 * Connects to the live Discord Gateway when DISCORD_BOT_TOKEN is provided,
 * automatically resolves the verified Application Client ID from the bot session,
 * registers slash commands (/setup, /mints today|week|digest, /mint watch|add|edit|remove, /settings, /help),
 * and routes live channel reminder and daily digest deliveries in the 5-bullet plain message format.
 */

import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';
import { logger } from '../logger.ts';
import { DeliveryTransportResult, ReminderEngine } from '../scheduler/reminderEngine.ts';
import {
  DiscordEmbedPayload,
  GuildSettings,
  ScheduledReminder,
  SlashCommandInvocation,
} from '../types.ts';
import { DiscordCommandProcessor } from './commandHandler.ts';
import { splitDiscordPlainMessage } from './embedBuilder.ts';

/**
 * Builds the official Discord API v10 Slash Command JSON definitions.
 */
export function buildDiscordSlashCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const setupCmd = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the NFT mint announcement channel, optional @Role tag, and Daily Digest (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Target text channel for NFT mint announcements')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addRoleOption((opt) =>
      opt
        .setName('role')
        .setDescription('Optional @Role to mention when scheduled mint reminders fire')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('daily_digest')
        .setDescription('Optional automated Daily Digest time in 24h UTC (e.g. "13:00" or "off")')
        .setRequired(false)
    );

  const mintsCmd = new SlashCommandBuilder()
    .setName('mints')
    .setDescription('List upcoming NFT mints in your automatic local time (Ethereum, Robinhood Chain & Ink Chain)')
    .addSubcommand((sub) =>
      sub.setName('today').setDescription('Show upcoming NFT mints scheduled in the next 24 hours')
    )
    .addSubcommand((sub) =>
      sub.setName('week').setDescription('Show upcoming NFT mints scheduled in the next 7 days')
    )
    .addSubcommand((sub) =>
      sub.setName('digest').setDescription('Post or preview the Daily NFT Mint Digest immediately')
    );

  const mintCmd = new SlashCommandBuilder()
    .setName('mint')
    .setDescription('Watch, add, edit, or remove an NFT mint collection (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('watch')
        .setDescription('Prioritize a specific NFT collection slug, name, or 0x contract address')
        .addStringOption((opt) =>
          opt
            .setName('collection')
            .setDescription('Collection slug (e.g. computersrh-nft) or 0x contract address')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Submit a custom NFT mint URL or manual drop record (SSRF-guarded)')
        .addStringOption((opt) =>
          opt.setName('url').setDescription('Public HTTPS mint website or OpenSea collection URL').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Collection or project name (if website lacks meta tags)')
        )
        .addStringOption((opt) =>
          opt
            .setName('chain')
            .setDescription('EVM Chain (Strictly Ethereum, Robinhood Chain, or Ink Chain)')
            .addChoices(
              { name: 'Ethereum (Chain ID 1)', value: 'ethereum' },
              { name: 'Robinhood Chain (Chain ID 747474)', value: 'robinhood' },
              { name: 'Ink Chain (Chain ID 57073)', value: 'ink' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('start_time').setDescription('Mint start time in ISO-8601 UTC (e.g. 2026-05-15T16:00:00Z)')
        )
        .addStringOption((opt) =>
          opt
            .setName('category')
            .setDescription('Mint category (free, allowlist, or public)')
            .addChoices(
              { name: 'Free Mint', value: 'free' },
              { name: 'Allowlist / Whitelist', value: 'allowlist' },
              { name: 'Public Mint', value: 'public' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('price').setDescription('Mint price (e.g. "Free", "0.025", or "TBA")')
        )
        .addStringOption((opt) =>
          opt.setName('supply').setDescription('Total NFT supply (e.g. "3333", "999", or "TBA")')
        )
        .addStringOption((opt) =>
          opt.setName('handle').setDescription('Project X/Twitter handle (e.g. "@ComputersRh")')
        )
        .addStringOption((opt) =>
          opt.setName('contract').setDescription('Optional verified 0x EVM contract address')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Edit an existing NFT mint time, price, supply, @handle, chain, or URL (Admin only)')
        .addStringOption((opt) =>
          opt
            .setName('query')
            .setDescription('Collection slug, project name, @handle, or 0x contract to update')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Updated project / collection name')
        )
        .addStringOption((opt) =>
          opt.setName('handle').setDescription('Updated X/Twitter @handle (e.g. "@ComputersRh")')
        )
        .addStringOption((opt) =>
          opt
            .setName('chain')
            .setDescription('Updated EVM Chain')
            .addChoices(
              { name: 'Ethereum (Chain ID 1)', value: 'ethereum' },
              { name: 'Robinhood Chain (Chain ID 747474)', value: 'robinhood' },
              { name: 'Ink Chain (Chain ID 57073)', value: 'ink' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('start_time').setDescription('Updated mint start time in ISO-8601 UTC (e.g. 2026-10-19T16:00:00Z)')
        )
        .addStringOption((opt) =>
          opt
            .setName('category')
            .setDescription('Updated mint category')
            .addChoices(
              { name: 'Free Mint', value: 'free' },
              { name: 'Allowlist / Whitelist', value: 'allowlist' },
              { name: 'Public Mint', value: 'public' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('price').setDescription('Updated mint price (e.g. "Free", "0.0004", or "TBA")')
        )
        .addStringOption((opt) =>
          opt.setName('supply').setDescription('Updated total supply (e.g. "3333" or "TBA")')
        )
        .addStringOption((opt) =>
          opt.setName('url').setDescription('Updated HTTPS mint page URL (SSRF-guarded)')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a cancelled or outdated NFT mint and clear its pending reminders (Admin only)')
        .addStringOption((opt) =>
          opt
            .setName('query')
            .setDescription('Collection slug, project name, @handle, or 0x contract to delete')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('source')
        .setDescription('Connect a website or JSON drop feed for MintPulse to get upcoming mints from (Admin only)')
        .addStringOption((opt) =>
          opt
            .setName('url')
            .setDescription('Public HTTPS website/feed URL, "list", "clear", or "remove:<url>"')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('label').setDescription('Optional name for this website source (e.g. "Robinhood Drops")')
        )
    );

  const settingsCmd = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure reminder lead times, categories, @Role tag, and Daily Digest schedule (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('intervals')
        .setDescription('Comma-separated lead times (e.g. "24h,1h,15m" or "60,15")')
    )
    .addStringOption((opt) =>
      opt
        .setName('categories')
        .setDescription('Comma-separated categories to announce: free,allowlist,public')
    )
    .addRoleOption((opt) =>
      opt
        .setName('role')
        .setDescription('Update the @Role to tag on scheduled mint reminders')
    )
    .addStringOption((opt) =>
      opt
        .setName('daily_digest')
        .setDescription('Automated Daily Digest time in 24h UTC (e.g. "13:00", "on", or "off")')
    )
    .addBooleanOption((opt) =>
      opt
        .setName('include_unverified_watched')
        .setDescription('Whether to schedule reminders for unverified drops if they are on the watchlist')
    );

  const helpCmd = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Learn how all MintPulse commands, @Role tags, Daily Digests, and local timestamps work');

  return [
    setupCmd.toJSON(),
    mintsCmd.toJSON(),
    mintCmd.toJSON(),
    settingsCmd.toJSON(),
    helpCmd.toJSON(),
  ];
}

function toDiscordJsEmbed(payload: DiscordEmbedPayload): EmbedBuilder {
  const builder = new EmbedBuilder()
    .setTitle(payload.title)
    .setDescription(payload.description)
    .setColor(payload.color)
    .setFooter({ text: payload.footer.text })
    .setTimestamp(new Date(payload.timestamp));

  if (payload.url) {
    builder.setURL(payload.url);
  }

  if (payload.fields.length > 0) {
    builder.addFields(
      payload.fields.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline ?? false,
      }))
    );
  }

  return builder;
}

/**
 * Wraps bare URLs in `<...>` so Discord natively renders clickable blue links
 * while suppressing automatic link preview embeds across all message types.
 */
function wrapUrlsToSuppressPreviews(text: string): string {
  return text.replace(/(?<!<)(https?:\/\/[^\s>]+)(?!>)/g, '<$1>');
}

export class DiscordBotRuntime {
  private client: Client | null = null;
  private commandProcessor: DiscordCommandProcessor;
  private reminderEngine: ReminderEngine;
  private connected = false;
  private botTag: string | null = null;
  private resolvedClientId: string | null = null;
  private statusDetail: string = '';

  constructor(commandProcessor: DiscordCommandProcessor, reminderEngine: ReminderEngine) {
    this.commandProcessor = commandProcessor;
    this.reminderEngine = reminderEngine;
  }

  public isConfigured(): boolean {
    return Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_BOT_TOKEN.trim() !== '');
  }

  public getStatus(): {
    configured: boolean;
    connected: boolean;
    botTag: string | null;
    applicationId: string | null;
    note: string;
  } {
    return {
      configured: this.isConfigured(),
      connected: this.connected,
      botTag: this.botTag,
      applicationId: this.resolvedClientId,
      note:
        this.statusDetail ||
        (this.connected
          ? `Connected to Discord Gateway as ${this.botTag}`
          : this.isConfigured()
          ? 'DISCORD_BOT_TOKEN configured; initializing Gateway session'
          : 'Set DISCORD_BOT_TOKEN in .env to connect live Discord Gateway; Web Simulator is active.'),
    };
  }

  public async startIfConfigured(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info(
        'DiscordBot',
        'DISCORD_BOT_TOKEN not provided; running in Web Simulator & API mode. Set DISCORD_BOT_TOKEN in .env to connect to Discord Gateway.'
      );
      return;
    }

    const token = process.env.DISCORD_BOT_TOKEN!.trim();
    const devGuildId = process.env.DISCORD_DEV_GUILD_ID?.trim();

    try {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds],
      });

      this.client.on('error', (err) => {
        logger.warn('DiscordBot', 'Discord Gateway client error (auto-reconnecting)', {
          error: err.message,
        });
      });

      this.client.once('ready', async (readyClient) => {
        this.connected = true;
        this.botTag = readyClient.user.tag;
        const canonicalAppId = readyClient.application?.id || readyClient.user.id;
        this.resolvedClientId = canonicalAppId;
        this.statusDetail = `Connected to Discord Gateway as ${readyClient.user.tag} (App ID: ${canonicalAppId})`;

        logger.info('DiscordBot', `Connected to Discord Gateway as ${readyClient.user.tag}`, {
          applicationId: canonicalAppId,
        });

        await this.registerSlashCommandsSafely(token, canonicalAppId, devGuildId);
      });

      this.client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        try {
          await this.handleGatewayInteraction(interaction);
        } catch (err) {
          logger.error('DiscordBot', 'Unhandled exception in interactionCreate listener', {
            commandName: interaction.commandName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      await this.client.login(token);

      // Wire live Discord channel delivery (plain 5-bullet message with SuppressEmbeds, chunking, and @Role mention)
      this.reminderEngine.setDeliveryTransport(
        async (
          guild: GuildSettings,
          _embed: DiscordEmbedPayload,
          _reminder: ScheduledReminder,
          plainContent?: string
        ): Promise<DeliveryTransportResult> => {
          if (!this.client || !this.connected) {
            return { success: false, errorMessage: 'Discord Gateway client is not connected.' };
          }
          if (!guild.announcementChannelId) {
            return { success: false, channelUnavailable: true, errorMessage: 'No announcement channel configured.' };
          }

          const isSimulatorGuild =
            guild.guildId === '109283746510293847' ||
            guild.guildId === '204958673829104958' ||
            !this.client.guilds.cache.has(guild.guildId);
          if (isSimulatorGuild) {
            return { success: true };
          }

          try {
            const channel = await this.client.channels.fetch(guild.announcementChannelId);
            if (!channel || !channel.isTextBased()) {
              return {
                success: false,
                channelUnavailable: true,
                errorMessage: 'Configured channel no longer exists or is not a text channel.',
              };
            }

            const rawText = plainContent || _embed.description;
            const formattedText = wrapUrlsToSuppressPreviews(rawText);
            const chunks = splitDiscordPlainMessage(formattedText, 1900);

            for (const chunk of chunks) {
              await (channel as TextChannel).send({
                content: chunk,
                flags: MessageFlags.SuppressEmbeds,
                allowedMentions: guild.pingRoleId ? { roles: [guild.pingRoleId] } : { parse: [] },
              });
            }
            return { success: true };
          } catch (err: unknown) {
            const code = (err as { code?: number; status?: number })?.code;
            const status = (err as { status?: number })?.status;
            const msg = err instanceof Error ? err.message : String(err);

            if (status === 429) {
              return { success: false, rateLimitedRetryMs: 5000, errorMessage: msg };
            }
            if (code === 10003) {
              return { success: false, channelUnavailable: true, errorMessage: `Unknown Channel (10003): ${msg}` };
            }
            if (code === 50013 || code === 50001) {
              return { success: false, missingPermissions: true, errorMessage: `Missing Permissions (${code}): ${msg}` };
            }
            return { success: false, errorMessage: msg };
          }
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.statusDetail = `Discord Gateway connection skipped (${msg}); Web Simulator remains active.`;
      logger.warn('DiscordBot', 'Could not establish live Discord Gateway session; running in Web Simulator mode', {
        reason: msg,
      });
    }
  }

  private async registerSlashCommandsSafely(
    token: string,
    applicationId: string,
    devGuildId?: string
  ): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(token);
    const commandsJson = buildDiscordSlashCommandDefinitions();

    if (devGuildId && /^\d{15,22}$/.test(devGuildId)) {
      try {
        await rest.put(Routes.applicationGuildCommands(applicationId, devGuildId), { body: commandsJson });
        logger.info('DiscordBot', `Registered slash commands to guild ${devGuildId}`);
        return;
      } catch (guildErr) {
        logger.warn(
          'DiscordBot',
          `Could not register guild-scoped commands for ${devGuildId}; falling back to global application commands`,
          { reason: guildErr instanceof Error ? guildErr.message : String(guildErr) }
        );
      }
    }

    try {
      await rest.put(Routes.applicationCommands(applicationId), { body: commandsJson });
      logger.info('DiscordBot', `Registered global slash commands for application ${applicationId}`);
    } catch (err) {
      logger.warn('DiscordBot', 'Slash command registration deferred', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleGatewayInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const commandName = interaction.commandName as SlashCommandInvocation['commandName'];
    const subcommand = interaction.options.getSubcommand(false) as SlashCommandInvocation['subcommand'] | null;

    const hasManageGuild = Boolean(
      !interaction.guildId ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    );

    const commandNameRaw = String(interaction.commandName);
    const requiresAdmin =
      commandNameRaw === 'setup' ||
      commandNameRaw === 'settings' ||
      commandNameRaw === 'mint';

    const shouldDeferEphemeral =
      commandNameRaw === 'setup' ||
      commandNameRaw === 'settings' ||
      commandNameRaw === 'help' ||
      commandNameRaw === 'timezone' ||
      (requiresAdmin && !hasManageGuild);

    // Acknowledge the interaction immediately (<100ms) so Discord's 3-second timeout is never hit
    await interaction.deferReply({
      flags: shouldDeferEphemeral ? MessageFlags.Ephemeral : undefined,
    });

    try {
      const options: Record<string, string | boolean | number | undefined> = {};
      if (commandName === 'setup') {
        const ch = interaction.options.getChannel('channel');
        if (ch) {
          options.channel_id = ch.id;
          options.channel_name = ch.name ?? 'announcements';
        }
        const role = interaction.options.getRole('role');
        if (role) {
          options.role_id = role.id;
          options.role_name = role.name;
        }
        options.daily_digest = interaction.options.getString('daily_digest') ?? undefined;
      } else if (commandName === 'settings') {
        options.intervals = interaction.options.getString('intervals') ?? undefined;
        options.categories = interaction.options.getString('categories') ?? undefined;
        const role = interaction.options.getRole('role');
        if (role) {
          options.role_id = role.id;
          options.role_name = role.name;
        }
        options.daily_digest = interaction.options.getString('daily_digest') ?? undefined;
        const inc = interaction.options.getBoolean('include_unverified_watched');
        if (inc !== null) options.include_unverified_watched = inc;
      } else if (commandName === 'mint' && subcommand === 'watch') {
        options.collection = interaction.options.getString('collection') ?? undefined;
      } else if (commandName === 'mint' && subcommand === 'add') {
        options.url = interaction.options.getString('url') ?? undefined;
        options.name = interaction.options.getString('name') ?? undefined;
        options.chain = interaction.options.getString('chain') ?? undefined;
        options.start_time = interaction.options.getString('start_time') ?? undefined;
        options.category = interaction.options.getString('category') ?? undefined;
        options.price = interaction.options.getString('price') ?? undefined;
        options.supply = interaction.options.getString('supply') ?? undefined;
        options.handle = interaction.options.getString('handle') ?? undefined;
        options.contract = interaction.options.getString('contract') ?? undefined;
      } else if (commandName === 'mint' && subcommand === 'edit') {
        options.query = interaction.options.getString('query') ?? undefined;
        options.name = interaction.options.getString('name') ?? undefined;
        options.handle = interaction.options.getString('handle') ?? undefined;
        options.chain = interaction.options.getString('chain') ?? undefined;
        options.start_time = interaction.options.getString('start_time') ?? undefined;
        options.category = interaction.options.getString('category') ?? undefined;
        options.price = interaction.options.getString('price') ?? undefined;
        options.supply = interaction.options.getString('supply') ?? undefined;
        options.url = interaction.options.getString('url') ?? undefined;
      } else if (commandName === 'mint' && subcommand === 'remove') {
        options.query = interaction.options.getString('query') ?? undefined;
      } else if (commandName === 'mint' && subcommand === 'source') {
        options.url = interaction.options.getString('url') ?? undefined;
        options.label = interaction.options.getString('label') ?? undefined;
      }

      const guildId = interaction.guildId ?? `dm-${interaction.user.id}`;
      const guildName = interaction.guild?.name ?? 'Direct Message';

      logger.info(
        'DiscordBot',
        `Received Discord Gateway command /${commandNameRaw}${subcommand ? ' ' + subcommand : ''}`,
        {
          guildId,
          userTag: interaction.user.tag,
        }
      );

      const result = await this.commandProcessor.executeCommand({
        guildId,
        guildName,
        channelId: interaction.channelId,
        channelName: (interaction.channel && 'name' in interaction.channel && interaction.channel.name) || 'general',
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        hasManageGuildPermission: hasManageGuild,
        commandName,
        subcommand: subcommand ?? undefined,
        options,
      });

      const embeds = result.embeds.map(toDiscordJsEmbed);
      const rawContent = result.content
        ? result.suppressEmbeds
          ? wrapUrlsToSuppressPreviews(result.content)
          : result.content
        : undefined;

      if (rawContent) {
        const chunks = splitDiscordPlainMessage(rawContent, 1900);
        await interaction.editReply({
          content: chunks[0],
          embeds: embeds.length > 0 ? embeds : [],
          allowedMentions: { parse: [] },
        });

        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({
            content: chunks[i],
            flags: shouldDeferEphemeral ? MessageFlags.Ephemeral : undefined,
            allowedMentions: { parse: [] },
          });
        }
      } else {
        await interaction.editReply({
          content: embeds.length === 0 ? 'Command completed.' : undefined,
          embeds,
          allowedMentions: { parse: [] },
        });
      }
    } catch (cmdErr) {
      const errMsg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
      logger.error('DiscordBot', `Error executing /${commandNameRaw}`, { error: errMsg });

      await interaction
        .editReply({
          content: `Could not complete \`/${commandNameRaw}\`: ${errMsg.slice(0, 300)}`,
          embeds: [],
        })
        .catch(() => {});
    }
  }
}
