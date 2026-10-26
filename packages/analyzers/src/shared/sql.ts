/**
 * Table references in SQL text (string literals in code, migration files). Syntax-level only:
 * no SQL parser, no schema resolution. Callers label code-level results as heuristic.
 */
const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*))?`;

export function normalizeTable(raw: string): string {
  const last = raw.split('.').pop()!.trim();
  return last.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
}

const SQL_START = /^\s*(with|select|insert|update|delete|merge|replace|upsert)\b/i;

export function looksLikeSql(text: string): boolean {
  return SQL_START.test(text) && /\b(from|into|update|set|values|where)\b/i.test(text);
}

export function sqlTableRefs(sql: string): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const text = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  for (const m of text.matchAll(
    new RegExp(
      String.raw`\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|merge\s+into)\s+(${IDENT})`,
      'gi',
    ),
  ))
    writes.add(normalizeTable(m[1]!));
  for (const m of text.matchAll(
    new RegExp(String.raw`\bupdate\s+(?:only\s+)?(${IDENT})\s+set\b`, 'gi'),
  ))
    writes.add(normalizeTable(m[1]!));
  for (const m of text.matchAll(new RegExp(String.raw`\bdelete\s+from\s+(${IDENT})`, 'gi')))
    writes.add(normalizeTable(m[1]!));
  const withoutDeletes = text.replace(
    new RegExp(String.raw`\bdelete\s+from\s+${IDENT}`, 'gi'),
    ' ',
  );
  for (const m of withoutDeletes.matchAll(
    new RegExp(String.raw`\b(?:from|join)\s+(${IDENT})`, 'gi'),
  )) {
    const t = normalizeTable(m[1]!);
    if (!['select', 'lateral', 'unnest', 'generate_series', 'json_each', 'dual'].includes(t))
      reads.add(t);
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

/** CREATE TABLE statements and their REFERENCES targets (migrations / schema files). */
export function sqlCreatedTables(
  sql: string,
): { name: string; line: number; references: string[] }[] {
  const out: { name: string; line: number; references: string[] }[] = [];
  const text = sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  const re = new RegExp(
    String.raw`\bcreate\s+(?:temporary\s+|temp\s+|unlogged\s+|virtual\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENT})\s*(?:using\s+\w+\s*)?\(`,
    'gi',
  );
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    const body = text.slice(start, i - 1);
    const references = [
      ...body.matchAll(new RegExp(String.raw`\breferences\s+(${IDENT})`, 'gi')),
    ].map((r) => normalizeTable(r[1]!));
    out.push({
      name: normalizeTable(m[1]!),
      line: text.slice(0, m.index!).split('\n').length,
      references: [...new Set(references)],
    });
  }
  return out;
}
