# MintPulse — Open-Source Discord NFT Mint Reminder Bot

MintPulse is a production-ready, open-source Discord bot and modular discovery engine that tracks upcoming **NFT mints** across supported EVM chains (**Ethereum, Base, Polygon, Arbitrum One, and Optimism**) and dispatches scheduled, deduplicated reminders to Discord servers.

> **Scope Notice:** MintPulse is strictly built for **NFT Mints only** (`Free`, `Allowlist/Whitelist`, and `Public` phases). It does **not** implement raffles, raffle reminders, sweepstakes, or raffle-related commands. Also note that MintPulse only indexes mints available from configured discovery adapters and community submissions—it does not claim comprehensive coverage of every NFT mint across all blockchains.

---

## Architecture Overview

MintPulse is cleanly separated into five independent modules under `src/core/`:

1. **Chain Registry (`src/core/chains.ts`)**: Configurable EVM network registry with block explorer link builders, chain ID mapping, and EVM `0x` contract validation.
2. **Modular Discovery Engine (`src/core/discovery/`)**:
   - **OpenSea API Adapter (`openSeaAdapter.ts`)**: Queries OpenSea API v2 for eligible upcoming drops and collection metadata when `OPENSEA_API_KEY` is provided.
   - **Custom Website Adapter (`customWebsiteAdapter.ts`)**: Extracts structured JSON-LD / `<meta name="nft:mint:*">` drop manifests from approved mint websites through an SSRF-protected fetcher.
   - **Calendar Feed Adapter (`calendarApiAdapter.ts`)**: Consumes extensible JSON mint calendar feeds.
   - **User Submission Service (`userSubmissionService.ts`)**: Validates community-submitted mint URLs via `/mint add` and marks them clearly as `unverified` until verified.
3. **Data Verification & Security (`src/core/verification/` & `src/core/security/ssrfGuard.ts`)**:
   - Rejects unsafe URL schemes (`javascript:`, `file:`, `ftp:`, `data:`) and private/internal IP ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`, IPv6 loopback/unique-local) before making outbound requests.
   - Never fabricates mint dates, prices, or smart contracts. Missing fields are stored as `null` and displayed as `Unverified / TBA`.
4. **PostgreSQL Storage & Idempotent Reminder Engine (`src/core/storage/` & `src/core/scheduler/reminderEngine.ts`)**:
   - Persists servers, watchlists, normalized mints, and scheduled reminder jobs in PostgreSQL (`migrations/001_initial_schema.sql`).
   - Enforces `UNIQUE (idempotency_key)` (`guild:{guildId}:mint:{mintId}:interval:{minutes}`) so restarts never cause duplicate Discord pings.
   - Handles IANA timezones and Daylight Saving Time (DST) transitions via `Intl.DateTimeFormat`.
   - Safely recovers overdue reminders after short downtime (within `OVERDUE_GRACE_MINUTES`, default 30m) while skipping stale notifications.
5. **Discord Delivery & Slash Commands (`src/core/discord/`)**:
   - Implements `/setup`, `/mints today`, `/mints week`, `/mint watch`, `/mint add`, `/settings`, and `/timezone`.
   - Enforces Discord `ManageGuild` / `Administrator` permissions on server configuration commands and isolates each server's settings.

---

## Supported Slash Commands

| Slash Command | Permission Required | Description |
| :--- | :--- | :--- |
| `/setup #channel` | `Manage Server` / `Admin` | Configure the server's NFT mint announcement channel. |
| `/mints today` | Everyone | Show upcoming NFT mints for the current day in the server's configured timezone. |
| `/mints week` | Everyone | Show upcoming NFT mints for the next 7 days in the server's configured timezone. |
| `/mint watch <slug_or_contract>` | Everyone | Follow a specific collection or project for priority server tracking. |
| `/mint add <url> <name> <chain> <start_utc> <category>` | Everyone | Submit a mint URL for SSRF validation and tracking (labeled `Unverified`). |
| `/settings <intervals> <categories>` | `Manage Server` / `Admin` | Configure reminder lead times (e.g. `24h, 1h, 15m`) and categories (`free`, `allowlist`, `public`). |
| `/timezone <iana_zone>` | `Manage Server` / `Admin` | Set the server's IANA timezone (e.g. `UTC`, `America/New_York`, `Europe/London`, `Asia/Tokyo`). |

---

## Creating a Discord Application & Inviting the Bot

1. Visit the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Navigate to **Bot**:
   - Click **Reset Token** and copy your token into `DISCORD_BOT_TOKEN` in `.env`.
   - Leave Privileged Gateway Intents disabled (MintPulse uses standard `Guilds` intent and Slash Commands).
3. Navigate to **OAuth2 -> URL Generator**:
   - Under **Scopes**, check:
     - `bot`
     - `applications.commands`
   - Under **Bot Permissions**, check:
     - `View Channels` (`1024`)
     - `Send Messages` (`2048`)
     - `Embed Links` (`16384`)
     - `Read Message History` (`65536`)
   - Combined Permission Integer: `84992`
4. Open the generated Invite URL to invite MintPulse to your Discord server:
   ```text
   https://discord.com/api/oauth2/authorize?client_id=YOUR_DISCORD_CLIENT_ID&permissions=84992&scope=bot%20applications.commands
   ```

---

## Setting up Supabase for Persistent Database Storage

MintPulse is 100% compatible with [Supabase](https://supabase.com). Supabase provisions a managed PostgreSQL 15/16 database with high availability, backups, and native connection pooling.

### 1. Create a Supabase Project
1. Go to [supabase.com](https://supabase.com) and log in.
2. Click **New Project**, pick your organization, name the project (e.g., `mintpulse`), and generate or enter a strong database password. Save this password.

### 2. Run Database Migrations in Supabase SQL Editor
1. In the Supabase project dashboard, navigate to **SQL Editor** in the left menu.
2. Click **New Query**.
3. Copy and paste the entire contents of `migrations/001_initial_schema.sql` into the SQL Editor.
4. Click **Run**. All tables (`evm_chains`, `nft_mints`, `guild_settings`, `guild_watchlists`, `scheduled_reminders`) and initial chains will be created.

### 3. Get Your Connection String
1. In Supabase, go to **Project Settings** (gear icon) -> **Database**.
2. Under **Connection string**, select the **URI** tab.
3. For serverless or container deployments, select the **Transaction Pooler** (port `6543`) or **Direct connection** (port `5432`):
   ```text
   DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres"
   ```
4. Replace `[YOUR-PASSWORD]` with the password you set in Step 1.
5. Paste this into your `.env` file as `DATABASE_URL`.

---

## Local Development Setup

### Prerequisites
- **Node.js 22+**
- **PostgreSQL 14+** (optional for local UI sandbox testing; required for production persistence)

### Steps
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
3. Run PostgreSQL migrations:
   ```bash
   psql "$DATABASE_URL" -f migrations/001_initial_schema.sql
   ```
4. Start the development server & bot worker:
   ```bash
   npm run dev
   ```
5. Run type-checking and automated tests:
   ```bash
   npm run lint
   npm test
   ```

---

## Deployment Modes

### Mode 1: Centrally Hosted Public Bot
Deploy a single instance of MintPulse connected to a managed PostgreSQL database. Any Discord server administrator can invite the bot using the OAuth2 link and run `/setup` and `/settings`. Guild configurations, timezones, watchlists, and idempotency keys are strictly isolated by `guild_id`.

### Mode 2: Self-Hosting with Docker Compose
Run both the MintPulse bot and a dedicated PostgreSQL 16 instance with a single command:

```bash
cp .env.example .env
# Edit .env with your DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID
docker compose up -d --build
```

PostgreSQL automatically applies `migrations/001_initial_schema.sql` on first boot, and the bot exposes a health check at `http://localhost:3000/api/health`.

---

## Verifying External API Integrations

- **OpenSea API v2**: Set `OPENSEA_API_KEY` in `.env`. Without an API key, the OpenSea adapter reports `unconfigured` status rather than returning fabricated data.
- **Discord Gateway & Slash Commands**: Set `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID` in `.env`. On startup, MintPulse registers all slash commands via Discord REST API and connects the Gateway client. You can also test all slash commands interactively in the Web Dashboard Simulator at `http://localhost:3000`.

---

## Extending Chains & Adapters

See [`docs/EXTENDING.md`](docs/EXTENDING.md) for instructions on adding new EVM chains and building custom discovery adapters.

---

## License

Released under the [MIT License](LICENSE).
