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
const MERMAID_ENTITY: Record<string, string> = {
  '#': '#35;',
  ';': '#59;',
  ':': '#58;',
  '"': '#quot;',
  '<': '#lt;',
  '>': '#gt;',
};
/** One pass, so an entity's own `#` and `;` are never escaped again. */
const mermaidText = (s: string, max = 160) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[#;:"<>]/g, (c) => MERMAID_ENTITY[c]!);

const live = <T extends { status: string }>(xs: T[]) => xs.filter((x) => x.status !== 'rejected');

/** "A → B · payload" for pickers, chips and tables. */
export function connectionTitle(doc: BoardDocument, k: Connection): string {
  const a = doc.components[k.from]?.label ?? k.from;
  const b = doc.components[k.to]?.label ?? k.to;
  const what = k.payload ?? k.label;
  return `${a} → ${b}${what ? ` · ${what}` : ''}`;
}

type Step = Scenario['steps'][number];

/** The components a step touches: both ends of its hop, or the component it happens in. */
function stepEnds(doc: BoardDocument, s: Step): string[] {
  const k = s.connectionId ? doc.connections[s.connectionId] : undefined;
  if (k) return [k.from, k.to];
  return s.componentId && doc.components[s.componentId] ? [s.componentId] : [];
}

/**
 * Steps of a scenario that the flow cannot have reached (D04): a step is connected when it touches
 * a component an earlier step already reached. A request may fan out and return, so a step need not
 * start where the previous one ended; it only may not start somewhere the flow has never been. The
 * first bound step seeds the flow, and unbound steps (no hop, no component) are never gaps.
 */
export function scenarioGaps(doc: BoardDocument, scenario: Scenario): Set<string> {
  const reached = new Set<string>();
  const gaps = new Set<string>();
  for (const s of scenario.steps) {
    const ends = stepEnds(doc, s);
    if (!ends.length) continue;
    if (reached.size && !ends.some((id) => reached.has(id))) gaps.add(s.id);
    for (const id of ends) reached.add(id);
  }
  return gaps;
}

/**
 * The connections that would join a gap step to the flow before it (D04): the shortest chain of
 * connections from where the previous step ended (else from any component reached so far) to the
 * nearest end of the step, ignoring direction. Deterministic: connections are tried in id order.
 * Empty when the step is not a gap or the board has no such chain.
 */
export function missingHops(doc: BoardDocument, scenario: Scenario, stepId: string): string[] {
  const reached: string[] = [];
  let last: string[] = [];
  let target: string[] | undefined;
  for (const s of scenario.steps) {
    const ends = stepEnds(doc, s);
    if (s.id === stepId) {
      target = ends;
      break;
    }
    if (!ends.length) continue;
    for (const id of ends) if (!reached.includes(id)) reached.push(id);
    last = [ends[ends.length - 1]!];
  }
  if (!target?.length || !reached.length || target.some((id) => reached.includes(id))) return [];
  const conns = Object.values(doc.connections)
    .filter((k) => k.status !== 'rejected' && doc.components[k.from] && doc.components[k.to])
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const search = (from: string[]): string[] | undefined => {
    const via = new Map<string, { prev: string; conn: string } | null>(
      from.map((id) => [id, null]),
    );
    const queue = [...from];
    while (queue.length) {
      const at = queue.shift()!;
      if (target!.includes(at)) {
        const path: string[] = [];
        for (let v = via.get(at); v; v = via.get(v.prev)) path.unshift(v.conn);
        return path;
      }
      for (const k of conns) {
        const next = k.from === at ? k.to : k.to === at ? k.from : undefined;
        if (next === undefined || via.has(next)) continue;
        via.set(next, { prev: at, conn: k.id });
        queue.push(next);
      }
    }
    return undefined;
  };
  return search(last) ?? search(reached) ?? [];
}

/** The flow a step drills into: the internals board's document and the scenario on it. */
export type DrillResolver = (drill: {
  boardId: string;
  scenarioId: string;
}) => { doc: BoardDocument; scenario: Scenario; boardName?: string } | undefined;

/** Sub-flows are drawn this many levels deep (boards nest two levels below their root). */
const MAX_DRILL_DEPTH = 2;

/**
 * A scenario as a Mermaid `sequenceDiagram`: participants are the components in order of first
 * appearance, each connection step a message (async hops use the open arrow), each component-only
 * step a note over that component. Steps are numbered by `autonumber`.
 *
 * With `resolve`, a step that drills into an internals board (D04) is followed by a shaded block
 * holding that board's flow: the hops that touch its own boxes. Those boxes join as participants;
 * an "outside: X" stub of the internals board is the participant X of the board above, so the
 * block joins up with the rest and nothing is told twice.
 */
export function scenarioToMermaid(
  doc: BoardDocument,
  scenario: Scenario,
  resolve?: DrillResolver,
): string {
  /** participant key -> label, in order of first appearance */
  const people = new Map<string, string>();
  const body: string[] = [];
  const alias = (key: string) => `p${[...people.keys()].indexOf(key) + 1}`;

  /** Maps a component of one board to its participant. */
  type Who = (id: string | undefined) => string | undefined;
  const STUB = /^outside: /;
  const walk = (
    d: BoardDocument,
    sc: Scenario,
    scope: string,
    depth: number,
    open: Set<string>,
    /** The board above: its document and its own mapping (absent for the board being drawn). */
    above?: { doc: BoardDocument; who: Who },
  ): void => {
    const isStub = (id: string | undefined) =>
      !!above && !!id && STUB.test(d.components[id]?.label ?? '');
    /**
     * Participant of a component of this board. An "outside: X" stub of an internals board is the
     * box X of the board above (which may itself be a stub of the board above that), whether or
     * not X has appeared in the diagram yet.
     */
    const who: Who = (id) => {
      const c = id ? d.components[id] : undefined;
      if (!c) return undefined;
      if (above && STUB.test(c.label)) {
        const name = c.label.replace(STUB, '');
        const same = Object.values(above.doc.components)
          .filter((x) => x.status !== 'rejected' && x.label.replace(STUB, '') === name)
          .sort((x, y) => (x.id < y.id ? -1 : 1))[0];
        const up = same ? above.who(same.id) : undefined;
        if (up) return up;
      }
      const key = `${scope}${c.id}`;
      if (!people.has(key)) people.set(key, c.label.replace(STUB, ''));
      return key;
    };
    const pad = '  '.repeat(depth + 1);
    for (const s of sc.steps) {
      const k = s.connectionId ? d.connections[s.connectionId] : undefined;
      // inside a block, only what touches this board's own boxes: what happens between two
      // outside boxes, or in one, is told by the board above
      const outside = k ? isStub(k.from) && isStub(k.to) : isStub(s.componentId);
      const from = k && !outside ? who(k.from) : undefined;
      const to = k && !outside ? who(k.to) : undefined;
      const at = k || outside ? undefined : who(s.componentId);
      if (k && from && to) {
        const what = k.payload ?? k.label ?? s.text;
        const msg = [what, k.protocol ? `(${k.protocol})` : ''].filter(Boolean).join(' ');
        const arrow = k.mode === 'async' ? '-)' : '->>';
        body.push(`${pad}${alias(from)}${arrow}${alias(to)}: ${mermaidText(msg || 'step')}`);
      } else if (at) {
        body.push(`${pad}Note over ${alias(at)}: ${mermaidText(s.text || 'step')}`);
      } else continue;
      const drill = s.drillInto;
      const key = drill && `${drill.boardId}/${drill.scenarioId}`;
      if (!drill || !resolve || depth >= MAX_DRILL_DEPTH || open.has(key!)) continue;
      const sub = resolve(drill);
      if (!sub?.scenario.steps.length) continue;
      // the box the step passes through: where it happens, else the box its hop enters
      const through = at ?? to!;
      body.push(
        `${pad}rect rgb(238, 242, 255)`,
        `${pad}  Note over ${alias(through)}: ${mermaidText(`Inside ${people.get(through)}${sub.boardName ? ` (${sub.boardName})` : ''}`)}`,
      );
      walk(sub.doc, sub.scenario, `${drill.boardId}:`, depth + 1, new Set([...open, key!]), {
        doc: d,
        who,
      });
      body.push(`${pad}end`);
    }
  };
  walk(doc, scenario, '', 0, new Set());
  const lines = ['sequenceDiagram', `  title ${mermaidText(scenario.name, 120)}`, '  autonumber'];
  for (const [key, label] of people)
    lines.push(`  participant ${alias(key)} as ${mermaidText(label, 80)}`);
  return [...lines, ...body].join('\n');
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
  /** Looks up the internals board a step drills into, to draw its flow inside the diagram. */
  resolveDrill?: DrillResolver;
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
        const below = st.drillInto ? opts.resolveDrill?.(st.drillInto) : undefined;
        out.push(
          `${i + 1}. ${st.text.trim() || '(no text)'}${where ? ` — _${where}_` : ''}` +
            (below ? ` (continues in “${below.boardName ?? below.scenario.name}”)` : ''),
        );
      });
      const gaps = scenarioGaps(doc, s);
      if (gaps.size) {
        const at = s.steps.flatMap((st, i) => (gaps.has(st.id) ? [i + 1] : []));
        out.push(
          '',
          `_Gap: step ${at.join(', ')} starts at a component the flow has not reached._`,
        );
      }
      if (s.steps.length)
        out.push('', '```mermaid', scenarioToMermaid(doc, s, opts.resolveDrill), '```');
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
