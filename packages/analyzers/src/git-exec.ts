import { execFile } from 'node:child_process';

/**
 * The only way Atlas invokes git. Read-only subcommands only (callers pass rev-parse, ls-files,
 * ls-tree, symbolic-ref, config --get). fsmonitor and hooks are disabled so repository config
 * cannot execute commands, and inherited GIT_* variables are dropped so they cannot redirect it.
 */
export function runGit(
  cwd: string,
  args: string[],
  opts: { maxBuffer?: number; timeoutMs?: number } = {},
): Promise<Buffer | undefined> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.quotePath=false',
        ...args,
      ],
      {
        cwd,
        env,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'buffer',
      },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

export async function runGitText(cwd: string, args: string[]): Promise<string | undefined> {
  const out = await runGit(cwd, args, { maxBuffer: 1024 * 1024, timeoutMs: 5000 });
  return out?.toString('utf8').trim();
}
