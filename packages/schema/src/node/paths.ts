import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * All Atlas state lives outside target repositories (plan §5).
 *
 * data:    $ATLAS_DATA_DIR or $XDG_DATA_HOME/system-atlas or ~/.local/share/system-atlas
 *          (macOS: ~/Library/Application Support/system-atlas, Windows: %LOCALAPPDATA%\system-atlas)
 * runtime: $ATLAS_RUNTIME_DIR or $XDG_RUNTIME_DIR/system-atlas or <data>/run
 *
 * Layout under data:
 *   atlas.sqlite                   registry + semantic + view + execution tables (WAL)
 *   backups/                       pre-migration copies
 *   objects/sha256/ab/cdef…        content-addressed artifact bytes
 *   cache/                         reclaimable caches (thumbnails, parse cache)
 * Layout under runtime:
 *   daemon.json  (0600)            discovery record: pid, port, token
 */
export interface AtlasPaths {
  dataDir: string;
  runtimeDir: string;
  dbFile: string;
  backupsDir: string;
  objectsDir: string;
  cacheDir: string;
  discoveryFile: string;
}

export function resolveAtlasPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AtlasPaths {
  const home = env.HOME ?? homedir();
  let dataDir: string;
  if (env.ATLAS_DATA_DIR) dataDir = env.ATLAS_DATA_DIR;
  else if (platform === 'darwin')
    dataDir = join(home, 'Library', 'Application Support', 'system-atlas');
  else if (platform === 'win32')
    dataDir = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'system-atlas');
  else dataDir = join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'system-atlas');

  const runtimeDir =
    env.ATLAS_RUNTIME_DIR ??
    (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'system-atlas') : join(dataDir, 'run'));

  return {
    dataDir,
    runtimeDir,
    dbFile: join(dataDir, 'atlas.sqlite'),
    backupsDir: join(dataDir, 'backups'),
    objectsDir: join(dataDir, 'objects'),
    cacheDir: join(dataDir, 'cache'),
    discoveryFile: join(runtimeDir, 'daemon.json'),
  };
}
