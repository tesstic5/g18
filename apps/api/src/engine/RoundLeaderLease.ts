import crypto from 'node:crypto';
import { redis } from '../db/redis';

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/**
 * Redis lease used to elect exactly one house-clock owner across API replicas.
 * Standbys keep trying; when the owner dies, one takes over after the TTL.
 */
export class RoundLeaderLease {
  private readonly token = crypto.randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private leader = false;
  private stopped = true;

  constructor(
    private readonly key: string,
    private readonly ttlMs = 15_000,
    private readonly tickMs = 5_000,
    /** Consecutive failed ticks tolerated before leadership is surrendered.
     *  Docker DNS hiccups (EAI_AGAIN bursts) used to flap the leader after ONE
     *  failed renewal — pausing the whole game clock on a transient error. */
    private readonly maxConsecutiveErrors = 3
  ) {}

  start(onGained: () => void, onLost: () => void): void {
    if (!this.stopped) return;
    this.stopped = false;
    let consecutiveErrors = 0;
    const tick = async () => {
      if (this.stopped) return;
      try {
        if (this.leader) {
          const renewed =
            Number(
              await redis.eval(
                RENEW_SCRIPT,
                1,
                this.key,
                this.token,
                String(this.ttlMs)
              )
            ) === 1;
          if (!renewed) {
            // The key really expired/was stolen — not a transient lookup error.
            this.leader = false;
            consecutiveErrors = 0;
            onLost();
          } else {
            consecutiveErrors = 0;
          }
        } else {
          const acquired = await redis.set(
            this.key,
            this.token,
            'PX',
            this.ttlMs,
            'NX'
          );
          consecutiveErrors = 0;
          if (acquired === 'OK') {
            this.leader = true;
            onGained();
          }
        }
      } catch (e) {
        // Transient error path (DNS/TCP blip). Only surrender the clock after
        // maxConsecutiveErrors consecutive failures — by then the TTL has
        // expired anyway and a standby would legitimately take over. One bad
        // lookup must NOT pause every running round for everyone.
        consecutiveErrors += 1;
        if (this.leader && consecutiveErrors >= this.maxConsecutiveErrors) {
          console.warn(
            `[leader-lease] ${this.key}: ${consecutiveErrors} consecutive Redis failures — releasing leadership`,
            (e as Error).message
          );
          this.leader = false;
          onLost();
        }
      } finally {
        if (!this.stopped) this.timer = setTimeout(() => void tick(), this.tickMs);
      }
    };
    void tick();
  }

  async stop(onLost: () => void): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.leader) onLost();
    this.leader = false;
    try {
      await redis.eval(RELEASE_SCRIPT, 1, this.key, this.token);
    } catch {
      // TTL releases it if Redis is unavailable during shutdown.
    }
  }

  isLeader(): boolean {
    return this.leader;
  }
}
