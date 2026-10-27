import type { ProjectionLike } from './jsoncanvas.ts';

/** A view as a Mermaid flowchart: a simplified, selected view (plan §13), not a full export. */
export function projectionToMermaid(p: ProjectionLike): { text: string; disclosures: string[] } {
  const ids = new Map(p.nodes.map((n, i) => [n.id, `n${i}`]));
  const q = (s: string) =>
    `"${s
      .replace(/"/g, '#quot;')
      .replace(/[<>]/g, (c) => (c === '<' ? '#lt;' : '#gt;'))
      .slice(0, 120)}"`;
  const lines = [
    `%% ${p.title} (${p.lens}) — exported from System Atlas, snapshot ${p.snapshotId}`,
    'flowchart LR',
  ];
  const groups = p.nodes.filter((n) => n.kind === 'group');
  const leaf = (n: ProjectionLike['nodes'][number]) => {
    const label = [
      n.label,
      n.entityKind ?? n.kind,
      n.lifecycle && n.lifecycle !== 'active' ? n.lifecycle : '',
      n.change ?? '',
    ]
      .filter(Boolean)
      .join(' · ');
    return n.kind === 'gap'
      ? `  ${ids.get(n.id)}{{${q(label)}}}`
      : `  ${ids.get(n.id)}[${q(label)}]`;
  };
  for (const g of groups) {
    lines.push(`  subgraph ${ids.get(g.id)}[${q(g.label)}]`);
    for (const n of p.nodes.filter((x) => x.parentId === g.id && x.kind !== 'group'))
      lines.push(`  ${leaf(n)}`);
    lines.push('  end');
  }
  for (const n of p.nodes.filter(
    (x) => x.kind !== 'group' && !groups.some((g) => g.id === x.parentId),
  ))
    lines.push(leaf(n));
  for (const e of p.edges) {
    const a = ids.get(e.source);
    const b = ids.get(e.target);
    if (!a || !b) continue;
    const label =
      Object.keys(e.kinds).sort().join(', ') + (e.status === 'supported' ? '' : ` (${e.status})`);
    lines.push(`  ${a} ${e.status === 'supported' ? '-->' : '-.->'}|${q(label)}| ${b}`);
  }
  return {
    text: lines.join('\n') + '\n',
    disclosures: [
      'Mermaid export is a simplified, selected view: no evidence, no positions, no drill-down links, no notes; inferred and stale edges are dotted and labeled.',
    ],
  };
}
