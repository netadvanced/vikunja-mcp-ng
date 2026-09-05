import { format } from 'util';

import { redactSecretsInText, sanitizeLogArgs } from './security';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

class Logger {
  private level: LogLevel;
  private readonly levelNames: Record<LogLevel, string> = {
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.DEBUG]: 'DEBUG',
  };

  constructor() {
    this.level = Logger.determineLevel();
  }

  private static determineLevel(): LogLevel {
    const debugEnabled = process.env.DEBUG === 'true';
    const logLevelEnv = process.env.LOG_LEVEL;

    if (logLevelEnv) {
      const validLevels: Record<string, LogLevel> = {
        error: LogLevel.ERROR,
        warn: LogLevel.WARN,
        info: LogLevel.INFO,
        debug: LogLevel.DEBUG,
      };
      const normalized = logLevelEnv.toLowerCase();
      const matchedLevel = validLevels[normalized];
      if (matchedLevel !== undefined) {
        return matchedLevel;
      }
      // Invalid LOG_LEVEL: fall back to DEBUG if explicitly requested, else INFO
      return debugEnabled ? LogLevel.DEBUG : LogLevel.INFO;
    }

    return debugEnabled ? LogLevel.DEBUG : LogLevel.INFO;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    // The level gate comes first: nothing is cloned, walked or scanned for a
    // level that will not be emitted, so redaction costs nothing when off.
    if (level <= this.level) {
      const timestamp = new Date().toISOString();
      const levelStr = this.levelNames[level];

      // Structural pass: redacts by key name and unwraps Errors. Every call
      // site is covered here, so no caller has to remember to strip its own
      // credentials before logging.
      const safeArgs = sanitizeLogArgs(args);

      // Textual backstop over the rendered line: catches credentials
      // interpolated into the message itself and anything util.format pulled
      // out of a value the structural pass could not reach.
      const formattedMessage = redactSecretsInText(format(message, ...safeArgs));

      // Always use console.error for MCP servers as stdout is reserved for protocol
      console.error(`[${timestamp}] [${levelStr}] ${formattedMessage}`);
    }
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, message, ...args);
  }
}

export const logger = new Logger();
