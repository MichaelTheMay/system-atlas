import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runGitText } from '@atlas/analyzers';

export interface GitInfo {
  topLevel: string;
  commonDir: string;
  /** Registered root relative to the git top level, '' when they are equal. POSIX separators. */
  subPath: string;
  head?: string;
  branch?: string;
  remoteUrl?: string;
}

/** Read-only git inspection through the shared safe runner (`@atlas/analyzers` runGit). */
const git = runGitText;

export async function inspectGit(root: string): Promise<GitInfo | undefined> {
  const out = await git(root, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  if (!out) return undefined;
  const [top, common] = out.split('\n');
  if (!top || !common) return undefined;
  const topLevel = realpathSync(top);
  const commonDir = realpathSync(isAbsolute(common) ? common : resolve(root, common));
  const rel = relative(topLevel, realpathSync(root));
  const [head, branch, remote] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(root, ['config', '--get', 'remote.origin.url']),
  ]);
  return {
    topLevel,
    commonDir,
    subPath: rel.split(sep).join('/'),
    head: head && /^[0-9a-f]{40,64}$/.test(head) ? head : undefined,
    branch: branch || undefined,
    remoteUrl: remote ? redactRemoteUrl(remote) : undefined,
  };
}

/** Remove credentials and query strings from a remote URL (plan §5). */
export function redactRemoteUrl(url: string): string {
  try {
    const u = new URL(url);
    if (
      u.protocol === 'http:' ||
      u.protocol === 'https:' ||
      u.protocol === 'ssh:' ||
      u.protocol === 'git:'
    ) {
      u.username = u.protocol === 'ssh:' && u.username && !u.password ? u.username : '';
      u.password = '';
      u.search = '';
      u.hash = '';
      return u.toString();
    }
    return url;
  } catch {
    // scp-like syntax (git@host:path) carries no secret beyond a user name
    return url.replace(/\?.*$/, '');
  }
}
