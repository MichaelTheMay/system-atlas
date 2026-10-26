/**
 * Server-side rendered, script-free viewers for text-like artifacts, served only from the isolated
 * preview origin. All content is HTML-escaped; the page has no scripts and a sandbox CSP.
 */
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const STYLE = `body{margin:0;font:12.5px ui-monospace,Menlo,monospace;color:#1c2330;background:#fff}
.meta{font:12px system-ui,sans-serif;color:#5d6675;padding:6px 10px;border-bottom:1px solid #e2e5ea;background:#f6f7f9}
pre{margin:0;padding:8px 10px;white-space:pre-wrap;word-break:break-word}
.ln{color:#9aa3b2;user-select:none;display:inline-block;width:42px;text-align:right;margin-right:10px}
table{border-collapse:collapse;font:12px system-ui,sans-serif;margin:8px}td,th{border:1px solid #e2e5ea;padding:3px 7px;text-align:left}th{background:#f6f7f9}
.k{color:#5b6bd6}.s{color:#1f7a4d}.n{color:#8a5a00}.b{color:#9a3fb0}`;

export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

export function renderViewer(
  mediaType: string,
  name: string,
  bytes: Buffer,
  truncated: boolean,
): string {
  const text = bytes.toString('utf8');
  let body: string;
  if (mediaType === 'application/json') {
    try {
      body = `<pre>${highlightJson(JSON.stringify(JSON.parse(text), null, 2))}</pre>`;
    } catch {
      body = numbered(text);
    }
  } else if (mediaType === 'text/csv') {
    const rows = parseCsv(text).slice(0, 201);
    const [head, ...rest] = rows;
    body = `<table><thead><tr>${(head ?? []).map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length > 200 ? '<div class="meta">first 200 rows</div>' : ''}`;
  } else {
    body = numbered(text);
  }
  return `<!doctype html><meta charset="utf-8"><title>${esc(name)}</title><style>${STYLE}</style><div class="meta">${esc(name)} · ${esc(mediaType)}${truncated ? ` · showing the first ${MAX_VIEW_BYTES / 1024 / 1024} MiB` : ''}</div>${body}`;
}

function numbered(text: string): string {
  const lines = text.split('\n');
  return `<pre>${lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')}</pre>`;
}

function highlightJson(pretty: string): string {
  return esc(pretty).replace(
    /(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, lit, num) => {
      if (str)
        return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
      if (lit) return `<span class="b">${lit}</span>`;
      if (num) return `<span class="n">${num}</span>`;
      return m;
    },
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length && rows.length <= 200; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}
