-- ============================================================================
-- MintPulse: Open-Source Discord NFT Mint Reminder Bot
-- Migration: 001_initial_schema.sql
-- Database: PostgreSQL 14+
-- Scope: NFT Mints Only (No raffles or giveaways)
-- Allowed EVM Chains: Ethereum (1), Robinhood Chain (747474), Ink Chain (57073)
-- ============================================================================

-- 1. Supported EVM Chains Registry
CREATE TABLE IF NOT EXISTS evm_chains (
    chain_id INTEGER PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(128) NOT NULL,
    native_symbol VARCHAR(24) NOT NULL DEFAULT 'ETH',
    explorer_url VARCHAR(255) NOT NULL,
    opensea_chain_identifier VARCHAR(64),
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the 3 allowed EVM chains (Ethereum, Robinhood Chain, Ink Chain) and disable others
INSERT INTO evm_chains (chain_id, slug, name, native_symbol, explorer_url, opensea_chain_identifier, is_enabled)
VALUES
    (1, 'ethereum', 'Ethereum', 'ETH', 'https://etherscan.io', 'ethereum', TRUE),
    (747474, 'robinhood', 'Robinhood Chain', 'ETH', 'https://explorer.robinhood.com', 'robinhood', TRUE),
    (57073, 'ink', 'Ink Chain', 'ETH', 'https://explorer.inkonchain.com', 'ink', TRUE)
ON CONFLICT (chain_id) DO UPDATE SET
    slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    explorer_url = EXCLUDED.explorer_url,
    opensea_chain_identifier = EXCLUDED.opensea_chain_identifier,
    is_enabled = TRUE;

UPDATE evm_chains SET is_enabled = FALSE WHERE chain_id NOT IN (1, 747474, 57073);

-- 2. Normalized NFT Mints Table
CREATE TABLE IF NOT EXISTS nft_mints (
    id VARCHAR(128) PRIMARY KEY,
    project_name VARCHAR(255) NOT NULL,
    collection_name VARCHAR(255) NOT NULL,
    collection_slug VARCHAR(255) NOT NULL,
    twitter_handle VARCHAR(128),
    total_supply VARCHAR(64),
    chain_id INTEGER NOT NULL REFERENCES evm_chains(chain_id),
    contract_address VARCHAR(64),
    mint_start_utc TIMESTAMPTZ NOT NULL,
    original_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    category VARCHAR(32) NOT NULL CHECK (category IN ('free', 'allowlist', 'public')),
    mint_price_exact VARCHAR(64),
    mint_price_symbol VARCHAR(24),
    website_url TEXT,
    source_url TEXT NOT NULL,
    discovery_source VARCHAR(64) NOT NULL,
    verification_status VARCHAR(32) NOT NULL CHECK (verification_status IN ('verified', 'unverified')),
    verification_notes TEXT,
    submitted_by_guild_id VARCHAR(64),
    submitted_by_user_id VARCHAR(64),
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chain_slug_start_category UNIQUE (chain_id, collection_slug, mint_start_utc, category)
);

-- Ensure columns exist on existing databases
ALTER TABLE nft_mints ADD COLUMN IF NOT EXISTS twitter_handle VARCHAR(128);
ALTER TABLE nft_mints ADD COLUMN IF NOT EXISTS total_supply VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_nft_mints_start_utc ON nft_mints(mint_start_utc);
CREATE INDEX IF NOT EXISTS idx_nft_mints_slug ON nft_mints(collection_slug);
CREATE INDEX IF NOT EXISTS idx_nft_mints_verification ON nft_mints(verification_status);

-- Clean up any legacy mints or reminders from disabled chains (including Base 8453)
DELETE FROM scheduled_reminders WHERE mint_id IN (SELECT id FROM nft_mints WHERE chain_id NOT IN (1, 747474, 57073));
DELETE FROM nft_mints WHERE chain_id NOT IN (1, 747474, 57073);

-- Clean up legacy OpenSea collections that had no explicit drop stage or mint start date
DELETE FROM scheduled_reminders WHERE mint_id IN (
    SELECT id FROM nft_mints
    WHERE discovery_source = 'opensea_v2'
      AND (verification_notes IS NULL OR verification_notes = 'Verified via OpenSea API v2 with published onchain contract address')
);
DELETE FROM nft_mints
WHERE discovery_source = 'opensea_v2'
  AND (verification_notes IS NULL OR verification_notes = 'Verified via OpenSea API v2 with published onchain contract address');

-- 2b. Custom Website & Feed Discovery Sources
CREATE TABLE IF NOT EXISTS discovery_feed_sources (
    url TEXT PRIMARY KEY,
    label VARCHAR(255) NOT NULL DEFAULT 'Custom Mint Website',
    added_by VARCHAR(128) NOT NULL DEFAULT 'admin',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_polled_utc TIMESTAMPTZ,
    last_discovered_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Discord Server (Guild) Isolated Configuration
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id VARCHAR(64) PRIMARY KEY,
    guild_name VARCHAR(255) NOT NULL,
    announcement_channel_id VARCHAR(64),
    announcement_channel_name VARCHAR(128),
    ping_role_id VARCHAR(64),
    ping_role_name VARCHAR(128),
    daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    daily_digest_time_utc VARCHAR(16) NOT NULL DEFAULT '13:00',
    last_digest_sent_date VARCHAR(16),
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    enabled_categories TEXT[] NOT NULL DEFAULT ARRAY['free', 'allowlist', 'public'],
    reminder_intervals_minutes INTEGER[] NOT NULL DEFAULT ARRAY[1440, 60, 15],
    include_unverified_watched BOOLEAN NOT NULL DEFAULT FALSE,
    channel_status VARCHAR(32) NOT NULL DEFAULT 'unconfigured'
        CHECK (channel_status IN ('active', 'unavailable', 'missing_permissions', 'unconfigured')),
    last_error TEXT,
    updated_by_user_id VARCHAR(64),
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure role and daily digest columns exist on existing databases
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS ping_role_id VARCHAR(64);
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS ping_role_name VARCHAR(128);
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS daily_digest_time_utc VARCHAR(16) NOT NULL DEFAULT '13:00';
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS last_digest_sent_date VARCHAR(16);

-- 4. Server-Specific Collection Watchlist
CREATE TABLE IF NOT EXISTS guild_watchlists (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(64) NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    collection_slug VARCHAR(255) NOT NULL,
    project_name VARCHAR(255) NOT NULL,
    chain_id INTEGER,
    contract_address VARCHAR(64),
    added_by_user_id VARCHAR(64) NOT NULL,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_guild_watchlist_slug UNIQUE (guild_id, collection_slug)
);

CREATE INDEX IF NOT EXISTS idx_guild_watchlists_guild ON guild_watchlists(guild_id);

-- 5. Scheduled & Dispatched Reminders (Idempotent Deduplication)
CREATE TABLE IF NOT EXISTS scheduled_reminders (
    id VARCHAR(128) PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    guild_id VARCHAR(64) NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    mint_id VARCHAR(128) NOT NULL REFERENCES nft_mints(id) ON DELETE CASCADE,
    interval_minutes INTEGER NOT NULL,
    scheduled_for_utc TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    recovered_after_downtime BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT,
    dispatched_at_utc TIMESTAMPTZ,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_due
    ON scheduled_reminders(status, scheduled_for_utc);
