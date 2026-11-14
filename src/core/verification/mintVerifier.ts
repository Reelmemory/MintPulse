/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Mint Data Verification & Normalization Engine
 * Validates external and user-submitted mint records before saving or announcing.
 * Enforces strict anti-fabrication rules:
 * - Never fabricates mint dates, prices, contracts, or availability.
 * - Unknown prices and contracts remain explicitly null.
 * - Never marks a mint as 'verified' when it has not been verified.
 */

import crypto from 'node:crypto';
import { chainRegistry } from '../chains.ts';
import { validateExternalUrl } from '../security/ssrfGuard.ts';
import { isValidIanaTimezone } from '../timezone/timezoneService.ts';
import { MintCategory, NormalizedMint, RawDiscoveredMint, VerificationStatus } from '../types.ts';

export interface MintValidationOutcome {
  valid: boolean;
  mint: NormalizedMint | null;
  errors: string[];
}

const VALID_CATEGORIES = new Set<MintCategory>(['free', 'allowlist', 'public']);

export function slugifyCollection(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Formats a clean @Handle for a project, using its verified/discovered Twitter handle
 * when available or deriving a clean alphanumeric handle from the project name.
 */
export function normalizeProjectHandle(rawHandle: string | null | undefined, projectName: string): string {
  if (rawHandle && typeof rawHandle === 'string' && rawHandle.trim() !== '') {
    const cleaned = rawHandle
      .trim()
      .replace(/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i, '')
      .replace(/^@+/, '')
      .replace(/\/.*$/, '')
      .trim();
    if (cleaned) {
      return `@${cleaned}`;
    }
  }
  const cleanFromName = projectName
    .replace(/\[Test Fixture\]/gi, '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '');
  return `@${cleanFromName || 'NFTCollection'}`;
}

export async function verifyAndNormalizeMint(
  raw: RawDiscoveredMint,
  options: { performDnsLookup?: boolean } = {}
): Promise<MintValidationOutcome> {
  const errors: string[] = [];

  // 1. Validate project & collection name
  const projectName = raw.projectName?.trim() ?? '';
  if (projectName.length < 2 || projectName.length > 120) {
    errors.push('Project name must be between 2 and 120 characters.');
  }

  // Guard against any accidental raffle submissions
  if (/\braffle\b/i.test(projectName)) {
    errors.push('MintPulse is strictly for NFT mints only; raffles are not supported.');
  }

  const collectionName = raw.collectionName?.trim() || projectName;
  const collectionSlug = slugifyCollection(raw.collectionSlug || collectionName);
  if (!collectionSlug) {
    errors.push('Unable to derive a valid collection slug.');
  }

  const twitterHandle = normalizeProjectHandle(raw.twitterHandle, projectName);
  const totalSupply =
    raw.totalSupply !== undefined && raw.totalSupply !== null && String(raw.totalSupply).trim() !== ''
      ? String(raw.totalSupply).trim()
      : null;

  // 2. Validate EVM chain
  const chain = chainRegistry.getChainById(raw.chainId);
  if (!chain) {
    errors.push(`Unsupported or disabled EVM chain ID: ${raw.chainId}.`);
  }

  // 3. Validate contract address (optional — never fabricate if unknown)
  let contractAddress: string | null = null;
  if (raw.contractAddress !== undefined && raw.contractAddress !== null && raw.contractAddress.trim() !== '') {
    const trimmedAddr = raw.contractAddress.trim();
    if (!chainRegistry.isValidEvmAddress(trimmedAddr)) {
      errors.push(`Invalid EVM contract address format: "${trimmedAddr}". Expected 0x followed by 40 hex chars.`);
    } else {
      contractAddress = trimmedAddr;
    }
  }

  // 4. Validate mint start timestamp (never fabricate if missing or invalid)
  const parsedDate = new Date(raw.mintStartIso);
  if (!raw.mintStartIso || Number.isNaN(parsedDate.getTime())) {
    errors.push(`Invalid or missing mint start timestamp: "${raw.mintStartIso}".`);
  }

  const originalTimezone =
    raw.originalTimezone && isValidIanaTimezone(raw.originalTimezone) ? raw.originalTimezone.trim() : 'UTC';

  // 5. Validate mint category (Free, Allowlist/Whitelist, Public)
  const category = raw.category?.toLowerCase() as MintCategory;
  if (!VALID_CATEGORIES.has(category)) {
    errors.push(`Invalid mint category "${raw.category}". Must be 'free', 'allowlist', or 'public'.`);
  }

  // 6. Validate mint price (optional — null if unknown/unverified)
  let mintPriceExact: string | null = null;
  let mintPriceSymbol: string | null = null;
  if (category === 'free') {
    mintPriceExact = '0';
    mintPriceSymbol = chain?.nativeSymbol ?? 'ETH';
  } else if (raw.mintPriceExact !== undefined && raw.mintPriceExact !== null && raw.mintPriceExact.trim() !== '') {
    const numericPrice = Number(raw.mintPriceExact.trim());
    if (Number.isNaN(numericPrice) || numericPrice < 0) {
      errors.push(`Invalid mint price "${raw.mintPriceExact}". Must be a non-negative number.`);
    } else {
      mintPriceExact = raw.mintPriceExact.trim();
      mintPriceSymbol = raw.mintPriceSymbol?.trim() || chain?.nativeSymbol || 'ETH';
    }
  }

  // 7. Validate source URL & website URL with SSRF Guard
  const sourceValidation = await validateExternalUrl(raw.sourceUrl, {
    performDnsLookup: options.performDnsLookup ?? false,
  });
  if (!sourceValidation.valid || !sourceValidation.normalizedUrl) {
    errors.push(`Invalid source URL: ${sourceValidation.reason}`);
  }

  let websiteUrl: string | null = null;
  if (raw.websiteUrl && raw.websiteUrl.trim() !== '') {
    const websiteValidation = await validateExternalUrl(raw.websiteUrl, {
      performDnsLookup: options.performDnsLookup ?? false,
    });
    if (!websiteValidation.valid || !websiteValidation.normalizedUrl) {
      errors.push(`Invalid website URL: ${websiteValidation.reason}`);
    } else {
      websiteUrl = websiteValidation.normalizedUrl;
    }
  }

  // 8. Enforce honest verification status
  // A user-submitted mint or a mint missing verified source backing cannot claim 'verified'
  let verificationStatus: VerificationStatus = 'unverified';
  if (raw.verificationStatus === 'verified' && raw.discoverySource !== 'user_submission') {
    verificationStatus = 'verified';
  }

  if (errors.length > 0) {
    return { valid: false, mint: null, errors };
  }

  const mintStartUtc = parsedDate.toISOString();
  const nowUtc = new Date().toISOString();
  const deterministicKey = `${raw.chainId}:${collectionSlug}:${mintStartUtc}:${category}`;
  const id = `mint_${crypto.createHash('sha256').update(deterministicKey).digest('hex').slice(0, 16)}`;

  const normalized: NormalizedMint = {
    id,
    projectName,
    collectionName,
    collectionSlug,
    twitterHandle,
    totalSupply,
    chainId: raw.chainId,
    contractAddress,
    mintStartUtc,
    originalTimezone,
    category,
    mintPriceExact,
    mintPriceSymbol,
    websiteUrl: websiteUrl ?? sourceValidation.normalizedUrl!,
    sourceUrl: sourceValidation.normalizedUrl!,
    discoverySource: raw.discoverySource,
    verificationStatus,
    verificationNotes:
      raw.verificationNotes ??
      (verificationStatus === 'verified'
        ? `Verified drop schedule from ${raw.discoverySource}`
        : 'Unverified metadata — contract or schedule pending independent verification'),
    submittedByGuildId: raw.submittedByGuildId ?? null,
    submittedByUserId: raw.submittedByUserId ?? null,
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
  };

  return {
    valid: true,
    mint: normalized,
    errors: [],
  };
}
