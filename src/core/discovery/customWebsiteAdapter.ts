/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Custom Mint Website & Structured Drop Manifest Adapter
 * Safely parses NFT mint metadata from supported custom mint websites & feeds using:
 * 1. Next.js App Router RSC flight streams (<script>self.__next_f.push([1, "..."])</script>)
 *    such as https://tesserapp.org/calendar
 * 2. JSON drop manifest / calendar API endpoints (any structure: array, { mints }, { drops },
 *    { collections }, { data }, { items }, { results }, { schedule }, { events })
 * 3. Next.js Pages Router (<script id="__NEXT_DATA__">) & JSON-LD (<script type="application/ld+json">)
 * 4. Plain-text or HTML 5-bullet mint blocks (@Handle, Chain, Time, Mint page, Price, Supply)
 * 5. Standard HTML <meta name="nft:mint:*"> tags
 *
 * All URLs are strictly validated through the SSRF Guard before fetching.
 * Never fabricates missing prices, contracts, or schedules.
 */

import { chainRegistry } from '../chains.ts';
import { logger } from '../logger.ts';
import { DnsResolverFn, safeFetchExternalUrl, sanitizeEnvUrl, validateExternalUrl } from '../security/ssrfGuard.ts';
import { StorageRepository } from '../storage/database.ts';
import { MintCategory, RawDiscoveredMint } from '../types.ts';
import { AdapterDiscoveryResult, MintDiscoveryAdapter } from './adapterInterface.ts';

const DEFAULT_BUILT_IN_MINT_WEBSITES = ['https://tesserapp.org/calendar'];

export interface CustomMintManifestItem {
  projectName?: string;
  name?: string;
  title?: string;
  collectionName?: string;
  collection_name?: string;
  collectionSlug?: string;
  collection_slug?: string;
  slug?: string;
  id?: string;
  twitterHandle?: string;
  twitter_handle?: string;
  twitterUrl?: string;
  twitter_url?: string;
  twitter?: string;
  handle?: string;
  xHandle?: string;
  totalSupply?: string | number | null;
  total_supply?: string | number | null;
  supply?: string | number | null;
  osMaxSupply?: string | number | null;
  maxSupply?: string | number | null;
  max_supply?: string | number | null;
  chainId?: number | string | null;
  chain_id?: number | string | null;
  chain?: string | number | null;
  network?: string | null;
  contractAddress?: string | null;
  contract_address?: string | null;
  contract?: string | null;
  mintStartIso?: string;
  mint_start_iso?: string;
  mintTimestampUtc?: string | number;
  mint_timestamp_utc?: string | number;
  startsAt?: string | number;
  starts_at?: string | number;
  startDate?: string | number;
  start_date?: string | number;
  mintDate?: string | number;
  mint_date?: string | number;
  startTime?: string | number;
  start_time?: string | number;
  timestamp?: string | number;
  time?: string | number;
  date?: string | number;
  timezone?: string;
  category?: string;
  type?: string;
  stage?: string;
  status?: string;
  hasTime?: boolean;
  mintPriceExact?: string | number | null;
  mint_price_exact?: string | number | null;
  price?: string | number | null;
  wlPrice?: string | number | null;
  pubPrice?: string | number | null;
  mintPrice?: string | number | null;
  mint_price?: string | number | null;
  mintPriceSymbol?: string | null;
  mint_price_symbol?: string | null;
  currency?: string | null;
  websiteUrl?: string | null;
  website_url?: string | null;
  website?: string | null;
  sourceUrl?: string;
  source_url?: string;
  mintUrl?: string | null;
  mint_url?: string | null;
  osUrl?: string | null;
  href?: string | null;
  url?: string | null;
  link?: string | null;
  bio?: string | null;
  description?: string | null;
  verified?: boolean;
  vetted?: boolean;
}

function extractMetaContent(html: string, metaName: string): string | null {
  const escaped = metaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern1 = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  const match1 = html.match(pattern1);
  if (match1?.[1]) return match1[1].trim();

  const pattern2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const match2 = html.match(pattern2);
  if (match2?.[1]) return match2[1].trim();

  return null;
}

/**
 * Resolves chain ID from flexible chain names, slugs, numeric IDs, or project context
 * ("Robinhood", "Robinhood Chain", "RH", "ETH", "Ethereum", "Ink", "Ink Chain", 1, 747474, 57073).
 */
function resolveFlexibleChainId(
  rawChain: string | number | undefined | null,
  contextHint = ''
): number | null {
  const hintLower = contextHint.toLowerCase();

  // Check if context explicitly indicates Ink Chain even when chain is null or generic
  const hasExplicitInkHint =
    /\binkonchain\b|\bink\s*chain\b|\.ink\b|\binkdead|\binksigil|\binkbubblecats|\btheeunseenink|\bink-goblins|\binkbox\b/i.test(
      hintLower
    );

  if (rawChain !== undefined && rawChain !== null && String(rawChain).trim() !== '') {
    if (typeof rawChain === 'number') {
      const byId = chainRegistry.getChainById(rawChain);
      if (byId) return byId.chainId;
    }

    const str = String(rawChain).trim().toLowerCase();
    if (/^\d+$/.test(str)) {
      const byNum = chainRegistry.getChainById(Number(str));
      if (byNum) return byNum.chainId;
    }

    if (str.includes('robinhood') || str === 'rh' || str === 'rh-chain') {
      return 747474;
    }
    if (str.includes('ink') || str === 'ink-mainnet' || str === 'inkchain') {
      return 57073;
    }
    if (str === 'ethereum' || str === 'eth' || str === 'mainnet' || str.includes('ethereum')) {
      if (hasExplicitInkHint) {
        return 57073;
      }
      return 1;
    }

    const resolved = chainRegistry.getChainBySlugOrId(str);
    if (resolved) return resolved.chainId;
    return null;
  }

  // When rawChain is null/empty (e.g., Tessera items without a chain tag yet), infer from context
  if (hasExplicitInkHint || /\bink\b/i.test(hintLower)) {
    return 57073;
  }
  if (/\brobinhood\b|\brh\b/i.test(hintLower)) {
    return 747474;
  }
  if (/\bethereum\b|\beth\b/i.test(hintLower)) {
    return 1;
  }

  return null;
}

/**
 * Formats a numeric price string, converting scientific notation (e.g. "3.8e-05")
 * into a clean decimal string ("0.000038").
 */
function normalizeNumericPriceString(numVal: number): string {
  if (numVal === 0) return '0';
  if (numVal < 0.0001) {
    return numVal.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(numVal);
}

/**
 * Parses flexible price strings like "Free", "0", "0.0004 ETH", "0.01", "3.8e-05", "TBA"
 */
function parsePriceAndCategory(
  rawPrice: string | number | null | undefined,
  rawCategory: string | undefined,
  rawCurrency: string | null | undefined
): {
  category: MintCategory;
  mintPriceExact: string | null;
  mintPriceSymbol: string | null;
} {
  let category: MintCategory = 'public';
  const catLower = (rawCategory ?? '').trim().toLowerCase();
  if (catLower === 'free') {
    category = 'free';
  } else if (
    catLower === 'allowlist' ||
    catLower === 'whitelist' ||
    catLower === 'wl' ||
    catLower === 'presale' ||
    catLower === 'gtd' ||
    catLower === 'fcfs'
  ) {
    category = 'allowlist';
  }

  if (rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === '') {
    return {
      category,
      mintPriceExact: category === 'free' ? '0' : null,
      mintPriceSymbol: rawCurrency?.trim() || 'ETH',
    };
  }

  const priceStr = String(rawPrice).trim();
  if (/^(free|0|0\.0+|0\s*eth|free\s*mint)$/i.test(priceStr)) {
    return {
      category: 'free',
      mintPriceExact: '0',
      mintPriceSymbol: rawCurrency?.trim() || 'ETH',
    };
  }

  if (/^(tba|tbd|unknown|n\/a|\?|-)$/i.test(priceStr)) {
    return {
      category,
      mintPriceExact: null,
      mintPriceSymbol: rawCurrency?.trim() || 'ETH',
    };
  }

  // Handle scientific notation or plain decimal e.g. "3.8e-05", "0.0004 ETH"
  const sciMatch = priceStr.match(/^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*([a-zA-Z]{2,10})?$/i);
  if (sciMatch) {
    const numVal = Number(sciMatch[1]);
    const sym = sciMatch[2]?.toUpperCase() || rawCurrency?.trim() || 'ETH';
    if (!Number.isNaN(numVal)) {
      if (numVal === 0) {
        return {
          category: 'free',
          mintPriceExact: '0',
          mintPriceSymbol: sym,
        };
      }
      return {
        category,
        mintPriceExact: normalizeNumericPriceString(numVal),
        mintPriceSymbol: sym,
      };
    }
  }

  return {
    category,
    mintPriceExact: null,
    mintPriceSymbol: rawCurrency?.trim() || 'ETH',
  };
}

/**
 * Parses flexible timestamps: ISO strings, Unix seconds, Unix milliseconds, or "<t:1760803200:t>"
 */
function parseFlexibleTimestamp(rawTime: string | number | undefined | null): string | null {
  if (rawTime === undefined || rawTime === null || String(rawTime).trim() === '') {
    return null;
  }

  if (typeof rawTime === 'number') {
    const ms = rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const str = String(rawTime).trim();

  // Discord timestamp tag <t:1760803200:t>
  const discordMatch = str.match(/<t:(\d{9,12})(?::[tTdDfFR])?>/);
  if (discordMatch) {
    return new Date(Number(discordMatch[1]) * 1000).toISOString();
  }

  // Pure unix timestamp string
  if (/^\d{10,13}$/.test(str)) {
    const num = Number(str);
    const ms = str.length === 10 ? num * 1000 : num;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

/**
 * Converts a single CustomMintManifestItem into a RawDiscoveredMint if valid.
 */
function convertManifestItemToMint(
  item: CustomMintManifestItem,
  fallbackUrl: string
): RawDiscoveredMint | null {
  if (!item || typeof item !== 'object') return null;

  // Skip items explicitly marked as ended prior to today UTC
  if (typeof item.status === 'string' && item.status.toLowerCase() === 'ended') {
    const rawEndedStart = parseFlexibleTimestamp(item.startsAt ?? item.mintStartIso ?? item.startDate);
    const todayUtcPrefix = new Date().toISOString().slice(0, 10);
    if (!rawEndedStart || !rawEndedStart.startsWith(todayUtcPrefix)) {
      return null;
    }
  }

  const rawName = (
    item.projectName ??
    item.name ??
    item.title ??
    item.collectionName ??
    item.collection_name ??
    item.handle ??
    item.twitterHandle ??
    ''
  )
    .toString()
    .trim();

  const cleanName = rawName.replace(/^@+/, '').replace(/:$/, '').trim();
  if (!cleanName || cleanName.length < 2) return null;

  const rawTime =
    item.mintStartIso ??
    item.mint_start_iso ??
    item.startsAt ??
    item.starts_at ??
    item.mintTimestampUtc ??
    item.mint_timestamp_utc ??
    item.startDate ??
    item.start_date ??
    item.mintDate ??
    item.mint_date ??
    item.startTime ??
    item.start_time ??
    item.timestamp ??
    item.time ??
    item.date;

  const mintStartIso = parseFlexibleTimestamp(rawTime);
  if (!mintStartIso) return null;

  const contextHint = [
    cleanName,
    item.twitterUrl,
    item.websiteUrl,
    item.mintUrl,
    item.osUrl,
    item.href,
    item.bio,
    item.description,
  ]
    .filter(Boolean)
    .join(' ');

  const rawChain = item.chainId ?? item.chain_id ?? item.chain ?? item.network;
  let chainId = resolveFlexibleChainId(rawChain, contextHint);

  // If chain is explicitly null/empty on a curated calendar event (e.g. BadCats on Tessera),
  // default to Robinhood Chain (747474) so the scheduled calendar drop is still surfaced.
  if (!chainId && (rawChain === null || rawChain === undefined || String(rawChain).trim() === '')) {
    chainId = 747474;
  }
  if (!chainId) return null;

  const rawPrice =
    item.mintPriceExact ??
    item.mint_price_exact ??
    item.price ??
    item.pubPrice ??
    item.wlPrice ??
    item.mintPrice ??
    item.mint_price;
  const rawCategory = item.category ?? item.type ?? item.stage;
  const rawCurrency = item.mintPriceSymbol ?? item.mint_price_symbol ?? item.currency;
  const { category, mintPriceExact, mintPriceSymbol } = parsePriceAndCategory(
    rawPrice,
    rawCategory,
    rawCurrency
  );

  const rawSupply =
    item.totalSupply ??
    item.total_supply ??
    item.supply ??
    item.osMaxSupply ??
    item.maxSupply ??
    item.max_supply;
  const totalSupply =
    rawSupply !== undefined && rawSupply !== null && String(rawSupply).trim() !== ''
      ? String(rawSupply).trim()
      : null;

  const rawHandle =
    item.twitterHandle ??
    item.twitter_handle ??
    item.twitterUrl ??
    item.twitter_url ??
    item.twitter ??
    item.handle ??
    item.xHandle ??
    null;

  // Prefer OpenSea collection or direct mint page over generic t.co / twitter links
  const candidateUrls = [
    item.mintUrl,
    item.mint_url,
    item.osUrl,
    item.sourceUrl,
    item.source_url,
    item.websiteUrl,
    item.website_url,
    item.website,
    item.href,
    item.url,
    item.link,
    fallbackUrl,
  ]
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter((u) => u.startsWith('http://') || u.startsWith('https://'));

  const openSeaCandidate = candidateUrls.find((u) => u.includes('opensea.io/collection/'));
  const nonTwitterCandidate = candidateUrls.find(
    (u) => !u.includes('twitter.com/') && !u.includes('x.com/') && !u.includes('t.co/')
  );
  const sourceUrl = openSeaCandidate || nonTwitterCandidate || candidateUrls[0] || fallbackUrl;
  const websiteUrl = item.websiteUrl ?? item.website_url ?? item.website ?? sourceUrl;

  const rawSlug =
    item.collectionSlug ??
    item.collection_slug ??
    item.slug ??
    (openSeaCandidate
      ? openSeaCandidate.match(/opensea\.io\/collection\/([^/?#]+)/i)?.[1]
      : undefined) ??
    cleanName;

  return {
    projectName: cleanName,
    collectionName: (item.collectionName ?? item.collection_name ?? cleanName).toString().trim(),
    collectionSlug: rawSlug ? String(rawSlug).trim() : undefined,
    twitterHandle: rawHandle ? String(rawHandle).trim() : null,
    totalSupply,
    chainId,
    contractAddress: (item.contractAddress ?? item.contract_address ?? item.contract)?.trim() || null,
    mintStartIso,
    originalTimezone: item.timezone?.trim() || 'UTC',
    category,
    mintPriceExact,
    mintPriceSymbol,
    websiteUrl: websiteUrl ? String(websiteUrl).trim() : sourceUrl,
    sourceUrl,
    discoverySource: 'custom_website',
    verificationStatus: 'verified',
    verificationNotes: `Synced from custom mint website (${fallbackUrl})`,
  };
}

/**
 * Recursively walks a parsed JSON object (including Next.js __NEXT_DATA__ or API responses)
 * to extract any array or objects that look like NFT mint items.
 */
function extractMintsFromJsonNode(node: unknown, fallbackUrl: string, depth = 0): RawDiscoveredMint[] {
  if (depth > 7 || !node) return [];

  if (Array.isArray(node)) {
    const results: RawDiscoveredMint[] = [];
    for (const elem of node) {
      const converted = convertManifestItemToMint(elem as CustomMintManifestItem, fallbackUrl);
      if (converted) {
        results.push(converted);
      } else if (elem && typeof elem === 'object') {
        results.push(...extractMintsFromJsonNode(elem, fallbackUrl, depth + 1));
      }
    }
    return results;
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const direct = convertManifestItemToMint(obj as CustomMintManifestItem, fallbackUrl);
    if (direct) {
      return [direct];
    }

    const results: RawDiscoveredMint[] = [];
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object') {
        results.push(...extractMintsFromJsonNode(val, fallbackUrl, depth + 1));
      }
    }
    return results;
  }

  return [];
}

/**
 * Extracts balanced JSON objects containing "events", "mints", or "drops" from Next.js
 * App Router RSC flight streams (<script>self.__next_f.push([1, "..."])</script>).
 */
function extractFromNextAppRouterRsc(html: string, fallbackUrl: string): RawDiscoveredMint[] {
  const rscScripts = [...html.matchAll(/<script>self\.__next_f\.push\(\[1,(".*?")\]\)<\/script>/gs)];
  if (rscScripts.length === 0) return [];

  let fullRsc = '';
  for (const match of rscScripts) {
    try {
      const chunk = JSON.parse(match[1]);
      if (typeof chunk === 'string') {
        fullRsc += chunk;
      }
    } catch {
      // Ignore malformed chunk
    }
  }

  if (!fullRsc) return [];

  const results: RawDiscoveredMint[] = [];
  const arrayKeys = ['{"events":[', '{"mints":[', '{"drops":[', '{"collections":['];

  for (const marker of arrayKeys) {
    let searchStart = 0;
    while (searchStart < fullRsc.length) {
      const startIdx = fullRsc.indexOf(marker, searchStart);
      if (startIdx === -1) break;

      let depth = 0;
      let inStr = false;
      let escaped = false;
      let endIdx = -1;

      for (let i = startIdx; i < fullRsc.length; i++) {
        const ch = fullRsc[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (!inStr) {
          if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }
      }

      if (endIdx !== -1) {
        const jsonCandidate = fullRsc.slice(startIdx, endIdx);
        try {
          const parsed = JSON.parse(jsonCandidate);
          results.push(...extractMintsFromJsonNode(parsed, fallbackUrl));
        } catch {
          // Continue searching
        }
        searchStart = endIdx;
      } else {
        break;
      }
    }
  }

  return results;
}

/**
 * Parses 5-bullet text or HTML blocks matching:
 * @Handle
 * • Chain : Robinhood Chain
 * • Time : <t:1760803200:t> or 2026-10-19T16:00:00Z
 * • Mint page : https://...
 * • Price : Free
 * • Supply : 3333
 */
function parseBulletBlocksFromText(rawText: string, fallbackUrl: string): RawDiscoveredMint[] {
  const plain = rawText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&bull;|&#8226;/gi, '•')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const lines = plain
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const results: RawDiscoveredMint[] = [];
  let current: Partial<CustomMintManifestItem> | null = null;

  const flushCurrent = () => {
    if (current) {
      const mint = convertManifestItemToMint(current as CustomMintManifestItem, fallbackUrl);
      if (mint) results.push(mint);
      current = null;
    }
  };

  for (const line of lines) {
    const handleHeader = line.match(/^@([a-zA-Z0-9_.-]{2,40})$/);
    if (handleHeader) {
      flushCurrent();
      current = {
        projectName: handleHeader[1],
        twitterHandle: `@${handleHeader[1]}`,
      };
      continue;
    }

    const kvMatch = line.match(/^(?:[•*-]\s*)?(chain|network|time|date|mint\s*page|url|link|price|supply|project|name)\s*:\s*(.+)$/i);
    if (kvMatch) {
      if (!current) current = {};
      const key = kvMatch[1].toLowerCase().replace(/\s+/g, ' ');
      const val = kvMatch[2].trim();
      if (key === 'project' || key === 'name') {
        current.projectName = val;
      } else if (key === 'chain' || key === 'network') {
        current.chain = val;
      } else if (key === 'time' || key === 'date') {
        current.time = val;
      } else if (key === 'mint page' || key === 'url' || key === 'link') {
        current.mintUrl = val;
      } else if (key === 'price') {
        current.price = val;
      } else if (key === 'supply') {
        current.supply = val;
      }
    }
  }
  flushCurrent();

  return results;
}

/**
 * Parses either a JSON drop manifest, Next.js App Router RSC payload, Next.js __NEXT_DATA__,
 * HTML page with <meta name="nft:mint:*"> tags, or 5-bullet text blocks.
 */
export function parseCustomMintPayload(bodyText: string, sourceUrl: string): RawDiscoveredMint[] {
  const trimmed = bodyText.trim();
  if (!trimmed) return [];

  // 1. Direct JSON payload (array or object)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const extracted = extractMintsFromJsonNode(parsed, sourceUrl);
      if (extracted.length > 0) return deduplicateRawMints(extracted);
    } catch {
      // Fall through to HTML/text parsing
    }
  }

  const collected: RawDiscoveredMint[] = [];

  // 2. Next.js App Router RSC flight payload (<script>self.__next_f.push([1, "..."])</script>)
  //    Used by https://tesserapp.org/calendar and modern Next.js 14/15 App Router sites
  const rscMints = extractFromNextAppRouterRsc(trimmed, sourceUrl);
  if (rscMints.length > 0) {
    collected.push(...rscMints);
  }

  // 3. Embedded <script id="__NEXT_DATA__"> or <script type="application/json|ld+json">
  const scriptRegex = /<script[^>]+(?:id=["']__NEXT_DATA__["']|type=["']application\/(?:ld\+)?json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRegex.exec(trimmed)) !== null) {
    try {
      const jsonContent = JSON.parse(scriptMatch[1].trim());
      collected.push(...extractMintsFromJsonNode(jsonContent, sourceUrl));
    } catch {
      // Ignore non-JSON script blocks
    }
  }

  // 4. Standard HTML <meta name="nft:mint:*"> tags
  const projectName =
    extractMetaContent(trimmed, 'nft:mint:project') ??
    extractMetaContent(trimmed, 'og:title');
  const rawChain = extractMetaContent(trimmed, 'nft:mint:chain');
  const mintStartIso =
    extractMetaContent(trimmed, 'nft:mint:start_utc') ??
    extractMetaContent(trimmed, 'nft:mint:start_time') ??
    extractMetaContent(trimmed, 'nft:mint:start');

  if (projectName && rawChain && mintStartIso) {
    const chainId = resolveFlexibleChainId(rawChain, projectName);
    if (chainId) {
      const contractAddress = extractMetaContent(trimmed, 'nft:mint:contract');
      const rawCategory = extractMetaContent(trimmed, 'nft:mint:category');
      const rawPrice = extractMetaContent(trimmed, 'nft:mint:price');
      const rawSymbol = extractMetaContent(trimmed, 'nft:mint:symbol');
      const { category, mintPriceExact, mintPriceSymbol } = parsePriceAndCategory(
        rawPrice,
        rawCategory ?? undefined,
        rawSymbol
      );

      collected.push({
        projectName,
        collectionName: extractMetaContent(trimmed, 'nft:mint:collection') ?? projectName,
        collectionSlug: extractMetaContent(trimmed, 'nft:mint:slug') ?? undefined,
        twitterHandle: extractMetaContent(trimmed, 'nft:mint:twitter') ?? null,
        totalSupply: extractMetaContent(trimmed, 'nft:mint:supply') ?? null,
        chainId,
        contractAddress: contractAddress || null,
        mintStartIso,
        originalTimezone: extractMetaContent(trimmed, 'nft:mint:timezone') ?? 'UTC',
        category,
        mintPriceExact,
        mintPriceSymbol,
        websiteUrl: sourceUrl,
        sourceUrl,
        discoverySource: 'custom_website',
        verificationStatus: contractAddress ? 'verified' : 'unverified',
        verificationNotes: `Parsed from structured HTML meta tags at ${sourceUrl}`,
      });
    }
  }

  // 5. Plain-text or HTML 5-bullet mint blocks
  const bulletMints = parseBulletBlocksFromText(trimmed, sourceUrl);
  collected.push(...bulletMints);

  return deduplicateRawMints(collected);
}

function deduplicateRawMints(mints: RawDiscoveredMint[]): RawDiscoveredMint[] {
  const seen = new Set<string>();
  const unique: RawDiscoveredMint[] = [];
  for (const m of mints) {
    const key = `${m.chainId}:${m.projectName.toLowerCase()}:${m.mintStartIso}:${m.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(m);
    }
  }
  return unique;
}

export class CustomWebsiteDiscoveryAdapter implements MintDiscoveryAdapter {
  public readonly id = 'custom_website';
  public readonly name = 'Custom Mint Website & Manifest Adapter';
  public readonly requiresCredentials = false;

  private readonly urlsGetter: () => string[];
  private readonly storage?: StorageRepository;
  private readonly fetchImpl: (
    url: string
  ) => Promise<{ status: number; bodyText: string; finalUrl: string }>;
  private readonly dnsResolver?: DnsResolverFn;
  private cachedDbUrls: string[] = [];

  constructor(options?: {
    urlsGetter?: () => string[];
    storage?: StorageRepository;
    fetchImpl?: (url: string) => Promise<{ status: number; bodyText: string; finalUrl: string }>;
    dnsResolver?: DnsResolverFn;
  }) {
    this.storage = options?.storage;
    this.urlsGetter =
      options?.urlsGetter ??
      (() => {
        const raw = process.env.CUSTOM_MINT_FEED_URLS ?? '';
        const envUrls = raw
          .split(',')
          .map((u) => sanitizeEnvUrl(u))
          .filter((u) => u.length > 0 && !u.includes('httpbin.org'));
        return Array.from(new Set([...DEFAULT_BUILT_IN_MINT_WEBSITES, ...envUrls, ...this.cachedDbUrls]));
      });
    this.dnsResolver = options?.dnsResolver;
    this.fetchImpl =
      options?.fetchImpl ??
      ((url: string) => safeFetchExternalUrl(url, { timeoutMs: 12000, dnsResolver: this.dnsResolver }));
  }

  public setCachedDbUrls(urls: string[]): void {
    this.cachedDbUrls = urls;
  }

  public isConfigured(): boolean {
    return this.urlsGetter().length > 0;
  }

  public getConfigurationRequirement(): string {
    return 'Connect a mint calendar website via /mint source or set CUSTOM_MINT_FEED_URLS';
  }

  public async discoverUpcomingMints(): Promise<AdapterDiscoveryResult> {
    if (this.storage) {
      try {
        const dbSources = await this.storage.getFeedSources();
        this.cachedDbUrls = dbSources.filter((s) => s.enabled).map((s) => s.url);
      } catch {
        // Fallback to cached URLs
      }
    }

    const urls = this.urlsGetter();
    if (urls.length === 0) {
      return {
        adapterId: this.id,
        success: false,
        rawMints: [],
        errorMessage: 'No custom mint website URLs configured.',
      };
    }

    const discovered: RawDiscoveredMint[] = [];
    const errors: string[] = [];

    for (const rawUrl of urls) {
      const validation = await validateExternalUrl(rawUrl, {
        performDnsLookup: true,
        dnsResolver: this.dnsResolver,
      });

      if (!validation.valid || !validation.normalizedUrl) {
        const reason = validation.reason ?? 'Invalid URL';
        errors.push(`${rawUrl}: ${reason}`);
        logger.warn('CustomWebsiteAdapter', 'Rejected unsafe URL via SSRF guard', {
          url: rawUrl,
          reason,
        });
        if (this.storage) {
          await this.storage
            .updateFeedSourceStatus(rawUrl, { discoveredCount: 0, lastError: reason })
            .catch(() => undefined);
        }
        continue;
      }

      try {
        const response = await this.fetchImpl(validation.normalizedUrl);
        if (response.status < 200 || response.status >= 300) {
          const errStr = `HTTP ${response.status}`;
          errors.push(`${validation.normalizedUrl}: ${errStr}`);
          logger.warn('CustomWebsiteAdapter', 'Received non-200 HTTP status', {
            url: validation.normalizedUrl,
            status: response.status,
          });
          if (this.storage) {
            await this.storage
              .updateFeedSourceStatus(rawUrl, { discoveredCount: 0, lastError: errStr })
              .catch(() => undefined);
          }
          continue;
        }

        const items = parseCustomMintPayload(response.bodyText, response.finalUrl);
        discovered.push(...items);

        if (this.storage) {
          await this.storage
            .updateFeedSourceStatus(rawUrl, { discoveredCount: items.length, lastError: null })
            .catch(() => undefined);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`${validation.normalizedUrl}: ${errMsg}`);
        logger.warn('CustomWebsiteAdapter', 'Failed to fetch target URL', {
          url: validation.normalizedUrl,
          error: errMsg,
        });
        if (this.storage) {
          await this.storage
            .updateFeedSourceStatus(rawUrl, { discoveredCount: 0, lastError: errMsg })
            .catch(() => undefined);
        }
      }
    }

    const uniqueMints = deduplicateRawMints(discovered);
    return {
      adapterId: this.id,
      success: uniqueMints.length > 0 || errors.length === 0,
      rawMints: uniqueMints,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }
}
