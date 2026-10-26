import { parse as parseYaml } from 'yaml';
import type { EntityKind } from '@atlas/schema';
import type { Analyzer, AnalyzerOutput, EvidenceRef, InventoryFile } from '../types.ts';
import { baseName, dirOf, manifestDirs, ownerKeyFor } from '../shared/packages.ts';

export const DOCKER_ANALYZER_ID = 'generic-docker';
export const DOCKER_ANALYZER_VERSION = '0.1.0';

const DB_IMAGES =
  /^(postgres|postgis|mysql|mariadb|mongo|mongodb|cockroach|clickhouse|cassandra|scylla|mssql|sqlserver|couchdb|neo4j|influxdb|timescale)/i;
const INFRA_IMAGES =
  /^(redis|valkey|rabbitmq|kafka|confluentinc|bitnami\/kafka|nats|memcached|localstack|minio|elasticsearch|opensearch|zookeeper|mailhog|mailpit|jaeger|otel|prometheus|grafana|nginx|traefik|caddy|keycloak)/i;

const isCompose = (p: string) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(baseName(p));
const isDockerfile = (f: InventoryFile) => f.language === 'dockerfile';

function join(dir: string, rel: string): string {
  const out: string[] = [];
  for (const p of (dir ? `${dir}/${rel}` : rel).split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function imageName(image: string): string {
  return image
    .split('@')[0]!
    .split(':')[0]!
    .replace(/^docker\.io\//, '')
    .replace(/^library\//, '');
}

function lineOf(lines: string[], re: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return i + 1;
  return from + 1;
}

/**
 * Docker Compose services and Dockerfiles. Reads files only; never builds or runs containers.
 */
export function createDockerAnalyzer(): Analyzer {
  return {
    id: DOCKER_ANALYZER_ID,
    version: DOCKER_ANALYZER_VERSION,
    async detect(ctx) {
      return ctx.files.some((f) => isCompose(f.path) || isDockerfile(f));
    },
    capabilities() {
      return {
        languages: ['dockerfile', 'docker-compose'],
        entityKinds: ['deployable', 'database', 'infrastructure-resource', 'entrypoint'],
        relationKinds: ['depends-on', 'calls'],
        limitations: [
          'Compose: services, build contexts, depends_on and service-name hosts in environment URLs. Profiles, extends and variable interpolation are not evaluated.',
          'Image-only services are classified by image name (databases, brokers, proxies); unknown images stay generic deployables.',
          'Dockerfile CMD/ENTRYPOINT arguments are mapped to source files by path relative to the build context; shell scripts and package-manager commands are not followed.',
        ],
      };
    },
    affectedBy(changes) {
      return [...changes.added, ...changes.modified, ...changes.deleted].filter(
        (p) => isCompose(p) || /(^|\/)(Dockerfile|Containerfile)[^/]*$/.test(p),
      );
    },
    async extract(files, ctx): Promise<AnalyzerOutput> {
      const out: AnalyzerOutput = { entities: [], relations: [], diagnostics: [], handled: [] };
      const dirs = manifestDirs(files);
      const paths = new Set(files.map((f) => f.path));
      const hash = new Map(files.map((f) => [f.path, f.sha256]));
      /** Dockerfile path -> { compose service key, build context dir } */
      const builtBy = new Map<string, { service: string; context: string }>();

      for (const f of files.filter((x) => isCompose(x.path))) {
        const text = await ctx.readFile(f.path);
        out.handled.push({ path: f.path, support: 'syntax' });
        const lines = text.split('\n');
        let doc: { services?: Record<string, Record<string, unknown>> };
        try {
          doc = (parseYaml(text) ?? {}) as typeof doc;
        } catch (e) {
          out.diagnostics.push({
            severity: 'warning',
            code: 'compose-parse-failed',
            message: (e as Error).message.slice(0, 200),
            path: f.path,
          });
          continue;
        }
        const services = doc.services ?? {};
        const names = Object.keys(services);
        const base = dirOf(f.path);
        for (const name of names) {
          const svc = services[name] ?? {};
          const svcLine = lineOf(
            lines,
            new RegExp(`^\\s{1,4}${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}:\\s*$`),
          );
          const ev = (line = svcLine): EvidenceRef => ({
            path: f.path,
            contentHash: f.sha256,
            startLine: line,
            endLine: line,
            excerpt: lines[line - 1]?.trim().slice(0, 300),
          });
          const image = typeof svc.image === 'string' ? imageName(svc.image) : undefined;
          let kind: EntityKind = 'deployable';
          if (!svc.build && image && DB_IMAGES.test(image)) kind = 'database';
          else if (!svc.build && image && INFRA_IMAGES.test(image))
            kind = 'infrastructure-resource';
          const key = `compose:${name}`;
          out.entities.push({
            key,
            kind,
            canonicalName: `compose:${name}`,
            displayName: name,
            ownerKey: ownerKeyFor(f.path, dirs),
            attributes: { image: image ?? null, composeFile: f.path, build: !!svc.build },
            evidence: [ev()],
          });

          const build = svc.build;
          if (build) {
            const ctxDir = join(
              base,
              typeof build === 'string'
                ? build
                : String((build as Record<string, unknown>).context ?? '.'),
            );
            const df = join(
              ctxDir,
              typeof build === 'object' && (build as Record<string, unknown>).dockerfile
                ? String((build as Record<string, unknown>).dockerfile)
                : 'Dockerfile',
            );
            if (paths.has(df)) builtBy.set(df, { service: key, context: ctxDir });
          }
          const deps = Array.isArray(svc.depends_on)
            ? svc.depends_on
            : svc.depends_on && typeof svc.depends_on === 'object'
              ? Object.keys(svc.depends_on)
              : [];
          const linked = new Set<string>();
          for (const d of deps.map(String)) {
            if (!names.includes(d)) continue;
            linked.add(d);
            out.relations.push({
              fromKey: key,
              toKey: `compose:${d}`,
              kind: 'depends-on',
              qualifiers: { via: 'depends_on' },
              confidence: 'exact',
              resolved: true,
              evidence: [ev(lineOf(lines, new RegExp(`\\b${d}\\b`), svcLine))],
            });
          }
          const env = svc.environment;
          const values = Array.isArray(env)
            ? env.map(String)
            : env && typeof env === 'object'
              ? Object.values(env).map(String)
              : [];
          for (const v of values) {
            for (const other of names) {
              if (other === name || linked.has(other)) continue;
              if (new RegExp(`(//|@)${other}(:\\d+|/|$)`).test(v)) {
                linked.add(other);
                out.relations.push({
                  fromKey: key,
                  toKey: `compose:${other}`,
                  kind: 'depends-on',
                  qualifiers: { via: 'environment' },
                  confidence: 'heuristic',
                  resolved: true,
                  evidence: [ev(lineOf(lines, new RegExp(`${other}`), svcLine))],
                });
              }
            }
          }
        }
      }

      for (const f of files.filter(isDockerfile)) {
        const text = await ctx.readFile(f.path);
        out.handled.push({ path: f.path, support: 'syntax' });
        const lines = text.split('\n');
        const key = `entry:docker:${f.path}`;
        const owner = builtBy.get(f.path);
        const from = lines
          .find((l) => /^\s*FROM\s+/i.test(l))
          ?.trim()
          .split(/\s+/)[1];
        const cmdIdx = lines
          .map((l, i) => [l, i] as const)
          .filter(([l]) => /^\s*(CMD|ENTRYPOINT)\b/i.test(l))
          .map(([, i]) => i);
        const ev = (line: number): EvidenceRef => ({
          path: f.path,
          contentHash: hash.get(f.path)!,
          startLine: line,
          endLine: line,
          excerpt: lines[line - 1]?.trim().slice(0, 300),
        });
        out.entities.push({
          key,
          kind: 'entrypoint',
          canonicalName: `docker:${f.path}`,
          displayName: `${baseName(dirOf(f.path)) || 'root'} container`,
          ownerKey: owner?.service ?? ownerKeyFor(f.path, dirs),
          attributes: { baseImage: from ?? null, dockerfile: f.path },
          evidence: [ev(cmdIdx.at(-1) !== undefined ? cmdIdx.at(-1)! + 1 : 1)],
        });
        for (const i of cmdIdx) {
          const raw = lines[i]!.replace(/^\s*(CMD|ENTRYPOINT)\s+/i, '');
          let args: string[];
          try {
            args = raw.trim().startsWith('[')
              ? (JSON.parse(raw) as string[])
              : raw.trim().split(/\s+/);
          } catch {
            args = raw.trim().split(/\s+/);
          }
          const context = owner?.context ?? dirOf(f.path);
          for (const a of args) {
            if (!/\.(m|c)?[jt]sx?$|\.py$/.test(a)) continue;
            const candidates = [
              join(context, a),
              join(dirOf(f.path), a),
              a.replace(/^\/?(app|usr\/src\/app|srv|code)\//, ''),
            ];
            const hit = candidates.find((c) => paths.has(c));
            const toKey = hit
              ? hit.endsWith('.py')
                ? `py:module:${hit}`
                : `ts:module:${hit}`
              : `unresolved:${a}`;
            out.relations.push({
              fromKey: key,
              toKey,
              kind: 'calls',
              confidence: 'resolved',
              resolved: !!hit,
              evidence: [ev(i + 1)],
            });
          }
        }
      }
      return out;
    },
  };
}
