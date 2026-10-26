import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

/**
 * Tree-sitter grammars loaded from the wasm files shipped in the grammar npm packages
 * (no native build). Verified loading under web-tree-sitter 0.27.1 on 2026-10-26:
 * typescript/tsx ABI 14, python ABI 15. Syntax only — semantic resolution is separate.
 */
export type GrammarId = 'typescript' | 'tsx' | 'python';

const GRAMMARS: Record<GrammarId, { pkg: string; file: string }> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
};

const require = createRequire(import.meta.url);
let initPromise: Promise<void> | undefined;
const languages = new Map<GrammarId, Promise<Language>>();

export function grammarPath(id: GrammarId): string {
  const g = GRAMMARS[id];
  return join(dirname(require.resolve(`${g.pkg}/package.json`)), g.file);
}

export async function loadLanguage(id: GrammarId): Promise<Language> {
  initPromise ??= Parser.init();
  await initPromise;
  let lang = languages.get(id);
  if (!lang) {
    lang = Language.load(grammarPath(id));
    languages.set(id, lang);
  }
  return lang;
}

export async function createParser(id: GrammarId): Promise<Parser> {
  const language = await loadLanguage(id);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
