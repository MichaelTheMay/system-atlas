import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { newId, Project, Worktree } from '@atlas/schema';
import type { Db } from '@atlas/store';
import { inspectGit, type GitInfo } from './git.ts';
import { stableId } from './ids.ts';

export interface Registration {
  project: Project;
  worktree: Worktree;
  created: { project: boolean; worktree: boolean };
}

interface ProjectRow {
  id: string;
  display_name: string;
  remote_url: string | null;
  created_at: string;
}
interface WorktreeRow {
  id: string;
  project_id: string;
  root_path: string;
  git_top_level: string | null;
  git_common_dir: string | null;
  git_sub_path: string | null;
  branch: string | null;
  created_at: string;
}

const toProject = (r: ProjectRow): Project =>
  Project.parse({
    schemaVersion: 1,
    id: r.id,
    displayName: r.display_name,
    remoteUrl: r.remote_url ?? undefined,
    createdAt: r.created_at,
  });

const toWorktree = (r: WorktreeRow): Worktree =>
  Worktree.parse({
    schemaVersion: 1,
    id: r.id,
    projectId: r.project_id,
    rootPath: r.root_path,
    git:
      r.git_top_level && r.git_common_dir
        ? {
            topLevel: r.git_top_level,
            commonDir: r.git_common_dir,
            subPath: r.git_sub_path ?? '',
            branch: r.branch ?? undefined,
          }
        : undefined,
    createdAt: r.created_at,
  });

/**
 * Register a root on disk (plan §5). Registration only reads the directory and git metadata;
 * it never writes into it.
 *
 * - The registered root is the analysis boundary. Git metadata is recorded but never widens it,
 *   so a fixture inside a larger repository is its own context.
 * - Another git worktree of the same repository at the same sub-path joins the same project as
 *   a separate worktree (analysis context). Separate clones become separate projects.
 * - Re-registering the same path returns the existing records unchanged (branch refreshed).
 */
export async function registerRoot(
  db: Db,
  rootPath: string,
  opts: { now?: Date; git?: GitInfo | null } = {},
): Promise<Registration> {
  const root = realpathSync(rootPath);
  if (!statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const git = opts.git === null ? undefined : (opts.git ?? (await inspectGit(root)));
  const now = (opts.now ?? new Date()).toISOString();

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM worktrees WHERE root_path = ?')
      .get<WorktreeRow>(root);
    if (existing) {
      if (git && git.branch !== (existing.branch ?? undefined)) {
        db.prepare('UPDATE worktrees SET branch = ? WHERE id = ?').run(
          git.branch ?? null,
          existing.id,
        );
        existing.branch = git.branch ?? null;
      }
      const project = db
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get<ProjectRow>(existing.project_id)!;
      return {
        project: toProject(project),
        worktree: toWorktree(existing),
        created: { project: false, worktree: false },
      };
    }

    let projectRow: ProjectRow | undefined;
    if (git) {
      const sibling = db
        .prepare(
          'SELECT project_id FROM worktrees WHERE git_common_dir = ? AND git_sub_path = ? LIMIT 1',
        )
        .get<{ project_id: string }>(git.commonDir, git.subPath);
      if (sibling)
        projectRow = db
          .prepare('SELECT * FROM projects WHERE id = ?')
          .get<ProjectRow>(sibling.project_id);
    }
    const createdProject = !projectRow;
    if (!projectRow) {
      projectRow = {
        id: newId('project'),
        display_name: basename(root) || root,
        remote_url: git?.remoteUrl ?? null,
        created_at: now,
      };
      db.prepare(
        'INSERT INTO projects (id, display_name, remote_url, created_at) VALUES (?, ?, ?, ?)',
      ).run(projectRow.id, projectRow.display_name, projectRow.remote_url, projectRow.created_at);
    }

    const wt: WorktreeRow = {
      id: stableId('worktree', projectRow.id, root),
      project_id: projectRow.id,
      root_path: root,
      git_top_level: git?.topLevel ?? null,
      git_common_dir: git?.commonDir ?? null,
      git_sub_path: git ? git.subPath : null,
      branch: git?.branch ?? null,
      created_at: now,
    };
    db.prepare(
      `INSERT INTO worktrees (id, project_id, root_path, git_top_level, git_common_dir, git_sub_path, branch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      wt.id,
      wt.project_id,
      wt.root_path,
      wt.git_top_level,
      wt.git_common_dir,
      wt.git_sub_path,
      wt.branch,
      wt.created_at,
    );

    return {
      project: toProject(projectRow),
      worktree: toWorktree(wt),
      created: { project: createdProject, worktree: true },
    };
  });
}

export interface ProjectWithWorktrees {
  project: Project;
  worktrees: Worktree[];
}

export function listProjects(db: Db): ProjectWithWorktrees[] {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at, id').all<ProjectRow>();
  const wts = db.prepare('SELECT * FROM worktrees ORDER BY created_at, id').all<WorktreeRow>();
  return projects.map((p) => ({
    project: toProject(p),
    worktrees: wts.filter((w) => w.project_id === p.id).map(toWorktree),
  }));
}

export function getWorktree(db: Db, id: string): Worktree | undefined {
  const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get<WorktreeRow>(id);
  return row ? toWorktree(row) : undefined;
}
