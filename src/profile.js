import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILE_API = 'https://dcdn.dstn.to/profile/';
export const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;
export const PROFILE_ERROR_CACHE_MS = 60 * 60 * 1000;
const MIN_REQUEST_INTERVAL_MS = 5000;
const MAX_PENDING = 3;
const MAX_CACHE = 500;
const dateFields = ['premium_since', 'premium_guild_since'];
const cachedErrors = new Set(['PROFILE_NOT_FOUND', 'PROFILE_PRIVATE', 'MISSING_DATE']);
const defaultCacheFile = fileURLToPath(new URL('../data/profile-cache.json', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ProfileError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function subscriptionDates(value, now) {
  const minimal = {};
  for (const field of dateFields) {
    if (!Object.hasOwn(value, field)) continue;
    const date = value[field];
    if (date !== null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || Date.parse(date) > now)) {
      throw new ProfileError('MISSING_DATE');
    }
    minimal[field] = date;
  }
  if (!Object.keys(minimal).length) throw new ProfileError('MISSING_DATE');
  return minimal;
}

function retryDelay(response, body, now) {
  const value = body?.retry_after ?? response.headers.get('retry-after');
  if (value !== null && value !== undefined && String(value).trim()) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(MIN_REQUEST_INTERVAL_MS, seconds * 1000);
    const date = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(date) && date > now) return Math.max(MIN_REQUEST_INTERVAL_MS, date - now);
  }
  return 5 * 60 * 1000;
}

// External, unofficial profile service. No Discord user credentials, fallback
// user-account API, batch requests, or scheduled profile polling are used.
export class ProfileReader {
  constructor({ request = fetch, cacheFile = defaultCacheFile, now = Date.now, wait = pause, logger = console } = {}) {
    this.request = request;
    this.cacheFile = cacheFile ? resolve(cacheFile) : null;
    this.now = now;
    this.wait = wait;
    this.logger = logger;
    this.cache = new Map();
    this.inflight = new Map();
    this.blockUntil = 0;
    this.blockCode = 'UNAVAILABLE';
    this.nextRequestAt = 0;
    this.tail = Promise.resolve();
    this.saveTail = Promise.resolve();
    this.ready = this.loadCache();
  }

  async loadCache() {
    if (!this.cacheFile) return;
    try {
      const saved = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries)) return;
      const now = this.now();
      for (const pair of saved.entries.slice(-MAX_CACHE)) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, entry] = pair;
        if (typeof id !== 'string' || !/^\d{17,20}$/.test(id) || !entry || !Number.isFinite(entry.until) || entry.until <= now) continue;
        if (cachedErrors.has(entry.error) && entry.until <= now + PROFILE_ERROR_CACHE_MS) {
          this.cache.set(id, { error: entry.error, until: entry.until });
        } else if (Number.isFinite(entry.fetchedAt) && entry.fetchedAt <= now && entry.until <= entry.fetchedAt + PROFILE_CACHE_MS && entry.data && typeof entry.data === 'object') {
          try {
            this.cache.set(id, { data: subscriptionDates(entry.data, now), fetchedAt: entry.fetchedAt, until: entry.until });
          } catch { /* Ignore an invalid cache record; never manufacture dates. */ }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('[PROFILE_CACHE_READ] تعذرت قراءة التخزين المؤقت؛ سيُستخدم تخزين الذاكرة.');
    }
  }

  async saveCache() {
    if (!this.cacheFile) return;
    this.saveTail = this.saveTail.then(async () => {
      const now = this.now();
      const entries = [...this.cache].filter(([, entry]) => entry.until > now);
      await mkdir(dirname(this.cacheFile), { recursive: true });
      const temporary = this.cacheFile + '.tmp';
      await writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      await rename(temporary, this.cacheFile);
    }).catch(() => {
      this.logger.warn('[PROFILE_CACHE_WRITE] تعذر حفظ التخزين المؤقت على القرص؛ يستمر التخزين في الذاكرة.');
    });
    await this.saveTail;
  }

  async remember(id, entry) {
    for (const [key, cached] of this.cache) if (cached.until <= this.now()) this.cache.delete(key);
    this.cache.delete(id);
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id, entry);
    await this.saveCache();
  }

  block(code, duration) {
    this.blockCode = code;
    this.blockUntil = this.now() + duration;
    return new ProfileError(code);
  }

  async get(userId) {
    if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) throw new ProfileError('INVALID_TARGET');
    await this.ready;
    const cached = this.cache.get(userId);
    if (cached && cached.until > this.now()) {
      if (cached.error) throw new ProfileError(cached.error);
      return { ...cached.data, fetchedAt: cached.fetchedAt };
    }
    if (this.inflight.has(userId)) return this.inflight.get(userId);
    if (this.now() < this.blockUntil) throw new ProfileError(this.blockCode);
    if (this.inflight.size >= MAX_PENDING) throw new ProfileError('BUSY');

    const task = this.tail.then(async () => {
      if (this.now() < this.blockUntil) throw new ProfileError(this.blockCode);
      const delay = this.nextRequestAt - this.now();
      if (delay > 0) await this.wait(delay);
      if (this.now() < this.blockUntil) throw new ProfileError(this.blockCode);
      this.nextRequestAt = this.now() + MIN_REQUEST_INTERVAL_MS;
      return this.fetchProfile(userId);
    });
    this.tail = task.catch(() => {});
    this.inflight.set(userId, task);
    try { return await task; }
    finally { this.inflight.delete(userId); }
  }

  async fetchProfile(userId) {
    let response;
    try {
      response = await this.request(new URL(userId, PROFILE_API), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
    } catch { throw this.block('NETWORK', 60000); }

    if (response.status === 404) return this.unavailableProfile(userId, 'PROFILE_NOT_FOUND');
    if (response.status === 401 || response.status === 403) throw this.block('SERVICE_ACCESS', 15 * 60 * 1000);
    const data = await response.json().catch(() => null);
    if (response.status === 429) throw this.block('RATE_LIMIT', retryDelay(response, data, this.now()));
    if (!response.ok) throw this.block('UNAVAILABLE', 60000);
    if (!data || typeof data !== 'object') throw this.block('UNAVAILABLE', 60000);
    if (data.error) {
      if (data.code === 'unknown_user') return this.unavailableProfile(userId, 'PROFILE_NOT_FOUND');
      throw this.block('UNAVAILABLE', 60000);
    }
    if (data.user?.id !== userId) throw this.block('UNAVAILABLE', 60000);
    if (data.private === true) return this.unavailableProfile(userId, 'PROFILE_PRIVATE');

    const fetchedAt = this.now();
    let minimal;
    try { minimal = subscriptionDates(data, fetchedAt); }
    catch { return this.unavailableProfile(userId, 'MISSING_DATE'); }
    await this.remember(userId, { data: minimal, fetchedAt, until: fetchedAt + PROFILE_CACHE_MS });
    return { ...minimal, fetchedAt };
  }

  async unavailableProfile(id, code) {
    await this.remember(id, { error: code, until: this.now() + PROFILE_ERROR_CACHE_MS });
    throw new ProfileError(code);
  }
}

export function getStart(profile, kind, now = Date.now()) {
  const field = kind === 'nitro' ? 'premium_since' : 'premium_guild_since';
  if (!Object.hasOwn(profile, field)) throw new ProfileError('MISSING_DATE');
  if (profile[field] === null) throw new ProfileError('NO_DATE');
  const date = new Date(profile[field]);
  if (typeof profile[field] !== 'string' || !Number.isFinite(+date) || +date > now) throw new ProfileError('MISSING_DATE');
  return date;
}
