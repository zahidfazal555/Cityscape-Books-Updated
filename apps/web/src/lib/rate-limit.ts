import { DomainError } from '@csd/core';

/**
 * Fixed-window counters in process memory (ENGINEERING-STANDARDS §2: login 10/min per IP,
 * API 300/min per user). v1 runs a single app instance; with more instances this moves to
 * Postgres or Redis so the limits hold across them.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 429 when `key` has used up its window. */
  take(key: string): void {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      this.sweep(t);
      return;
    }
    entry.count += 1;
    if (entry.count > this.limit) {
      const seconds = Math.ceil((entry.resetAt - t) / 1000);
      throw new DomainError('RATE_LIMITED', `Too many requests. Try again in ${seconds} seconds.`);
    }
  }

  /** Keeps memory bounded: drop expired windows once the map grows. */
  private sweep(t: number): void {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** Sign-in attempts per IP per minute. 10 in production; the e2e suite (one shared IP) raises it. */
const LOGIN_PER_MINUTE = Number(process.env['CSD_LOGIN_LIMIT_PER_MINUTE'] ?? '10') || 10;

export const limits = {
  /** Sign-in attempts per client IP. */
  login: new RateLimiter(LOGIN_PER_MINUTE, 60_000),
  /** Password-reset and invite redemptions per client IP. */
  tokenRedeem: new RateLimiter(10, 60_000),
  /** Reset emails per address and per IP: stops mail floods and link churn. */
  resetEmail: new RateLimiter(3, 60 * 60_000),
  resetIp: new RateLimiter(10, 60 * 60_000),
  /** Authenticated API calls per user. */
  api: new RateLimiter(300, 60_000),
};
