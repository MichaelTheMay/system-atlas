import { describe, expect, it } from 'vitest';
import { extractGo, extractJava } from '../src/index.ts';

const f = (path: string, text: string, role = 'source') => ({
  path,
  text,
  sha256: 'a'.repeat(64),
  role,
});
const rels = (
  o: { relations: { kind: string; fromKey: string; toKey: string; confidence: string }[] },
  kind: string,
) =>
  o.relations
    .filter((r) => r.kind === kind)
    .map((r) => `${r.fromKey} -> ${r.toKey} (${r.confidence})`);

describe('Go extraction', () => {
  it('handles method patterns, gin routes, router mounts, unknown third-party imports and nested modules', async () => {
    const o = await extractGo({
      gomods: [
        {
          path: 'svc/go.mod',
          text: 'module example.com/svc\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
        },
      ],
      manifestDirs: ['svc'],
      files: [
        f(
          'svc/web/web.go',
          'package web\nimport (\n "net/http"\n "github.com/gin-gonic/gin"\n "golang.org/x/sync/errgroup"\n "example.com/svc/util"\n)\nfunc Routes(g *gin.Engine, m *http.ServeMux, sub http.Handler) {\n g.GET("/users/:id", nil)\n g.POST("/users", nil)\n m.HandleFunc("DELETE /users/{id}", nil)\n m.Handle("/", sub)\n m.HandleFunc("/static/", nil)\n _ = errgroup.Group{}\n}\n',
        ),
        f('svc/util/util.go', 'package util\nfunc helper() {}\nvar Version = "1"\n'),
        f(
          'svc/util/util_test.go',
          'package util\nimport "testing"\nfunc TestX(t *testing.T) {}\n',
          'test',
        ),
      ],
    });
    expect(
      o.entities
        .filter((e) => e.kind === 'endpoint')
        .map((e) => e.key)
        .sort(),
    ).toEqual([
      'endpoint:svc:ANY /static/',
      'endpoint:svc:DELETE /users/{id}',
      'endpoint:svc:GET /users/:id',
      'endpoint:svc:POST /users',
    ]);
    expect(rels(o, 'imports')).toEqual([
      'go:module:svc/web -> ext:go:github.com/gin-gonic/gin (exact)',
      'go:module:svc/web -> ext:go:golang.org/x/sync (heuristic)',
      'go:module:svc/web -> go:module:svc/util (resolved)',
    ]);
    expect(
      o.entities
        .filter((e) => e.kind === 'symbol')
        .map((e) => e.displayName)
        .sort(),
    ).toEqual(['Routes', 'Version']);
    expect(o.entities.find((e) => e.key === 'go:module:svc/util')?.attributes).toMatchObject({
      importPath: 'example.com/svc/util',
      files: 2,
      test: false,
    });
  });
});

describe('Java extraction', () => {
  it('resolves wildcard and static imports, JAX-RS routes, @Query SQL and interface methods', async () => {
    const o = await extractJava({
      builds: [
        {
          path: 'build.gradle',
          text: "dependencies { implementation 'jakarta.ws.rs:jakarta.ws.rs-api:3.1.0' }",
        },
      ],
      manifestDirs: [''],
      files: [
        f(
          'src/a/Api.java',
          'package a;\nimport b.*;\nimport static b.Util.helper;\nimport jakarta.ws.rs.*;\nimport java.util.List;\n@Path("/v1")\npublic class Api {\n  @GET @Path("things/{id}") public String one() { return helper(); }\n  @POST public void make() {}\n}\n',
        ),
        f(
          'src/b/Util.java',
          'package b;\npublic final class Util { public static String helper() { return ""; } }\n',
        ),
        f(
          'src/b/Repo.java',
          'package b;\npublic interface Repo {\n  @Query(value = "SELECT * FROM things WHERE id = ?1", nativeQuery = true)\n  String byId(String id);\n}\n',
        ),
      ],
    });
    expect(
      o.entities
        .filter((e) => e.kind === 'endpoint')
        .map((e) => e.key)
        .sort(),
    ).toEqual(['endpoint:.:GET /v1/things/{id}', 'endpoint:.:POST /v1']);
    expect(rels(o, 'imports').sort()).toEqual([
      'java:module:src/a/Api.java -> ext:maven:jakarta.ws.rs (exact)',
      'java:module:src/a/Api.java -> java:module:src/b/Repo.java (resolved)',
      'java:module:src/a/Api.java -> java:module:src/b/Util.java (resolved)',
    ]);
    expect(rels(o, 'reads')).toEqual(['java:module:src/b/Repo.java -> table:things (heuristic)']);
    expect(o.entities.some((e) => e.key === 'java:symbol:src/b/Repo.java#Repo.byId')).toBe(true);
  });
});
