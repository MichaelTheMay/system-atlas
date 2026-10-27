import {
  componentTypeInfo,
  DOC_SECTION_LABEL,
  DocSection,
  type BoardDocument,
  type Component,
  type Connection,
  type Scenario,
} from '@atlas/schema';

/**
 * Design board exports (D03): a scenario as a Mermaid sequence diagram, and a whole board as a
 * Markdown design doc. Shared by the web export menu and the daemon's
 * `GET /boards/:id/export/markdown` so both produce the same text. Pure functions of the board
 * document: nothing here reads code facts. Rejected items are left out; agent proposals not yet
 * accepted are marked "(proposed)".
 */

/** Mermaid text cannot carry `;` (statement end), `#` (entity start) or `:` in message text. */
const mermaidText = (s: string, max = 160) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/#/g, '#35;')
    .replace(/;/g, '#59;')
    .replace(/:/g, '#58;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');

const live = <T extends { status: string }>(xs: T[]) => xs.filter((x) => x.status !== 'rejected');

/** "A → B · payload" for pickers, chips and tables. */
export function connectionTitle(doc: BoardDocument, k: Connection): string {
  const a = doc.components[k.from]?.label ?? k.from;
  const b = doc.components[k.to]?.label ?? k.to;
  const what = k.payload ?? k.label;
  return `${a} → ${b}${what ? ` · ${what}` : ''}`;
}

/**
 * A scenario as a Mermaid `sequenceDiagram`: participants are the components in order of first
 * appearance, each connection step a message (async hops use the open arrow), each component-only
 * step a note over that component. Steps are numbered by `autonumber`, matching the canvas numbers.
 */
export function scenarioToMermaid(doc: BoardDocument, scenario: Scenario): string {
  const order: string[] = [];
  const seen = (id: string | undefined) => {
    if (id && doc.components[id] && !order.includes(id)) order.push(id);
  };
  for (const s of scenario.steps) {
    const k = s.connectionId ? doc.connections[s.connectionId] : undefined;
    if (k) {
      seen(k.from);
      seen(k.to);
    } else seen(s.componentId);
  }
  const alias = (id: string) => `p${order.indexOf(id) + 1}`;
  const lines = ['sequenceDiagram', `  title ${mermaidText(scenario.name, 120)}`, '  autonumber'];
  for (const id of order)
    lines.push(`  participant ${alias(id)} as ${mermaidText(doc.components[id]!.label, 80)}`);
  for (const s of scenario.steps) {
    const k = s.connectionId ? doc.connections[s.connectionId] : undefined;
    if (k && doc.components[k.from] && doc.components[k.to]) {
      const what = k.payload ?? k.label ?? s.text;
      const msg = [what, k.protocol ? `(${k.protocol})` : ''].filter(Boolean).join(' ');
      const arrow = k.mode === 'async' ? '-)' : '->>';
      lines.push(`  ${alias(k.from)}${arrow}${alias(k.to)}: ${mermaidText(msg || 'step')}`);
    } else if (s.componentId && doc.components[s.componentId]) {
      lines.push(`  Note over ${alias(s.componentId)}: ${mermaidText(s.text || 'step')}`);
    }
  }
  return lines.join('\n');
}

const cell = (s: string | undefined) =>
  (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim() || '—';
const proposed = (x: { status: string }) => (x.status === 'proposed' ? ' _(proposed)_' : '');

function propsText(c: Component): string {
  return Object.entries(c.props)
    .map(([k, v]) => {
      const f = componentTypeInfo(c.type).properties.find((p) => p.key === k);
      return `${f?.label ?? k}: ${String(v)}${f?.hint && typeof v === 'number' ? ` ${f.hint}` : ''}`;
    })
    .join(', ');
}

export interface BoardMarkdownOptions {
  /** Relative path of a PNG of the board shipped next to the Markdown (web export). */
  imagePath?: string;
  /** ISO timestamp printed in the header; defaults to now. */
  generatedAt?: string;
}

/** A board as a Markdown design doc: summary, components, connections, scenarios, doc sections. */
export function boardToMarkdown(
  board: { name: string; document: BoardDocument; source?: string },
  opts: BoardMarkdownOptions = {},
): string {
  const doc = board.document;
  const comps = live(Object.values(doc.components));
  const conns = live(Object.values(doc.connections));
  const out: string[] = [`# ${board.name}`, ''];
  out.push(
    `_Design board exported from System Atlas on ${(opts.generatedAt ?? new Date().toISOString()).slice(0, 10)}. ` +
      'A design-first sketch of how the system should work — not a statement about the code._',
    '',
  );
  if (doc.doc.summary?.trim()) out.push(doc.doc.summary.trim(), '');
  if (opts.imagePath) out.push(`![${board.name}](${opts.imagePath})`, '');

  out.push('## Components', '');
  if (comps.length) {
    out.push('| Component | Type | Properties | Responsibility |', '| --- | --- | --- | --- |');
    for (const c of comps)
      out.push(
        `| ${cell(c.label)}${proposed(c)}${c.origin.author === 'code' ? ' _(as built)_' : ''} | ${cell(componentTypeInfo(c.type).label)} | ${cell(propsText(c))} | ${cell(c.responsibility)} |`,
      );
  } else out.push('_No components yet._');
  out.push('');

  out.push('## Connections', '');
  if (conns.length) {
    out.push(
      '| From | To | Protocol | Mode | Direction | Payload | Volume |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const k of conns)
      out.push(
        `| ${cell(doc.components[k.from]?.label ?? k.from)} | ${cell(doc.components[k.to]?.label ?? k.to)}${proposed(k)} | ${cell(k.protocol)} | ${k.mode} | ${k.direction} | ${cell(k.payload ?? k.label)} | ${cell(k.volume)} |`,
      );
  } else out.push('_No connections yet._');
  out.push('');

  const scenarios = live(doc.scenarios);
  if (scenarios.length) {
    out.push('## Scenarios', '');
    for (const s of scenarios) {
      out.push(`### ${s.name}${proposed(s)}`, '');
      if (s.description?.trim()) out.push(s.description.trim(), '');
      s.steps.forEach((st, i) => {
        const k = st.connectionId ? doc.connections[st.connectionId] : undefined;
        const where = k
          ? connectionTitle(doc, k)
          : st.componentId
            ? (doc.components[st.componentId]?.label ?? st.componentId)
            : '';
        out.push(`${i + 1}. ${st.text.trim() || '(no text)'}${where ? ` — _${where}_` : ''}`);
      });
      if (s.steps.length) out.push('', '```mermaid', scenarioToMermaid(doc, s), '```');
      out.push('');
    }
  }

  const items = live(doc.doc.items);
  const pinName = (id: string) =>
    doc.components[id]?.label ??
    (doc.connections[id] ? connectionTitle(doc, doc.connections[id]!) : id);
  for (const section of DocSection.options) {
    const xs = items.filter((i) => i.section === section);
    if (!xs.length) continue;
    out.push(`## ${DOC_SECTION_LABEL[section]}`, '');
    for (const i of xs) {
      const pins = i.pins.length ? ` _(${i.pins.map(pinName).join(', ')})_` : '';
      out.push(`- ${i.text.trim().replace(/\r?\n/g, '\n  ')}${pins}${proposed(i)}`);
    }
    out.push('');
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
