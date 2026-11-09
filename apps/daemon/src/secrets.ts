import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Anthropic API key for the design agent (D02c). Read order: env `ATLAS_ANTHROPIC_API_KEY`, the OS
 * keychain through `secret-tool` (libsecret) when it is on PATH, then `<dataDir>/secrets/
 * anthropic-api-key` (0600, directory 0700). Atlas writes only the file. The key is never logged,
 * returned by the API or included in errors.
 */
export interface ApiKeyStoreOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Try `secret-tool lookup` first (default true; tests turn it off). */
  secretTool?: boolean;
}

export const KEYCHAIN_ATTRS = ['service', 'system-atlas', 'account', 'anthropic-api-key'];
const VALID = /^[A-Za-z0-9_\-.]{10,400}$/;

export function apiKeyStore(o: ApiKeyStoreOptions) {
  const env = o.env ?? process.env;
  const dir = join(o.dataDir, 'secrets');
  const file = join(dir, 'anthropic-api-key');

  const keychain = () =>
    new Promise<string | undefined>((resolve) => {
      if (o.secretTool === false) return resolve(undefined);
      execFile(
        'secret-tool',
        ['lookup', ...KEYCHAIN_ATTRS],
        { timeout: 3_000, env },
        (err, stdout) => {
          const v = String(stdout ?? '').trim();
          resolve(!err && VALID.test(v) ? v : undefined);
        },
      );
    });

  return {
    async read(): Promise<string | undefined> {
      const fromEnv = env.ATLAS_ANTHROPIC_API_KEY?.trim();
      if (fromEnv) return fromEnv;
      const k = await keychain();
      if (k) return k;
      try {
        const v = (await readFile(file, 'utf8')).trim();
        return v || undefined;
      } catch {
        return undefined;
      }
    },
    async has(): Promise<boolean> {
      return !!(await this.read());
    },
    /** Stores the key in the 0600 file; rejects anything that does not look like a key. */
    async write(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const k = key.trim();
      if (!VALID.test(k)) return { ok: false, error: 'that does not look like an API key' };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writeFile(file, `${k}\n`, { mode: 0o600 });
      await chmod(file, 0o600); // mode applies only on create
      return { ok: true };
    },
    async remove(): Promise<void> {
      await rm(file, { force: true });
    },
  };
}
export type ApiKeyStore = ReturnType<typeof apiKeyStore>;
