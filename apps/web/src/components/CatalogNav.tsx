import { useMemo, useState } from 'react';
import type { CatalogDto, CanvasSpecDto } from '../api.ts';
import { ProvenanceBadge } from './design/archetypes.tsx';

const LENS_LABEL: Record<string, string> = {
  'system-context': 'context',
  component: 'component',
  'module-detail': 'module',
  coverage: 'coverage',
  changes: 'changes',
  deployables: 'deploy',
  api: 'api',
  data: 'data',
  workflow: 'workflow',
  'ui-navigation': 'ui',
  'design-system': 'design',
  'design-subsystem': 'subsystem',
};

interface Props {
  catalog: CatalogDto | null;
  /** Workspace whose canvases are listed; canvases without one are architecture views. */
  workspace?: string;
  currentCanvasId?: string;
  onOpen(canvasId: string): void;
}

/** Searchable canvas catalog (plan §13). Only expanded branches render, so large catalogs stay cheap. */
export function CatalogNav({
  catalog: all,
  workspace = 'architecture',
  currentCanvasId,
  onOpen,
}: Props) {
  const catalog = useMemo(() => {
    if (!all) return all;
    const ids = new Set(
      all.canvases
        .filter((c) => (c.workspace ?? 'architecture') === workspace && c.state !== 'suppressed')
        .map((c) => c.id),
    );
    return {
      ...all,
      canvases: all.canvases.filter((c) => ids.has(c.id)),
      links: all.links.filter((l) => ids.has(l.fromCanvasId) && ids.has(l.toCanvasId)),
    };
  }, [all, workspace]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const { roots, children, byId, ancestors } = useMemo(() => {
    const byId = new Map<string, CanvasSpecDto>((catalog?.canvases ?? []).map((c) => [c.id, c]));
    const children = new Map<string, string[]>();
    const parent = new Map<string, string>();
    for (const l of catalog?.links ?? []) {
      if (l.relation !== 'child') continue;
      (children.get(l.fromCanvasId) ?? children.set(l.fromCanvasId, []).get(l.fromCanvasId)!).push(
        l.toCanvasId,
      );
      parent.set(l.toCanvasId, l.fromCanvasId);
    }
    for (const list of children.values())
      list.sort(
        (a, b) =>
          byId.get(b)!.relevanceScore - byId.get(a)!.relevanceScore ||
          byId.get(a)!.title.localeCompare(byId.get(b)!.title),
      );
    const roots = [...byId.values()]
      .filter((c) => !c.ownerCanvasId)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
    const ancestors = (id: string) => {
      const out: string[] = [];
      for (let cur = parent.get(id); cur; cur = parent.get(cur)) out.push(cur);
      return out;
    };
    return { roots, children, byId, ancestors };
  }, [catalog]);

  if (!catalog)
    return <p className="empty-note">No views yet. The catalog fills after the first scan.</p>;
  if (workspace === 'design' && catalog.canvases.length === 0)
    return (
      <p className="empty-note">
        No design boxes yet. The system design is drawn from detected deployables, packages, stores
        and queues; a scan that finds none leaves it empty.
      </p>
    );
  const q = query.trim().toLowerCase();
  const expanded = new Set([
    ...open,
    ...(currentCanvasId ? ancestors(currentCanvasId) : []),
    // the design tree is small and its subsystems are the point: show the first level unless closed
    ...(workspace === 'design' ? roots.filter((r) => !closed.has(r.id)).map((r) => r.id) : []),
  ]);

  const Item = ({ c, depth }: { c: CanvasSpecDto; depth: number }) => {
    const kids = children.get(c.id) ?? [];
    const isOpen = expanded.has(c.id);
    return (
      <li>
        <div
          className={`cat-row ${c.id === currentCanvasId ? 'current' : ''}`}
          style={{ paddingLeft: depth * 12 }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              className="twisty"
              aria-label={isOpen ? `Collapse ${c.title}` : `Expand ${c.title}`}
              aria-expanded={isOpen}
              onClick={() => {
                const toggle = (s: Set<string>) => {
                  const n = new Set(s);
                  if (n.has(c.id)) n.delete(c.id);
                  else n.add(c.id);
                  return n;
                };
                if (workspace === 'design' && depth === 0) setClosed(toggle);
                else setOpen(toggle);
              }}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="twisty-spacer" />
          )}
          <button
            type="button"
            className="cat-link"
            aria-current={c.id === currentCanvasId ? 'page' : undefined}
            onClick={() => onOpen(c.id)}
            title={c.relevanceReason}
          >
            <span className="cat-title">{c.title}</span>
            {c.lens === 'design-subsystem' ? (
              <ProvenanceBadge provenance={c.provenance} />
            ) : (
              <span className="cat-lens">{LENS_LABEL[c.lens] ?? c.lens}</span>
            )}
          </button>
        </div>
        {isOpen && kids.length > 0 && (
          <ul className="cat-list">
            {kids.map((k) => (
              <Item key={k} c={byId.get(k)!} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="catalog">
      <label className="field">
        <span className="field-label">Canvas catalog · {catalog.canvases.length}</span>
        <input
          type="search"
          placeholder="Search views"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {q ? (
        <ul className="cat-list" aria-label="Matching views">
          {[...byId.values()]
            .filter((c) => c.title.toLowerCase().includes(q) || c.lens.includes(q))
            .slice(0, 100)
            .map((c) => (
              <li key={c.id}>
                <div className={`cat-row ${c.id === currentCanvasId ? 'current' : ''}`}>
                  <button type="button" className="cat-link" onClick={() => onOpen(c.id)}>
                    <span className="cat-title">{c.title}</span>
                    {c.lens === 'design-subsystem' ? (
                      <ProvenanceBadge provenance={c.provenance} />
                    ) : (
                      <span className="cat-lens">{LENS_LABEL[c.lens] ?? c.lens}</span>
                    )}
                  </button>
                </div>
              </li>
            ))}
        </ul>
      ) : (
        <ul className="cat-list" aria-label="Views">
          {roots.map((c) => (
            <Item key={c.id} c={c} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}
