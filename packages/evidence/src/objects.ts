import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Content-addressed artifact bytes (plan §11): <root>/sha256/ab/cdef… . Writes stream to a temp
 * file while hashing, enforce a byte limit, verify the declared hash/size, then rename atomically.
 */
export class ObjectStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
  }

  pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
    return join(this.root, 'sha256', sha256.slice(0, 2), sha256.slice(2));
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  read(sha256: string): Readable {
    return createReadStream(this.pathFor(sha256));
  }

  size(sha256: string): number | undefined {
    try {
      return statSync(this.pathFor(sha256)).size;
    } catch {
      return undefined;
    }
  }

  async put(
    input: Readable,
    opts: { expectedSha256?: string; expectedSize?: number; maxBytes: number },
  ): Promise<{ sha256: string; byteLength: number; head: Buffer }> {
    const tmp = join(this.root, 'tmp', `${process.pid}-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    const out = createWriteStream(tmp, { mode: 0o600 });
    let size = 0;
    const headChunks: Buffer[] = [];
    let headLen = 0;
    try {
      for await (const chunk of input) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buf.length;
        if (size > opts.maxBytes)
          throw Object.assign(new Error(`artifact exceeds ${opts.maxBytes} bytes`), {
            code: 'TOO_LARGE',
          });
        if (headLen < 4096) {
          headChunks.push(buf.subarray(0, 4096 - headLen));
          headLen += Math.min(buf.length, 4096 - headLen);
        }
        hash.update(buf);
        if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
      const sha256 = hash.digest('hex');
      if (opts.expectedSha256 && opts.expectedSha256 !== sha256) {
        throw Object.assign(
          new Error(`hash mismatch: declared ${opts.expectedSha256}, received ${sha256}`),
          { code: 'HASH_MISMATCH' },
        );
      }
      if (opts.expectedSize !== undefined && opts.expectedSize !== size) {
        throw Object.assign(
          new Error(`size mismatch: declared ${opts.expectedSize}, received ${size}`),
          { code: 'SIZE_MISMATCH' },
        );
      }
      const dest = this.pathFor(sha256);
      if (existsSync(dest)) rmSync(tmp, { force: true });
      else {
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        renameSync(tmp, dest);
      }
      return { sha256, byteLength: size, head: Buffer.concat(headChunks) };
    } catch (e) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}
