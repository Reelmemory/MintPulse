/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Timezone & Daylight Saving Time (DST) Service
 * Uses standard ECMA-402 Intl.DateTimeFormat APIs for accurate IANA timezone conversions.
 */

export const COMMON_IANA_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Zurich',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const;

export function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') {
    return false;
  }
  const trimmed = timezone.trim();
  if (!trimmed) {
    return false;
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export interface FormattedMintTimestamp {
  formattedLocal: string;
  timezoneAbbreviation: string;
  ianaTimezone: string;
  unixSeconds: number;
  discordFullTag: string;
  discordRelativeTag: string;
}

export function formatUtcForGuildTimezone(utcIsoString: string, ianaTimezone: string): FormattedMintTimestamp {
  const safeTz = isValidIanaTimezone(ianaTimezone) ? ianaTimezone.trim() : 'UTC';
  const date = new Date(utcIsoString);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC timestamp: ${utcIsoString}`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });

  const parts = formatter.formatToParts(date);
  const tzNamePart = parts.find((p) => p.type === 'timeZoneName')?.value ?? safeTz;
  const formattedLocal = formatter.format(date);
  const unixSeconds = Math.floor(date.getTime() / 1000);

  return {
    formattedLocal,
    timezoneAbbreviation: tzNamePart,
    ianaTimezone: safeTz,
    unixSeconds,
    discordFullTag: `<t:${unixSeconds}:F>`,
    discordRelativeTag: `<t:${unixSeconds}:R>`,
  };
}

/**
 * Computes the local calendar date string (YYYY-MM-DD) for a given Date in a target IANA timezone.
 */
export function getLocalDateKey(date: Date, ianaTimezone: string): string {
  const safeTz = isValidIanaTimezone(ianaTimezone) ? ianaTimezone.trim() : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * Checks if a mint timestamp falls on "today" in the guild's configured timezone,
 * and has not already passed more than 2 hours ago.
 */
export function isMintTodayInTimezone(
  mintStartUtc: string,
  ianaTimezone: string,
  referenceNow: Date = new Date()
): boolean {
  const mintDate = new Date(mintStartUtc);
  if (Number.isNaN(mintDate.getTime())) return false;

  const todayKey = getLocalDateKey(referenceNow, ianaTimezone);
  const mintDayKey = getLocalDateKey(mintDate, ianaTimezone);
  return todayKey === mintDayKey && mintDate.getTime() >= referenceNow.getTime() - 2 * 60 * 60 * 1000;
}

/**
 * Checks if a mint timestamp falls within the next 7 days (168 hours) from referenceNow.
 */
export function isMintWithinNextSevenDays(
  mintStartUtc: string,
  referenceNow: Date = new Date()
): boolean {
  const mintDate = new Date(mintStartUtc);
  if (Number.isNaN(mintDate.getTime())) return false;

  const nowMs = referenceNow.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return mintDate.getTime() >= nowMs - 30 * 60 * 1000 && mintDate.getTime() <= nowMs + sevenDaysMs;
}
