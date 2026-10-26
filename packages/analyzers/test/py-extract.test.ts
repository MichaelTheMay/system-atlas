import { describe, expect, it } from 'vitest';
import { extractPython } from '../src/index.ts';

const file = (path: string, text: string) => ({
  path,
  text,
  sha256: 'b'.repeat(64),
  role: 'source',
});

describe('extractPython', () => {
  it('resolves relative and absolute project imports, skips stdlib, records third-party and unresolved', async () => {
    const o = await extractPython({
      files: [
        file('app/__init__.py', ''),
        file('app/core/__init__.py', 'from .models import Model\n'),
        file(
          'app/core/models.py',
          'import os\nimport requests\nfrom ..util import helper\nfrom app.missing import nothing\n\nclass Model: pass\n_private = 1\ndef _hidden(): pass\n',
        ),
        file('app/util.py', 'def helper(): pass\n'),
      ],
      pyprojects: [],
      manifestDirs: [],
    });
    const imports = o.relations
      .filter((r) => r.kind === 'imports')
      .map((r) => `${r.fromKey} -> ${r.toKey}`);
    expect(imports).toEqual([
      'py:module:app/core/__init__.py -> py:module:app/core/models.py',
      'py:module:app/core/models.py -> ext:pypi:requests',
      'py:module:app/core/models.py -> py:module:app/util.py',
      'py:module:app/core/models.py -> unresolved:app.missing',
    ]);
    expect(o.entities.filter((e) => e.kind === 'symbol').map((e) => e.key)).toEqual([
      'py:symbol:app/core/models.py#Model',
      'py:symbol:app/util.py#helper',
    ]);
  });

  it('detects Flask routes with methods and APIRouter prefixes', async () => {
    const o = await extractPython({
      files: [
        file(
          'svc/web.py',
          'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/items", methods=["GET", "POST"])\ndef items(): pass\n',
        ),
        file(
          'svc/api.py',
          'from fastapi import APIRouter\nrouter = APIRouter(prefix="/v1")\n\n@router.delete("/items/{id}")\ndef rm(id: int): pass\n',
        ),
      ],
      pyprojects: [],
      manifestDirs: [],
    });
    expect(
      o.entities
        .filter((e) => e.kind === 'endpoint')
        .map((e) => e.key)
        .sort(),
    ).toEqual([
      'endpoint:.:DELETE /v1/items/{id}',
      'endpoint:.:GET /items',
      'endpoint:.:POST /items',
    ]);
    expect(
      o.relations.filter((r) => r.kind === 'exposes').every((r) => r.confidence === 'resolved'),
    ).toBe(true);
  });
});
