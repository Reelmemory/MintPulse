/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * SSRF Guard & Safe External URL Validator
 * Protects MintPulse against Server-Side Request Forgery (SSRF), unsafe schemes,
 * DNS rebinding to internal networks, and cloud metadata harvesting.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl: string | null;
  hostname: string | null;
  resolvedIps: string[];
  reason?: string;
}

export type DnsResolverFn = (hostname: string) => Promise<string[]>;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.corp',
  '.home',
  '.lan',
];

/**
 * Checks if an IPv4 address belongs to loopback, private, link-local, CGNAT,
 * multicast, or broadcast ranges.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network / unspecified)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private network)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private network)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 & 192.0.2.0/24 (IETF / TEST-NET-1)
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved/Broadcast)
  if (a >= 224) return true;

  return false;
}

/**
 * Checks if an IPv6 address is loopback, unspecified, unique-local (fc00::/7),
 * link-local (fe80::/10), or IPv4-mapped private address.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::' || normalized === '0:0:0:0:0:0:0:1' || normalized === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice('::ffff:'.length);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateOrReservedIpv4(ipv4Part);
    }
    return true;
  }

  // fc00::/7 Unique Local Addresses (fc... or fd...)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // fe80::/10 Link-Local Addresses
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  // ff00::/8 Multicast
  if (normalized.startsWith('ff')) {
    return true;
  }

  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const cleaned = ip.trim().replace(/^\[|\]$/g, '');
  const version = net.isIP(cleaned);
  if (version === 4) {
    return isPrivateOrReservedIpv4(cleaned);
  }
  if (version === 6) {
    return isPrivateOrReservedIpv6(cleaned);
  }
  return true;
}

const defaultDnsResolver: DnsResolverFn = async (hostname: string): Promise<string[]> => {
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
};

/**
 * Cleans URLs that were accidentally pasted in Markdown format or angle brackets
 * e.g. "[https://example.com](https://example.com)", "https://example.com](https://example.com", or "<https://example.com>"
 */
export function sanitizeEnvUrl(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim().replace(/^['"<>]+|['"<>]+$/g, '').trim();

  // Handle "[label](https://...)"
  const fullMarkdownMatch = cleaned.match(/^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i);
  if (fullMarkdownMatch) {
    return fullMarkdownMatch[1].trim();
  }

  // Handle partial markdown paste like "https://httpbin.org/json](https://httpbin.org/json"
  const splitBracketMatch = cleaned.match(/^(https?:\/\/[^\]\s]+)\]\(https?:\/\/[^)\s]+\)?$/i);
  if (splitBracketMatch) {
    return splitBracketMatch[1].trim();
  }

  return cleaned;
}

/**
 * Validates a URL syntactically and checks against SSRF vectors (schemes, credentials,
 * private hostnames, literal private IPs, and optionally DNS-resolved private IPs).
 */
export async function validateExternalUrl(
  rawUrl: string,
  options: {
    requireHttps?: boolean;
    performDnsLookup?: boolean;
    dnsResolver?: DnsResolverFn;
  } = {}
): Promise<UrlValidationResult> {
  const { requireHttps = false, performDnsLookup = false, dnsResolver = defaultDnsResolver } = options;

  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, normalizedUrl: null, hostname: null, resolvedIps: [], reason: 'URL is empty or not a string.' };
  }

  const trimmed = sanitizeEnvUrl(rawUrl);
  if (trimmed.length > 2048) {
    return { valid: false, normalizedUrl: null, hostname: null, resolvedIps: [], reason: 'URL exceeds maximum length of 2048 characters.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, normalizedUrl: null, hostname: null, resolvedIps: [], reason: 'Malformed URL syntax.' };
  }

  // 1. Validate scheme
  if (requireHttps && parsed.protocol !== 'https:') {
    return {
      valid: false,
      normalizedUrl: null,
      hostname: parsed.hostname,
      resolvedIps: [],
      reason: `Unsafe protocol "${parsed.protocol}". Only HTTPS is permitted.`,
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      valid: false,
      normalizedUrl: null,
      hostname: parsed.hostname,
      resolvedIps: [],
      reason: `Disallowed URL scheme "${parsed.protocol}". Only HTTP and HTTPS are allowed.`,
    };
  }

  // 2. Reject embedded credentials
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalizedUrl: null,
      hostname: parsed.hostname,
      resolvedIps: [],
      reason: 'URLs containing embedded credentials (username/password) are forbidden.',
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { valid: false, normalizedUrl: null, hostname: null, resolvedIps: [], reason: 'URL is missing a valid hostname.' };
  }

  // 3. Reject blocked internal hostnames and suffixes
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return {
      valid: false,
      normalizedUrl: null,
      hostname,
      resolvedIps: [],
      reason: `SSRF Protection: Hostname "${hostname}" points to a restricted local or internal network.`,
    };
  }

  // 4. Reject octal/hex/integer obfuscated IPv4 hostnames (e.g. 0x7f000001 or 2130706433)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    return {
      valid: false,
      normalizedUrl: null,
      hostname,
      resolvedIps: [],
      reason: 'SSRF Protection: Numeric or hex-encoded IP hostnames are prohibited.',
    };
  }

  // 5. Check if hostname is a literal IP address
  const ipVersion = net.isIP(hostname);
  if (ipVersion !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      return {
        valid: false,
        normalizedUrl: null,
        hostname,
        resolvedIps: [hostname],
        reason: `SSRF Protection: IP address "${hostname}" is in a private, loopback, or reserved range.`,
      };
    }
    return {
      valid: true,
      normalizedUrl: parsed.toString(),
      hostname,
      resolvedIps: [hostname],
    };
  }

  // Require a valid public TLD structure (at least one dot)
  if (!hostname.includes('.')) {
    return {
      valid: false,
      normalizedUrl: null,
      hostname,
      resolvedIps: [],
      reason: `SSRF Protection: Single-label unqualified hostname "${hostname}" is not permitted.`,
    };
  }

  // 6. Optional DNS Resolution check to prevent DNS rebinding to internal IPs
  const resolvedIps: string[] = [];
  if (performDnsLookup) {
    const addresses = await dnsResolver(hostname);
    if (addresses.length === 0) {
      return {
        valid: false,
        normalizedUrl: null,
        hostname,
        resolvedIps: [],
        reason: `Unable to resolve DNS records for hostname "${hostname}".`,
      };
    }

    for (const addr of addresses) {
      resolvedIps.push(addr);
      if (isPrivateOrReservedIp(addr)) {
        return {
          valid: false,
          normalizedUrl: null,
          hostname,
          resolvedIps,
          reason: `SSRF Protection: Hostname "${hostname}" resolved to private or reserved IP "${addr}".`,
        };
      }
    }
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    hostname,
    resolvedIps,
  };
}

/**
 * Safely fetches an external URL after SSRF & DNS validation, with redirect hop validation
 * and timeout enforcement.
 */
export async function safeFetchExternalUrl(
  rawUrl: string,
  options: {
    timeoutMs?: number;
    maxRedirects?: number;
    headers?: Record<string, string>;
    dnsResolver?: DnsResolverFn;
  } = {}
): Promise<{ status: number; bodyText: string; finalUrl: string }> {
  const { timeoutMs = 8000, maxRedirects = 3, headers = {}, dnsResolver } = options;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validation = await validateExternalUrl(currentUrl, {
      performDnsLookup: true,
      dnsResolver,
    });

    if (!validation.valid || !validation.normalizedUrl) {
      throw new Error(validation.reason ?? 'Blocked by SSRF guard');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(validation.normalizedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'MintPulseBot/1.0 (+https://github.com/mintpulse/mintpulse)',
          Accept: 'application/json, text/html;q=0.9',
          ...headers,
        },
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect response (${response.status}) missing Location header.`);
        }
        currentUrl = new URL(location, validation.normalizedUrl).toString();
        continue;
      }

      const bodyText = await response.text();
      return {
        status: response.status,
        bodyText: bodyText.slice(0, 2_000_000), // Cap at 2MB for Next.js RSC pages
        finalUrl: validation.normalizedUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Exceeded maximum redirect hops (${maxRedirects}).`);
}
