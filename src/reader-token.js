import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileReader } from './python-reader.js';
import { ProfileError } from './profile.js';

export const TOKEN_MANAGER_ID = '141947703742562304';
export const READER_COUNT = 5;
// The old single-token store is retained only as a migration fallback for reader 1.
export const READER_TOKEN_FILE = fileURLToPath(new URL('../data/reader-token.json', import.meta.url));
const slotTokenFile = slot => fileURLToPath(new URL(`../data/reader-token-${slot}.json`, import.meta.url));
const slotCacheFile = slot => fileURLToPath(new URL(slot === 1 ? '../data/reader-cache.json' : `../data/reader-cache-${slot}.json`, import.meta.url));

function normalizeToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > 2048 || !/^[\x21-\x7e]+$/.test(token)) throw new ProfileError('TOKEN_INVALID');
  return token;
}

export async function loadReaderToken(fallback = '', file = READER_TOKEN_FILE) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    return normalizeToken(saved.token);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new ProfileError('TOKEN_STORE_READ');
  }
}

// READER_TOKEN_1 ... READER_TOKEN_5, with READER_TOKEN and the old saved
// reader-token.json as backwards-compatible fallbacks for reader 1.
export async function loadReaderTokens(env = process.env, { tokenFileForSlot = slotTokenFile, legacyFile = READER_TOKEN_FILE } = {}) {
  const result = [];
  for (let i = 1; i <= READER_COUNT; i++) {
    // Explicit READER_TOKEN_1 beats the old saved store; a new numbered
    // saved file always beats environment configuration for its own slot.
    const explicit = env[`READER_TOKEN_${i}`]?.trim() || '';
    const fallback = i === 1
      ? (explicit || await loadReaderToken(env.READER_TOKEN?.trim() || '', legacyFile))
      : explicit;
    result.push(await loadReaderToken(fallback, tokenFileForSlot(i)));
  }
  return result;
}

export async function saveReaderToken(value, file = READER_TOKEN_FILE) {
  const token = normalizeToken(value);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ token }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch {
    throw new ProfileError('TOKEN_STORE_WRITE');
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// Each numbered slot owns its own Python connection and cache. Changing one
// credential never disconnects the other four readers.
export class UpdatableProfileReader {
  constructor(settings, { tokenFile = READER_TOKEN_FILE, cacheFile, createReader = createProfileReader, persist = saveReaderToken, botToken = '', logger = console } = {}) {
    this.settings = { ...settings };
    this.tokenFile = tokenFile;
    this.cacheFile = cacheFile;
    this.createReader = createReader;
    this.persist = persist;
    this.botToken = botToken;
    this.logger = logger;
    this.reader = createReader(this.settings, cacheFile ? { cacheFile } : {});
    this.updating = false;
    this.closed = false;
  }
  get(userId) {
    if (this.closed) return Promise.reject(new ProfileError('READER_CLOSED'));
    if (this.updating) return Promise.reject(new ProfileError('TOKEN_BUSY'));
    return this.reader.get(userId);
  }
  // The status check does not read a profile. It only checks the actual worker
  // connection (optionally starting a not-yet-started configured reader).
  async getStatus({ probe = false } = {}) {
    if (this.closed) return { state: 'stopped', code: 'READER_CLOSED' };
    if (this.updating) return { state: 'updating' };
    if (this.settings.source !== 'discord.py-self') return { state: 'external' };
    if (!this.settings.token) return { state: 'missing' };
    const bridge = this.reader.bridge;
    if (bridge?.disabledCode) return { state: 'stopped', code: bridge.disabledCode };
    if (bridge?.connected) return { state: 'connected' };
    if (!probe) return { state: 'not-checked' };
    try {
      await this.reader.ready;
      await bridge.start();
      return bridge.disabledCode ? { state: 'stopped', code: bridge.disabledCode } : { state: 'connected' };
    } catch (error) {
      return { state: 'stopped', code: /^[A-Z_]{3,50}$/.test(error?.code || '') ? error.code : 'READER_STARTUP' };
    }
  }
  async updateToken(value) {
    if (this.closed) throw new ProfileError('READER_CLOSED');
    if (this.settings.source !== 'discord.py-self') throw new ProfileError('TOKEN_SOURCE');
    if (this.updating) throw new ProfileError('TOKEN_BUSY');
    const token = normalizeToken(value);
    if (token === this.botToken) throw new ProfileError('TOKEN_INVALID');
    if (token === this.settings.token) throw new ProfileError('TOKEN_UNCHANGED');
    this.updating = true;
    let candidate;
    try {
      // Drain accepted profile requests before replacing the chosen reader.
      await this.reader.ready;
      await this.reader.tail;
      if (this.closed) throw new ProfileError('READER_CLOSED');
      candidate = this.createReader({ ...this.settings, token }, this.cacheFile ? { cacheFile: this.cacheFile } : {});
      await candidate.ready;
      await candidate.bridge.start();
      if (this.closed) throw new ProfileError('READER_CLOSED');
      await this.persist(token, this.tokenFile);
      const previous = this.reader;
      this.reader = candidate;
      this.settings.token = token;
      candidate = null;
      // The new credential can see different private data than the prior one.
      for (const [id, entry] of this.reader.cache) if (entry.error) this.reader.cache.delete(id);
      await this.reader.saveCache();
      await previous.close?.().catch(() => this.logger.warn('[READER_CLOSE_FAILED]'));
    } finally {
      if (candidate) await candidate.close?.().catch(() => {});
      this.updating = false;
    }
  }
  async close() {
    this.closed = true;
    await this.reader.close?.();
  }
}

// Round-robin among distinct configured slots. Do not retry a request using
// another credential after access denial, rate limiting, or a verification error.
// That response is returned to the caller as-is.
export class RotatingProfileReader {
  constructor(settings, { tokens = [], botToken = '', logger = console, createReader, persist, tokenFileForSlot = slotTokenFile, cacheFileForSlot = slotCacheFile } = {}) {
    this.settings = { ...settings };
    this.closed = false;
    this.cursor = 0;
    this.pendingTokens = new Set();
    const count = settings.source === 'discord.py-self' ? READER_COUNT : 1;
    this.slots = Array.from({ length: count }, (_, offset) => {
      const slot = offset + 1;
      return new UpdatableProfileReader({ ...settings, token: settings.source === 'discord.py-self' ? (tokens[offset] || '') : '' }, {
        botToken, logger, createReader, persist,
        tokenFile: tokenFileForSlot(slot),
        cacheFile: settings.source === 'discord.py-self' ? cacheFileForSlot(slot) : undefined,
      });
    });
  }
  eligibleSlots() {
    const seen = new Set();
    return this.slots.filter(slot => {
      if (!slot.settings.token || slot.updating || slot.closed) return false;
      if (seen.has(slot.settings.token)) return false;
      seen.add(slot.settings.token);
      return !slot.reader.bridge?.disabledCode;
    });
  }
  get(userId) {
    if (this.closed) return Promise.reject(new ProfileError('READER_CLOSED'));
    if (this.settings.source !== 'discord.py-self') return this.slots[0].get(userId);
    const eligible = this.eligibleSlots();
    if (!eligible.length) {
      const configured = this.slots.some(slot => Boolean(slot.settings.token));
      return Promise.reject(new ProfileError(configured ? 'READER_CLOSED' : 'READER_NOT_CONFIGURED'));
    }
    const selected = eligible[this.cursor++ % eligible.length];
    return selected.get(userId);
  }
  async updateToken(value, slotNumber = 1) {
    if (this.closed) throw new ProfileError('READER_CLOSED');
    if (this.settings.source !== 'discord.py-self') throw new ProfileError('TOKEN_SOURCE');
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > READER_COUNT) throw new ProfileError('TOKEN_SLOT_INVALID');
    const token = normalizeToken(value);
    if (this.pendingTokens.has(token) || this.slots.some((reader, i) => i !== slotNumber - 1 && reader.settings.token === token)) throw new ProfileError('TOKEN_DUPLICATE');
    this.pendingTokens.add(token);
    try { return await this.slots[slotNumber - 1].updateToken(token); }
    finally { this.pendingTokens.delete(token); }
  }
  async getStatuses({ probe = false } = {}) {
    if (this.settings.source !== 'discord.py-self') return Array.from({ length: READER_COUNT }, (_, index) => ({ slot: index + 1, state: 'external' }));
    const seen = new Set();
    // No exposed tokens or account identifiers in the return value.
    return Promise.all(this.slots.map(async (reader, index) => {
      const token = reader.settings.token;
      if (token && seen.has(token)) return { slot: index + 1, state: 'duplicate' };
      if (token) seen.add(token);
      return { slot: index + 1, ...await reader.getStatus({ probe }) };
    }));
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.slots.map(reader => reader.close()));
  }
}
