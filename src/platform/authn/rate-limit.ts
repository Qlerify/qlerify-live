// Login rate limiting — a small, dependency-free, in-memory sliding-window
// limiter for /v1/auth/login (red-team High: "no login rate-limit").
//
// Two independent buckets per attempt:
//   - per IP      — blunts a single host spraying many accounts (credential
//                   stuffing). Generous, because an on-prem corporate NAT puts
//                   many legitimate users behind ONE source IP.
//   - per subject — blunts a focused password-guess against one account. Tight,
//                   and reset the moment that subject authenticates so a real
//                   user who fat-fingers a few times then succeeds is not locked.
//
// Check-then-act: a successful login never counts toward the limit (we only
// record FAILURES), so the legitimate path can't trip its own throttle. The IP
// bucket is intentionally NOT reset on success — one account succeeding must not
// wipe the failure history a stuffing run built up across other accounts; it
// decays on its own as the window slides.
//
// Scope: in-memory per process. For the single-process SQLite deployment this is
// sufficient. A multi-instance (Postgres-era) deployment needs a shared store
// (Redis) — flagged, not built here.

const WINDOW_MS = Number(process.env.LOGIN_RATELIMIT_WINDOW_MS) || 5 * 60 * 1000; // 5 min
const MAX_PER_SUBJECT = Number(process.env.LOGIN_RATELIMIT_SUBJECT_MAX) || 8;
const MAX_PER_IP = Number(process.env.LOGIN_RATELIMIT_IP_MAX) || 30;

interface Bucket {
  /** Failure timestamps (ms) within the current window, oldest first. */
  hits: number[];
}

interface RateDecision {
  blocked: boolean;
  /** Seconds until the oldest in-window failure expires (only when blocked). */
  retryAfterSec: number;
}

/** A sliding-window counter keyed by an opaque string. Construct with explicit
 * limits in tests; the login route uses the env-configured module singleton. */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  private prune(b: Bucket, now: number): void {
    const cutoff = now - this.windowMs;
    while (b.hits.length && b.hits[0] <= cutoff) b.hits.shift();
  }

  /** Is this key currently at/over its limit? Does NOT record an attempt. */
  check(key: string, now: number): RateDecision {
    const b = this.buckets.get(key);
    if (!b) return { blocked: false, retryAfterSec: 0 };
    this.prune(b, now);
    if (b.hits.length < this.max) return { blocked: false, retryAfterSec: 0 };
    const retryAfterSec = Math.max(1, Math.ceil((b.hits[0] + this.windowMs - now) / 1000));
    return { blocked: true, retryAfterSec };
  }

  /** Record one failed attempt against this key. */
  recordFailure(key: string, now: number): void {
    const b = this.buckets.get(key) ?? { hits: [] };
    this.prune(b, now);
    b.hits.push(now);
    this.buckets.set(key, b);
  }

  /** Clear a key's history (call on that key's successful login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop all state — test hook only. */
  clear(): void {
    this.buckets.clear();
  }
}

/** Outcome for a login attempt across both buckets. */
interface LoginGate {
  blocked: boolean;
  retryAfterSec: number;
}

/** The process-wide login limiter. One instance holds both the IP and subject
 * windows so the login handler makes a single, intention-revealing call. */
export class LoginRateLimiter {
  private readonly ip: SlidingWindowLimiter;
  private readonly subject: SlidingWindowLimiter;
  constructor(opts?: { windowMs?: number; ipMax?: number; subjectMax?: number }) {
    const windowMs = opts?.windowMs ?? WINDOW_MS;
    this.ip = new SlidingWindowLimiter(windowMs, opts?.ipMax ?? MAX_PER_IP);
    this.subject = new SlidingWindowLimiter(windowMs, opts?.subjectMax ?? MAX_PER_SUBJECT);
  }

  /** Is this (ip, subject) attempt currently throttled? Records nothing. */
  check(ip: string, subject: string, now: number = Date.now()): LoginGate {
    const ipD = this.ip.check(`ip:${ip}`, now);
    const subjD = subject ? this.subject.check(`subj:${subject}`, now) : { blocked: false, retryAfterSec: 0 };
    const retryAfterSec = Math.max(ipD.retryAfterSec, subjD.retryAfterSec);
    return { blocked: ipD.blocked || subjD.blocked, retryAfterSec };
  }

  /** Record a failed login against both buckets. */
  recordFailure(ip: string, subject: string, now: number = Date.now()): void {
    this.ip.recordFailure(`ip:${ip}`, now);
    if (subject) this.subject.recordFailure(`subj:${subject}`, now);
  }

  /** A successful login clears that SUBJECT's window (the IP window decays on its
   * own — see file header for why it is not reset here). */
  recordSuccess(_ip: string, subject: string): void {
    if (subject) this.subject.reset(`subj:${subject}`);
  }

  /** Drop all state — test hook only. */
  clear(): void {
    this.ip.clear();
    this.subject.clear();
  }
}

/** Module singleton used by the login route. */
export const loginRateLimiter = new LoginRateLimiter();
