/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * OpenSea REST API v2 Discovery Adapter
 * Queries OpenSea API v2 for eligible upcoming drops across supported EVM chains
 * (Ethereum, Robinhood Chain, Ink Chain).
 * Strictly requires an explicit drop stage (`drop_stages`) or `mint_start_date` — never fabricates
 * mint dates for empty or non-drop collections.
 */

import { chainRegistry } from '../chains.ts';
import { logger } from '../logger.ts';
import { MintCategory, RawDiscoveredMint } from '../types.ts';
import { AdapterDiscoveryResult, MintDiscoveryAdapter, withRetry } from './adapterInterface.ts';

export interface OpenSeaDropStage {
  stage_type?: string; // 'public' | 'allowlist' | 'presale' | 'free'
  start_time?: string; // ISO-8601 or unix seconds
  price?: {
    value?: string;
    currency?: string;
  };
}

export interface OpenSeaDropCollection {
  collection: string;
  name: string;
  description?: string;
  image_url?: string | null;
  is_disabled?: boolean;
  is_nsfw?: boolean;
  safelist_status?: string;
  twitter_username?: string | null;
  total_supply?: number | string | null;
  contracts?: Array<{
    address: string;
    chain: string;
  }>;
  project_url?: string;
  opensea_url?: string;
  drop_stages?: OpenSeaDropStage[];
  mint_start_date?: string;
  created_date?: string;
}

export interface OpenSeaCollectionsResponse {
  collections?: OpenSeaDropCollection[];
  total_supply?: number | string | null;
  twitter_username?: string | null;
}

export type OpenSeaFetchFn = (url: string, headers: Record<string, string>) => Promise<{
  status: number;
  json: () => Promise<OpenSeaCollectionsResponse>;
}>;

const defaultOpenSeaFetcher: OpenSeaFetchFn = async (url, headers) => {
  const response = await fetch(url, {
    method: 'GET',
    headers,
  });
  return {
    status: response.status,
    json: () => response.json() as Promise<OpenSeaCollectionsResponse>,
  };
};

export class OpenSeaDiscoveryAdapter implements MintDiscoveryAdapter {
  public readonly id = 'opensea_v2';
  public readonly name = 'OpenSea Drops API v2';
  public readonly requiresCredentials = true;

  private readonly apiKeyGetter: () => string | undefined;
  private readonly fetcher: OpenSeaFetchFn;

  constructor(options?: { apiKeyGetter?: () => string | undefined; fetcher?: OpenSeaFetchFn }) {
    this.apiKeyGetter = options?.apiKeyGetter ?? (() => process.env.OPENSEA_API_KEY);
    this.fetcher = options?.fetcher ?? defaultOpenSeaFetcher;
  }

  public isConfigured(): boolean {
    const key = this.apiKeyGetter()?.trim();
    return Boolean(key && key !== 'YOUR_OPENSEA_API_KEY_HERE' && key !== 'MY_OPENSEA_API_KEY');
  }

  public getConfigurationRequirement(): string {
    return 'Requires OPENSEA_API_KEY in .env to poll live OpenSea API v2 endpoints (https://api.opensea.io/api/v2/collections).';
  }

  private mapStageCategory(stageType?: string, priceValue?: string | null): MintCategory {
    if (priceValue === '0' || priceValue === '0.0' || stageType?.toLowerCase() === 'free') {
      return 'free';
    }
    const normalized = stageType?.toLowerCase() ?? '';
    if (normalized.includes('allowlist') || normalized.includes('whitelist') || normalized.includes('presale')) {
      return 'allowlist';
    }
    return 'public';
  }

  public async discoverUpcomingMints(): Promise<AdapterDiscoveryResult> {
    if (!this.isConfigured()) {
      return {
        adapterId: this.id,
        success: false,
        rawMints: [],
        errorMessage: this.getConfigurationRequirement(),
      };
    }

    const apiKey = this.apiKeyGetter()!.trim();
    const enabledChains = chainRegistry.getEnabledChains();
    const discovered: RawDiscoveredMint[] = [];

    try {
      for (const chain of enabledChains) {
        if (!chain.openSeaChainIdentifier) continue;

        const endpoint = `https://api.opensea.io/api/v2/collections?chain=${encodeURIComponent(
          chain.openSeaChainIdentifier
        )}&order_by=created_date&limit=25`;

        const response = await withRetry(`OpenSea:${chain.slug}`, async () => {
          const res = await this.fetcher(endpoint, {
            Accept: 'application/json',
            'x-api-key': apiKey,
          });
          if (res.status === 429) {
            throw new Error('OpenSea API rate limit exceeded (HTTP 429)');
          }
          if (res.status >= 500) {
            throw new Error(`OpenSea API server error (HTTP ${res.status})`);
          }
          return res;
        });

        if (response.status !== 200) {
          logger.warn('OpenSeaAdapter', `Non-200 status (${response.status}) for chain ${chain.slug}`);
          continue;
        }

        const payload = await response.json();
        const collections = payload.collections ?? [];

        for (const item of collections) {
          if (item.is_disabled || item.is_nsfw) continue;

          // Strictly require an explicit upcoming drop stage or mint_start_date.
          // Never treat empty/standard collections (0 items, no drop_stages, no mint_start_date) as upcoming mints.
          const hasExplicitDropStages = Boolean(item.drop_stages && item.drop_stages.length > 0);
          const hasExplicitMintStartDate = Boolean(item.mint_start_date && String(item.mint_start_date).trim() !== '');
          if (!hasExplicitDropStages && !hasExplicitMintStartDate) {
            continue;
          }

          const contractEntry = item.contracts?.[0];
          const contractAddress =
            contractEntry?.address && chainRegistry.isValidEvmAddress(contractEntry.address)
              ? contractEntry.address
              : null;

          const cleanProjectUrl =
            item.project_url && /^https?:\/\//i.test(item.project_url.trim())
              ? item.project_url.trim()
              : null;

          const rawName = (item.name || item.collection || '').trim();
          if (!rawName || /^0x[a-f0-9]{40}$/i.test(rawName)) {
            continue;
          }

          const stages: OpenSeaDropStage[] = hasExplicitDropStages
            ? item.drop_stages!
            : [{ stage_type: 'public', start_time: item.mint_start_date }];

          const twitterHandle = item.twitter_username ? `@${item.twitter_username.replace(/^@/, '')}` : null;
          const totalSupply =
            item.total_supply !== undefined && item.total_supply !== null ? String(item.total_supply) : null;

          // Format OpenSea URL with /overview to match the screenshot's Mint page format
          const rawOpenSeaUrl = (item.opensea_url || `https://opensea.io/collection/${item.collection}`).replace(
            /\/+$/,
            ''
          );
          const openSeaOverviewUrl = rawOpenSeaUrl.endsWith('/overview')
            ? rawOpenSeaUrl
            : `${rawOpenSeaUrl}/overview`;

          for (const stage of stages) {
            if (!stage.start_time) continue;
            const parsedStart = new Date(stage.start_time);
            if (Number.isNaN(parsedStart.getTime())) continue;

            const priceVal = stage.price?.value ?? null;
            const priceSym = stage.price?.currency ?? chain.nativeSymbol;
            const category = this.mapStageCategory(stage.stage_type, priceVal);

            discovered.push({
              projectName: rawName,
              collectionName: rawName,
              collectionSlug: item.collection,
              twitterHandle,
              totalSupply,
              chainId: chain.chainId,
              contractAddress,
              mintStartIso: parsedStart.toISOString(),
              originalTimezone: 'UTC',
              category,
              mintPriceExact: priceVal,
              mintPriceSymbol: priceVal !== null ? priceSym : null,
              websiteUrl: cleanProjectUrl,
              sourceUrl: openSeaOverviewUrl,
              discoverySource: 'opensea_v2',
              verificationStatus: contractAddress ? 'verified' : 'unverified',
              verificationNotes: contractAddress
                ? 'Verified via OpenSea API v2 with explicit drop stage schedule'
                : 'Discovered via OpenSea API v2 drop schedule; contract address not yet published',
            });
          }
        }
      }

      return {
        adapterId: this.id,
        success: true,
        rawMints: discovered,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('OpenSeaAdapter', 'Failed to poll OpenSea API v2', { error: errorMessage });
      return {
        adapterId: this.id,
        success: false,
        rawMints: [],
        errorMessage,
      };
    }
  }
}
