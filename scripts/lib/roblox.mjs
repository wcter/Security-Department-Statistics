/**
 * Minimal, rate-limit-aware Roblox API client.
 *
 * Everything here uses public, unauthenticated endpoints. Roblox does not expose
 * group join dates or promotion history publicly, which is exactly why this project
 * snapshots the roster on a schedule and derives history from the diffs.
 */

const UA = 'roblox-group-stats (+https://github.com/topics/roblox-group-stats)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

export class RobloxClient {
  constructor(opts = {}) {
    this.maxRetries = opts.maxRetries ?? 7;
    this.timeout = opts.requestTimeoutMs ?? 25000;
    this.baseBackoff = opts.baseBackoffMs ?? 900;
    this.maxBackoff = opts.maxBackoffMs ?? 60000;
    this.politeDelay = opts.politeDelayMs ?? 120;
    this.stats = { requests: 0, retries: 0, rateLimited: 0, errors: 0 };
    // Global cooldown: when one request gets 429'd, every other in-flight worker
    // waits too. Without this, a pool of N workers just burns N retries per limit.
    this._cooldownUntil = 0;
  }

  async _respectCooldown() {
    const wait = this._cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }

  _cooldown(ms) {
    this._cooldownUntil = Math.max(this._cooldownUntil, Date.now() + ms);
  }

  async request(url, init = {}) {
    let attempt = 0;
    let backoff = this.baseBackoff;

    for (;;) {
      await this._respectCooldown();

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeout);

      try {
        this.stats.requests++;
        const res = await fetch(url, {
          ...init,
          signal: ctl.signal,
          headers: {
            accept: 'application/json',
            'user-agent': UA,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...(init.headers || {}),
          },
        });
        clearTimeout(timer);

        if (res.status === 429) {
          this.stats.rateLimited++;
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : jitter(backoff);
          this._cooldown(waitMs);
          if (++attempt > this.maxRetries) throw new Error(`429 after ${attempt} attempts: ${url}`);
          this.stats.retries++;
          backoff = Math.min(backoff * 2, this.maxBackoff);
          continue;
        }

        if (res.status === 404) return null;

        if (res.status >= 500 || res.status === 408) {
          if (++attempt > this.maxRetries) throw new Error(`HTTP ${res.status}: ${url}`);
          this.stats.retries++;
          await sleep(jitter(backoff));
          backoff = Math.min(backoff * 2, this.maxBackoff);
          continue;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${url} :: ${body.slice(0, 300)}`);
        }

        if (this.politeDelay) await sleep(this.politeDelay);
        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        const transient =
          err.name === 'AbortError' ||
          err.name === 'TimeoutError' ||
          /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(String(err.message));

        if (!transient || ++attempt > this.maxRetries) {
          this.stats.errors++;
          throw err;
        }
        this.stats.retries++;
        await sleep(jitter(backoff));
        backoff = Math.min(backoff * 2, this.maxBackoff);
      }
    }
  }

  /** Group name, description, owner, memberCount, shout. */
  getGroup(groupId) {
    return this.request(`https://groups.roblox.com/v1/groups/${groupId}`);
  }

  /** All roles with id, name, rank (0-255) and memberCount. */
  async getRoles(groupId) {
    const data = await this.request(`https://groups.roblox.com/v1/groups/${groupId}/roles`);
    return (data?.roles || []).sort((a, b) => a.rank - b.rank);
  }

  /**
   * Every member of one role, following the cursor to the end.
   * onPage receives each batch so the caller can stream instead of buffering.
   */
  async eachRoleMember(groupId, roleId, onPage, { pageSize = 100 } = {}) {
    let cursor = '';
    let pages = 0;
    let total = 0;

    do {
      const url =
        `https://groups.roblox.com/v1/groups/${groupId}/roles/${roleId}/users` +
        `?limit=${pageSize}&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

      const page = await this.request(url);
      if (!page) break;

      const users = page.data || [];
      total += users.length;
      pages++;
      await onPage(users);

      cursor = page.nextPageCursor || '';
      // Defensive: a malformed cursor loop would otherwise spin forever.
      if (pages > 20000) throw new Error(`Runaway pagination on role ${roleId}`);
    } while (cursor);

    return { pages, total };
  }

  /**
   * Bulk account details (we only care about `created`, for account-age analysis).
   * 100 ids per call is the documented ceiling.
   */
  async getUserDetails(userIds) {
    const out = new Map();
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100);
      const data = await this.request('https://users.roblox.com/v1/users', {
        method: 'POST',
        body: JSON.stringify({ userIds: chunk, excludeBannedUsers: false }),
      });
      for (const u of data?.data || []) out.set(u.id, u);
    }
    return out;
  }
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Stable, unsigned avatar URL. The thumbnails API returns signed CDN links that
 * expire within hours, which is useless for a static site rebuilt every 6 hours.
 * This legacy redirect endpoint stays valid indefinitely.
 */
export function headshotUrl(userId, size = 48) {
  return `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=${size}&height=${size}&format=png`;
}
