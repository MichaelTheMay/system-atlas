import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Local discovery record (plan §14): how CLI/UI/SDK find the daemon. Mode 0600, dir 0700. */
export interface DiscoveryRecord {
  pid: number;
  port: number;
  host: '127.0.0.1';
  token: string;
  version: string;
  startedAt: string;
  dataDir: string;
}

export async function writeDiscovery(file: string, rec: DiscoveryRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

export async function readDiscovery(file: string): Promise<DiscoveryRecord | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DiscoveryRecord;
  } catch {
    return undefined;
  }
}

export async function removeDiscovery(file: string, pid: number): Promise<void> {
  const rec = await readDiscovery(file);
  if (rec?.pid === pid) await rm(file, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
