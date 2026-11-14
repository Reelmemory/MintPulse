/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Modular Discovery Adapter Interface & Orchestrator
 */

import { logger } from '../logger.ts';
import { NormalizedMint, RawDiscoveredMint } from '../types.ts';
import { verifyAndNormalizeMint } from '../verification/mintVerifier.ts';

export interface AdapterStatusReport {
  adapterId: string;
  adapterName: string;
  configured: boolean;
  requiresCredentials: boolean;
  lastRunUtc: string | null;
  lastSuccess: boolean | null;
  discoveredCount: number;
  statusMessage: string;
}

export interface AdapterDiscoveryResult {
  adapterId: string;
  success: boolean;
  rawMints: RawDiscoveredMint[];
  errorMessage?: string;
}

export interface MintDiscoveryAdapter {
  readonly id: string;
  readonly name: string;
  readonly requiresCredentials: boolean;
  isConfigured(): boolean;
  getConfigurationRequirement(): string;
  discoverUpcomingMints(): Promise<AdapterDiscoveryResult>;
}

/**
 * Helper for retry with exponential backoff on transient failures
 */
export async function withRetry<T>(
  operationName: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 250
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn('DiscoveryRetry', `${operationName} attempt ${attempt}/${maxAttempts} failed; retrying in ${delay}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

export class DiscoveryEngine {
  private adapters = new Map<string, MintDiscoveryAdapter>();
  private statusReports = new Map<string, AdapterStatusReport>();

  public registerAdapter(adapter: MintDiscoveryAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.statusReports.set(adapter.id, {
      adapterId: adapter.id,
      adapterName: adapter.name,
      configured: adapter.isConfigured(),
      requiresCredentials: adapter.requiresCredentials,
      lastRunUtc: null,
      lastSuccess: null,
      discoveredCount: 0,
      statusMessage: adapter.isConfigured()
        ? 'Ready to poll upstream source'
        : adapter.getConfigurationRequirement(),
    });
  }

  public getAdapters(): MintDiscoveryAdapter[] {
    return Array.from(this.adapters.values());
  }

  public getAdapterReports(): AdapterStatusReport[] {
    return Array.from(this.adapters.values()).map((adapter) => {
      const existing = this.statusReports.get(adapter.id);
      const configured = adapter.isConfigured();
      return {
        adapterId: adapter.id,
        adapterName: adapter.name,
        configured,
        requiresCredentials: adapter.requiresCredentials,
        lastRunUtc: existing?.lastRunUtc ?? null,
        lastSuccess: existing?.lastSuccess ?? null,
        discoveredCount: existing?.discoveredCount ?? 0,
        statusMessage: configured
          ? existing?.statusMessage ?? 'Configured and ready'
          : adapter.getConfigurationRequirement(),
      };
    });
  }

  /**
   * Executes all configured discovery adapters, validates and normalizes each discovered mint,
   * and returns the verified/normalized records alongside per-adapter diagnostics.
   */
  public async runDiscoveryCycle(): Promise<{
    normalizedMints: NormalizedMint[];
    rejectedCount: number;
    reports: AdapterStatusReport[];
  }> {
    const normalizedMints: NormalizedMint[] = [];
    let rejectedCount = 0;

    for (const adapter of this.adapters.values()) {
      const nowUtc = new Date().toISOString();
      if (!adapter.isConfigured()) {
        this.statusReports.set(adapter.id, {
          adapterId: adapter.id,
          adapterName: adapter.name,
          configured: false,
          requiresCredentials: adapter.requiresCredentials,
          lastRunUtc: nowUtc,
          lastSuccess: null,
          discoveredCount: 0,
          statusMessage: adapter.getConfigurationRequirement(),
        });
        continue;
      }

      try {
        const result = await adapter.discoverUpcomingMints();
        let acceptedForAdapter = 0;

        for (const raw of result.rawMints) {
          const verification = await verifyAndNormalizeMint(raw, { performDnsLookup: false });
          if (verification.valid && verification.mint) {
            normalizedMints.push(verification.mint);
            acceptedForAdapter++;
          } else {
            rejectedCount++;
            logger.warn('DiscoveryEngine', `Rejected invalid mint record from adapter ${adapter.id}`, {
              projectName: raw.projectName,
              errors: verification.errors,
            });
          }
        }

        this.statusReports.set(adapter.id, {
          adapterId: adapter.id,
          adapterName: adapter.name,
          configured: true,
          requiresCredentials: adapter.requiresCredentials,
          lastRunUtc: nowUtc,
          lastSuccess: result.success,
          discoveredCount: acceptedForAdapter,
          statusMessage: result.success
            ? `Polled successfully (${acceptedForAdapter} valid mints normalized)`
            : result.errorMessage ?? 'Upstream discovery failed',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('DiscoveryEngine', `Adapter ${adapter.id} failed unexpectedly`, { error: msg });
        this.statusReports.set(adapter.id, {
          adapterId: adapter.id,
          adapterName: adapter.name,
          configured: true,
          requiresCredentials: adapter.requiresCredentials,
          lastRunUtc: nowUtc,
          lastSuccess: false,
          discoveredCount: 0,
          statusMessage: `Error: ${msg}`,
        });
      }
    }

    return {
      normalizedMints,
      rejectedCount,
      reports: this.getAdapterReports(),
    };
  }
}
