import { parse as parseToml } from 'smol-toml';
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerOutput,
  EntityObservation,
  EvidenceRef,
  InventoryFile,
  RelationObservation,
} from '../types.ts';
import { redactExcerpt } from '../redact.ts';

/**
 * Generic package-boundary analyzer: reads manifest files only (no installs, no scripts).
 * Emits one `package` entity per manifest directory, nested by path, plus `depends-on`
 * relations for dependencies that name another package in the same repository.
 */
export const MANIFEST_ANALYZER_ID = 'generic-manifests';
export const MANIFEST_ANALYZER_VERSION = '0.1.0';

type Ecosystem =
  'npm' | 'python' | 'go' | 'cargo' | 'maven' | 'gradle' | 'composer' | 'ruby' | 'elixir' | 'dart';

const MANIFEST_FILES: Record<string, Ecosystem> = {
  'package.json': 'npm',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'setup.cfg': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'cargo',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'composer.json': 'composer',
  Gemfile: 'ruby',
  'mix.exs': 'elixir',
  'pubspec.yaml': 'dart',
};

interface ParsedManifest {
  file: InventoryFile;
  dir: string;
  ecosystem: Ecosystem;
  name?: string;
  version?: string;
  attributes: Record<string, string | number | boolean | null>;
  /** Dependency names with the line they appear on. */
  deps: { name: string; line: number; workspaceProtocol: boolean }[];
  nameLine: number;
  lines: string[];
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const packageKey = (dir: string) => `pkg:${dir || '.'}`;

function lineOf(lines: string[], re: RegExp): number {
  const i = lines.findIndex((l) => re.test(l));
  return i >= 0 ? i + 1 : 1;
}

function evidenceAt(m: ParsedManifest, line: number): EvidenceRef {
  const { text } = redactExcerpt((m.lines[line - 1] ?? '').trim().slice(0, 300));
  return {
    path: m.file.path,
    contentHash: m.file.sha256,
    startLine: line,
    endLine: line,
    excerpt: text,
  };
}

function parseManifest(file: InventoryFile, text: string): ParsedManifest | undefined {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  const ecosystem = MANIFEST_FILES[name];
  if (!ecosystem) return undefined;
  const lines = text.split(/\r?\n/);
  const m: ParsedManifest = {
    file,
    dir: dirOf(file.path),
    ecosystem,
    attributes: { ecosystem, manifest: file.path },
    deps: [],
    nameLine: 1,
    lines,
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (ecosystem === 'npm' || ecosystem === 'composer') {
    const json = JSON.parse(text) as Record<string, unknown>;
    m.name = typeof json.name === 'string' ? json.name : undefined;
    m.version = typeof json.version === 'string' ? json.version : undefined;
    m.nameLine = lineOf(lines, /"name"\s*:/);
    if (json.private === true) m.attributes.private = true;
    if (json.workspaces) m.attributes.workspaceRoot = true;
    const depSections =
      ecosystem === 'npm'
        ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        : ['require', 'require-dev'];
    for (const section of depSections) {
      const deps = json[section];
      if (deps && typeof deps === 'object') {
        for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
          m.deps.push({
            name: dep,
            line: lineOf(lines, new RegExp(`"${esc(dep)}"\\s*:`)),
            workspaceProtocol: typeof spec === 'string' && spec.startsWith('workspace:'),
          });
        }
      }
    }
  } else if (ecosystem === 'python' && name === 'pyproject.toml') {
    const toml = parseToml(text) as {
      project?: { name?: string; version?: string; dependencies?: string[] };
      tool?: { poetry?: { name?: string } };
    };
    m.name = toml.project?.name ?? toml.tool?.poetry?.name;
    m.version = toml.project?.version;
    m.nameLine = lineOf(lines, /^\s*name\s*=/);
    for (const d of toml.project?.dependencies ?? []) {
      const dep = /^[A-Za-z0-9_.-]+/.exec(d)?.[0];
      if (dep)
        m.deps.push({
          name: dep,
          line: lineOf(lines, new RegExp(`["']${esc(dep)}`)),
          workspaceProtocol: false,
        });
    }
  } else if (ecosystem === 'cargo') {
    const toml = parseToml(text) as {
      package?: { name?: string; version?: string };
      workspace?: unknown;
      dependencies?: Record<string, unknown>;
    };
    m.name = toml.package?.name;
    m.version = typeof toml.package?.version === 'string' ? toml.package.version : undefined;
    m.nameLine = lineOf(lines, /^\s*name\s*=/);
    if (toml.workspace) m.attributes.workspaceRoot = true;
    for (const [dep, spec] of Object.entries(toml.dependencies ?? {})) {
      const isPath = typeof spec === 'object' && spec !== null && 'path' in spec;
      m.deps.push({
        name: dep,
        line: lineOf(lines, new RegExp(`^\\s*${esc(dep)}\\s*=`)),
        workspaceProtocol: isPath,
      });
    }
  } else if (ecosystem === 'go') {
    const mod = /^module\s+(\S+)/m.exec(text);
    m.name = mod?.[1];
    m.nameLine = lineOf(lines, /^module\s+/);
  } else if (ecosystem === 'maven') {
    const art = /<artifactId>([^<]+)<\/artifactId>/.exec(
      text.replace(/<parent>[\s\S]*?<\/parent>/, ''),
    );
    m.name = art?.[1];
    m.nameLine = lineOf(lines, /<artifactId>/);
  } else if (ecosystem === 'elixir') {
    m.name = /app:\s*:(\w+)/.exec(text)?.[1];
    m.nameLine = lineOf(lines, /app:\s*:/);
  } else if (ecosystem === 'dart') {
    m.name = /^name:\s*(\S+)/m.exec(text)?.[1];
    m.nameLine = lineOf(lines, /^name:/);
  } else if (name === 'setup.py') {
    m.name = /name\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
    m.nameLine = lineOf(lines, /name\s*=/);
  }
  if (m.version) m.attributes.version = m.version;
  return m;
}

export function createManifestAnalyzer(): Analyzer {
  return {
    id: MANIFEST_ANALYZER_ID,
    version: MANIFEST_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some((f) => f.role === 'manifest');
    },
    capabilities() {
      return {
        languages: ['package metadata'],
        entityKinds: ['package'],
        relationKinds: ['contains', 'depends-on'],
        limitations: [
          'Reads manifest files only; never installs dependencies or runs scripts.',
          'depends-on is emitted only between packages of the same repository; third-party dependencies are attributes, not entities.',
          'Gradle, Ruby and setup.cfg packages are named by directory; their dependency lists are not parsed.',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter(
        (p) => MANIFEST_FILES[p.slice(p.lastIndexOf('/') + 1)],
      );
    },
    async extract(files, ctx: AnalyzerContext): Promise<AnalyzerOutput> {
      const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
      const parsed: ParsedManifest[] = [];
      for (const f of files) {
        if (f.role !== 'manifest' || !MANIFEST_FILES[f.path.slice(f.path.lastIndexOf('/') + 1)])
          continue;
        ctx.signal.throwIfAborted();
        try {
          const m = parseManifest(f, await ctx.readFile(f.path));
          if (m) {
            parsed.push(m);
            out.handled.push({ path: f.path, support: 'syntax' });
          }
        } catch (e) {
          if ((e as Error).name === 'ContentChangedError') throw e;
          out.diagnostics.push({
            severity: 'warning',
            code: 'manifest-parse-failed',
            message: (e as Error).message.slice(0, 300),
            path: f.path,
          });
        }
      }

      // One package per directory; when a directory has several manifests, prefer the richest.
      const rank: Ecosystem[] = [
        'npm',
        'cargo',
        'python',
        'go',
        'maven',
        'gradle',
        'composer',
        'elixir',
        'dart',
        'ruby',
      ];
      const byDir = new Map<string, ParsedManifest>();
      for (const m of parsed.sort(
        (a, b) => rank.indexOf(a.ecosystem) - rank.indexOf(b.ecosystem) || (a.name ? -1 : 1),
      )) {
        if (!byDir.has(m.dir)) byDir.set(m.dir, m);
      }
      const dirs = [...byDir.keys()].sort();
      const ownerOf = (dir: string): string => {
        let d = dir;
        while (d) {
          d = dirOf(d);
          if (byDir.has(d) && d !== dir) return packageKey(d);
          if (!d) break;
        }
        return dir !== '' && byDir.has('') ? packageKey('') : 'system';
      };
      const nameToKey = new Map<string, string>();
      for (const dir of dirs) {
        const m = byDir.get(dir)!;
        const key = packageKey(dir);
        const display = m.name ?? (dir ? dir.slice(dir.lastIndexOf('/') + 1) : ctx.projectName);
        if (m.name) nameToKey.set(`${m.ecosystem}:${m.name}`, key);
        const ent: EntityObservation = {
          key,
          kind: 'package',
          canonicalName: `${m.ecosystem}:${m.name ?? (dir || '.')}`,
          displayName: display,
          ownerKey: ownerOf(dir),
          attributes: { ...m.attributes, directory: dir || '.', named: Boolean(m.name) },
          evidence: [evidenceAt(m, m.nameLine)],
        };
        out.entities.push(ent);
        out.relations.push({
          fromKey: ent.ownerKey!,
          toKey: key,
          kind: 'contains',
          confidence: 'exact',
          resolved: true,
          evidence: [evidenceAt(m, m.nameLine)],
        });
      }
      for (const dir of dirs) {
        const m = byDir.get(dir)!;
        const seen = new Set<string>();
        for (const d of m.deps) {
          const target = nameToKey.get(`${m.ecosystem}:${d.name}`);
          if (target && target !== packageKey(dir) && !seen.has(target)) {
            seen.add(target);
            const rel: RelationObservation = {
              fromKey: packageKey(dir),
              toKey: target,
              kind: 'depends-on',
              confidence: 'resolved',
              resolved: true,
              evidence: [evidenceAt(m, d.line)],
            };
            out.relations.push(rel);
          } else if (!target && d.workspaceProtocol) {
            out.relations.push({
              fromKey: packageKey(dir),
              toKey: `unresolved:${m.ecosystem}:${d.name}`,
              kind: 'depends-on',
              confidence: 'heuristic',
              resolved: false,
              evidence: [evidenceAt(m, d.line)],
            });
          }
        }
      }
      return out;
    },
  };
}
