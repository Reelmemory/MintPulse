/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Structured Logger with Automatic Secret Redaction
 * Ensures tokens, API keys, and database credentials are never leaked in logs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /database[-_]?url/i,
  /authorization/i,
  /credential/i,
];

const VALUE_SECRET_PATTERNS = [
  /postgresql:\/\/[^\s]+/gi,
  /postgres:\/\/[^\s]+/gi,
  /Bot\s+[A-Za-z0-9._-]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
];

export function redactSecrets(input: unknown): unknown {
  if (typeof input === 'string') {
    let sanitized = input;
    for (const pattern of VALUE_SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED_SECRET]');
    }
    return sanitized;
  }

  if (Array.isArray(input)) {
    return input.map(redactSecrets);
  }

  if (input && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERNS.some((regex) => regex.test(key))) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = redactSecrets(value);
      }
    }
    return output;
  }

  return input;
}

class StructuredLogger {
  private recentLogs: LogEntry[] = [];
  private readonly maxBufferSize = 200;

  private shouldLog(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    const configured = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'info';
    const minOrder = order[configured] ?? 20;
    return order[level] >= minOrder;
  }

  public log(level: LogLevel, moduleName: string, message: string, metadata?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: moduleName,
      message: redactSecrets(message) as string,
      metadata: metadata ? (redactSecrets(metadata) as Record<string, unknown>) : undefined,
    };

    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > this.maxBufferSize) {
      this.recentLogs.pop();
    }

    if (this.shouldLog(level) && process.env.NODE_ENV !== 'test') {
      const formatted = JSON.stringify(entry);
      // Emit structured JSON logs to stdout so handled operational events
      // are recorded cleanly without triggering stderr crash monitors.
      console.log(formatted);
    }

    return entry;
  }

  public debug(moduleName: string, message: string, metadata?: Record<string, unknown>): LogEntry {
    return this.log('debug', moduleName, message, metadata);
  }

  public info(moduleName: string, message: string, metadata?: Record<string, unknown>): LogEntry {
    return this.log('info', moduleName, message, metadata);
  }

  public warn(moduleName: string, message: string, metadata?: Record<string, unknown>): LogEntry {
    return this.log('warn', moduleName, message, metadata);
  }

  public error(moduleName: string, message: string, metadata?: Record<string, unknown>): LogEntry {
    return this.log('error', moduleName, message, metadata);
  }

  public getRecentLogs(limit = 50): LogEntry[] {
    return this.recentLogs.slice(0, limit);
  }
}

export const logger = new StructuredLogger();
