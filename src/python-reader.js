import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProfileReader, ProfileError, PROFILE_CACHE_MS, subscriptionDates } from './profile.js';

const root = new URL('../', import.meta.url);
const workerPath = fileURLToPath(new URL('reader/worker.py', root));
const fatalCodes = new Set(['READER_AUTH', 'READER_VERIFICATION', 'READER_ACCESS', 'READER_DEPENDENCY', 'READER_PYTHON_VERSION', 'READER_PACKAGE_MISSING', 'READER_PACKAGE_VERSION', 'READER_PACKAGE_CONFLICT', 'READER_IMPORT_FAILED', 'READER_PYTHON_MISSING', 'READER_STARTUP', 'READER_PROTOCOL', 'READER_TIMEOUT', 'READER_CLOSED']);
const responseCodes = new Set([...fatalCodes, 'PROFILE_NOT_FOUND', 'PROFILE_PRIVATE', 'RATE_LIMIT', 'NETWORK', 'UNAVAILABLE', 'INVALID_TARGET']);

export function pythonExecutable(explicit) {
  if (explicit) return explicit;
  const local = fileURLToPath(new URL(process.platform === 'win32' ? '.venv-reader/Scripts/python.exe' : '.venv-reader/bin/python', root));
  return existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3';
}

// Private stdio transport: no listening port, no credential in argv, no raw logs.
export class PythonReaderBridge {
  constructor({ token, python, worker = workerPath, logger = console, startupTimeout = 60000, requestTimeout = 45000 } = {}) {
    this.token = token?.trim(); this.python = pythonExecutable(python); this.worker = worker;
    this.logger = logger; this.startupTimeout = startupTimeout; this.requestTimeout = requestTimeout;
    this.child = null; this.starting = null; this.pending = new Map(); this.sequence = 0;
    this.disabledCode = null; this.closed = false; this.connected = false;
  }
  fail(code) {
    if (this.disabledCode) return;
    this.connected = false;
    if (!this.disabledCode) {
      this.disabledCode = fatalCodes.has(code) ? code : 'READER_CLOSED';
      if (!this.closed) this.logger.warn(`[READER_STOPPED] ${this.disabledCode}`);
    }
    this.rejectStartup?.(new ProfileError(this.disabledCode));
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new ProfileError(this.disabledCode)); }
    this.pending.clear();
    this.child?.stdin.end(); this.child?.kill();
  }
  async start() {
    if (this.closed) throw new ProfileError('READER_CLOSED');
    if (!this.token) throw new ProfileError('READER_NOT_CONFIGURED');
    if (this.disabledCode) throw new ProfileError(this.disabledCode);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      let finished = false;
      const settle = (error) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        this.rejectStartup = null;
        error ? reject(error) : resolve();
      };
      this.rejectStartup = error => settle(error);
      const timer = setTimeout(() => this.fail('READER_STARTUP'), this.startupTimeout);
      const env = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      env.READER_TOKEN = this.token; env.PYTHONUNBUFFERED = '1'; env.PYTHONNOUSERSITE = '1';
      try {
        this.child = spawn(this.python, ['-u', this.worker], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      } catch { this.fail('READER_PYTHON_MISSING'); return; }
      const child = this.child;
      child.stdin.on('error', () => this.fail('READER_CLOSED'));
      // Drain stderr without ever forwarding Python/library exception text.
      child.stderr.on('data', () => {});
      const onLine = line => {
        if (this.disabledCode) return;
        let message;
        try { message = JSON.parse(line); } catch { this.fail('READER_PROTOCOL'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail('READER_PROTOCOL'); return; }
        if (message.type === 'ready' && message.protocol === 1 && !finished) { this.connected = true; settle(); this.logger.info('[READER_READY] discord.py-self'); return; }
        if (message.type === 'fatal') { this.fail(message.code); return; }
        const entry = this.pending.get(message.id);
        if (!entry) { this.fail('READER_PROTOCOL'); return; }
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.ok === true && message.dates && typeof message.dates === 'object') entry.resolve(message.dates);
        else if (responseCodes.has(message.code)) {
          const error = new ProfileError(message.code);
          if (message.code === 'RATE_LIMIT' && Number.isFinite(message.retryAfterMs) && message.retryAfterMs > 0) error.retryAfterMs = message.retryAfterMs;
          entry.reject(error);
          if (fatalCodes.has(message.code)) this.fail(message.code);
        }
        else { entry.reject(new ProfileError('READER_PROTOCOL')); this.fail('READER_PROTOCOL'); }
      };
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.disabledCode) return;
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          if (end > 4096) { this.fail('READER_PROTOCOL'); return; }
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          onLine(line);
          if (this.disabledCode) return;
        }
        if (buffer.length > 4096) this.fail('READER_PROTOCOL');
      });
      child.once('error', error => this.fail(error.code === 'ENOENT' ? 'READER_PYTHON_MISSING' : 'READER_STARTUP'));
      child.once('close', () => { if (!this.closed) this.fail('READER_CLOSED'); });
    });
    return this.starting;
  }
  async get(userId) {
    if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) throw new ProfileError('INVALID_TARGET');
    await this.start();
    if (this.disabledCode) throw new ProfileError(this.disabledCode);
    if (this.pending.size >= 3) throw new ProfileError('BUSY');
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('READER_TIMEOUT'), this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, userId }) + '\n', error => { if (error) this.fail('READER_CLOSED'); });
    });
  }
  async close() {
    this.closed = true;
    this.fail('READER_CLOSED');
  }
}

export class PythonProfileReader extends ProfileReader {
  constructor({ token, python, bridge, cacheFile = fileURLToPath(new URL('../data/reader-cache.json', import.meta.url)), ...options } = {}) {
    super({ ...options, cacheFile });
    this.bridge = bridge || new PythonReaderBridge({ token, python, logger: this.logger });
  }
  async fetchProfile(userId) {
    let raw;
    try { raw = await this.bridge.get(userId); }
    catch (error) {
      if (['PROFILE_NOT_FOUND', 'PROFILE_PRIVATE'].includes(error.code)) return this.unavailableProfile(userId, error.code);
      if (['RATE_LIMIT', 'NETWORK', 'UNAVAILABLE'].includes(error.code)) {
        const delay = error.code === 'RATE_LIMIT' && Number.isFinite(error.retryAfterMs) ? Math.max(60000, error.retryAfterMs) : 60000;
        throw this.block(error.code, delay);
      }
      throw error;
    }
    const fetchedAt = this.now();
    let minimal;
    try { minimal = subscriptionDates(raw, fetchedAt); }
    catch { return this.unavailableProfile(userId, 'MISSING_DATE'); }
    await this.remember(userId, { data: minimal, fetchedAt, until: fetchedAt + PROFILE_CACHE_MS });
    return { ...minimal, fetchedAt };
  }
  async close() { await this.bridge.close(); await this.saveTail; }
}

export function readProfileConfig(env = process.env) {
  const source = (env.PROFILE_SOURCE || 'discord.py-self').trim().toLowerCase();
  if (!['discord.py-self', 'dcdn'].includes(source)) throw new Error('PROFILE_SOURCE يجب أن يكون discord.py-self أو dcdn.');
  return { source, token: env.READER_TOKEN?.trim() || '', python: env.PYTHON_BIN?.trim() || undefined };
}

export function createProfileReader(settings, options = {}) {
  return settings.source === 'dcdn' ? new ProfileReader(options) : new PythonProfileReader({ ...options, token: settings.token, python: settings.python });
}
