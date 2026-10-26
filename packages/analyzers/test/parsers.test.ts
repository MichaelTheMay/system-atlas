import { describe, expect, it } from 'vitest';
import { createParser } from '../src/index.ts';

describe('tree-sitter wasm grammars', () => {
  it.each([
    [
      'typescript',
      'import { a } from "./b";\nexport function f(x: number): string { return String(x); }',
      'program',
    ],
    ['tsx', 'export const C = () => <div>hi</div>;', 'program'],
    ['python', 'from app.db import Session\n\n@app.get("/x")\ndef f():\n    return 1\n', 'module'],
  ] as const)('%s grammar loads and parses without errors', async (id, code, rootType) => {
    const parser = await createParser(id);
    const tree = parser.parse(code);
    expect(tree?.rootNode.type).toBe(rootType);
    expect(tree?.rootNode.hasError).toBe(false);
  });
});
