/**
 * Centralized logging utility
 * Provides structured logging with different log levels
 */
type LogLevel = "debug" | "info" | "warn" | "error";
import dotenv from "dotenv";
dotenv.config();

const debugEnabled = process.env.DEBUG === "true";

class Logger {
  private shouldLog(level: LogLevel): boolean {
    // Debug level: only log if DEBUG=true
    if (level === "debug" || level === "info") {
      return debugEnabled;
    }

    // Warn and error: always log
    return true;
  }

  private formatMessage(
    level: LogLevel,
    category: string,
    message: string,
    ...args: any[]
  ): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${category}]`;
    return args.length > 0 ? `${prefix} ${message}` : `${prefix} ${message}`;
  }

  debug(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog("debug")) {
      console.log(this.formatMessage("debug", category, message), ...args);
    }
  }

  info(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog("info")) {
      console.log(this.formatMessage("info", category, message), ...args);
    }
  }

  warn(category: string, message: string, ...args: any[]): void {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage("warn", category, message), ...args);
    }
  }

  error(
    category: string,
    message: string,
    error?: Error | any,
    ...args: any[]
  ): void {
    if (this.shouldLog("error")) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(
        this.formatMessage("error", category, message),
        errorMsg,
        ...args
      );
      if (errorStack && debugEnabled) {
        console.error(errorStack);
      }
    }
  }
}

export const logger = new Logger();
