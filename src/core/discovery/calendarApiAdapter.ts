/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * External JSON Mint Calendar API Adapter
 * Polls an external JSON calendar feed URL (configured via CALENDAR_FEED_URL in .env)
 * through the SSRF-protected fetcher and normalizes upcoming EVM NFT mints.
 * Never fabricates data when unconfigured.
 */

import { safeFetchExternalUrl, sanitizeEnvUrl } from '../security/ssrfGuard.ts';
import { AdapterDiscoveryResult, MintDiscoveryAdapter, withRetry } from './adapterInterface.ts';
import { parseCustomMintPayload } from './customWebsiteAdapter.ts';

export class ExternalCalendarFeedAdapter implements MintDiscoveryAdapter {
  public readonly id = 'external_calendar_api';
  public readonly name = 'External JSON Mint Calendar Feed';
  public readonly requiresCredentials = false;

  private readonly feedUrlGetter: () => string | undefined;
  private readonly fetcher: typeof safeFetchExternalUrl;

  constructor(options?: {
    feedUrlGetter?: () => string | undefined;
    fetcher?: typeof safeFetchExternalUrl;
  }) {
    this.feedUrlGetter =
      options?.feedUrlGetter ??
      (() => {
        const raw = process.env.CALENDAR_FEED_URL;
        return raw ? sanitizeEnvUrl(raw) : undefined;
      });
    this.fetcher = options?.fetcher ?? safeFetchExternalUrl;
  }

  public isConfigured(): boolean {
    const raw = this.feedUrlGetter();
    const url = raw ? sanitizeEnvUrl(raw) : '';
    return Boolean(url && url.startsWith('https://'));
  }

  public getConfigurationRequirement(): string {
    return 'Requires CALENDAR_FEED_URL (HTTPS JSON endpoint) in .env to poll external calendar feeds.';
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

    const feedUrl = this.feedUrlGetter()!.trim();
    try {
      const response = await withRetry('ExternalCalendarFeed', () =>
        this.fetcher(feedUrl, { timeoutMs: 8000 })
      );

      if (response.status !== 200) {
        return {
          adapterId: this.id,
          success: false,
          rawMints: [],
          errorMessage: `Calendar endpoint returned HTTP ${response.status}`,
        };
      }

      const rawMints = parseCustomMintPayload(response.bodyText, response.finalUrl).map((m) => ({
        ...m,
        discoverySource: this.id,
      }));

      return {
        adapterId: this.id,
        success: true,
        rawMints,
      };
    } catch (err) {
      return {
        adapterId: this.id,
        success: false,
        rawMints: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
