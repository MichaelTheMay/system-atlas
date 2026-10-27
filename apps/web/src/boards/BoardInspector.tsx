import { useEffect, useState } from 'react';
import {
  COMPONENT_CATALOG,
  componentTypeInfo,
  Protocol,
  type Component,
  type ComponentFamily,
  type ComponentType,
  type Connection,
  type PropertyField,
} from '@atlas/schema';
import { createBoard } from './api.ts';
import { useBoard } from './context.ts';
import { DocPanel } from './DocPanel.tsx';
import { ComponentIcon, FAMILY_LABEL } from './Palette.tsx';
import { ScenariosPanel } from './ScenariosPanel.tsx';

/**
 * Board inspector (D03): the right column while a board is open. Wave 1a fills it with the
 * selected component's or connection's form, or the board summary; waves 1b/1c add their panels
 * (scenarios, design doc, proposals) as further sections below.
 */
export function BoardInspector() {
  const { board, selection } = useBoard();
  const component = selection.componentId
    ? board.document.components[selection.componentId]
    : undefined;
  const connection = selection.connectionId
    ? board.document.connections[selection.connectionId]
    : undefined;
  const [tab, setTab] = useState<'properties' | 'scenarios' | 'doc'>('properties');
  const tabs = [
    ['properties', 'Properties'],
    ['scenarios', 'Scenarios'],
    ['doc', 'Design doc'],
  ] as const;
  return (
    <div className="board-inspector">
      <h2>Inspector</h2>
      {/* wave 1b: scenarios and the design doc are tabs next to the properties */}
      <div className="board-side-tabs" role="tablist" aria-label="Board panels">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'properties' ? (
        component ? (
          <ComponentPanel key={component.id} component={component} />
        ) : connection ? (
          <ConnectionPanel key={connection.id} connection={connection} />
        ) : (
          <BoardSummary />
        )
      ) : (
        <section
          className="board-side"
          role="tabpanel"
          aria-label={tab === 'scenarios' ? 'Scenarios' : 'Design doc'}
        >
          {tab === 'scenarios' ? <ScenariosPanel /> : <DocPanel />}
        </section>
      )}
    </div>
  );
}

/** A text/number input that commits on Enter or blur (not on every keystroke). */
function CommitInput({
  label,
  value,
  onCommit,
  type = 'text',
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  type?: 'text' | 'number';
  placeholder?: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className="board-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={draft}
          rows={3}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          type={type}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
    </label>
  );
}

function PropertyInput({
  field,
  value,
  onChange,
}: {
  field: PropertyField;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean | undefined) => void;
}) {
  const label = field.hint ? `${field.label} (${field.hint})` : field.label;
  if (field.kind === 'boolean')
    return (
      <label className="board-field board-field-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked ? true : undefined)}
        />
        <span>{field.label}</span>
      </label>
    );
  if (field.kind === 'select')
    return (
      <label className="board-field">
        <span>{label}</span>
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">
            —{field.default !== undefined ? ` (default: ${String(field.default)})` : ''}
          </option>
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <CommitInput
      label={label}
      type={field.kind === 'number' ? 'number' : 'text'}
      value={value === undefined ? '' : String(value)}
      placeholder={field.default !== undefined ? `default: ${String(field.default)}` : undefined}
      onCommit={(v) => {
        const t = v.trim();
        if (!t) onChange(undefined);
        else if (field.kind === 'number') {
          const n = Number(t);
          onChange(Number.isFinite(n) ? n : undefined);
        } else onChange(t.slice(0, 200));
      }}
    />
  );
}

export function ComponentPanel({ component: c }: { component: Component }) {
  const { board, controller, select, token, openBoard } = useBoard();
  const info = componentTypeInfo(c.type);
  const [target, setTarget] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const others = Object.values(board.document.components).filter((o) => o.id !== c.id);
  const links = Object.values(board.document.connections).filter(
    (k) => k.from === c.id || k.to === c.id,
  );
  const setProp = (key: string, v: string | number | boolean | undefined) => {
    const props = { ...c.props };
    if (v === undefined) delete props[key];
    else props[key] = v;
    controller.updateComponent(c.id, { props });
  };
  const internals = async () => {
    setError(undefined);
    if (c.internalsBoardId) return openBoard(c.internalsBoardId);
    try {
      const sub = await createBoard(token, board.projectId, {
        name: `${c.label} — internals`,
        source: 'blank',
        parentBoardId: board.id,
      });
      controller.updateComponent(c.id, { internalsBoardId: sub.id });
      openBoard(sub.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="board-panel" aria-label="Component">
      <p className="board-panel-kind">
        <ComponentIcon name={info.icon} size={16} /> {info.label}
        {c.status === 'proposed' && <span className="board-badge"> proposed</span>}
        {c.origin.author !== 'user' && <span className="board-badge"> {c.origin.author}</span>}
      </p>
      <CommitInput
        label="Label"
        value={c.label}
        onCommit={(v) => v.trim() && controller.updateComponent(c.id, { label: v.trim() })}
      />
      <label className="board-field">
        <span>Type</span>
        <select
          value={c.type}
          onChange={(e) => {
            // keep the properties the new type also has (same key), drop the rest
            const type = e.target.value as ComponentType;
            const keys = new Set(componentTypeInfo(type).properties.map((p) => p.key));
            const props = Object.fromEntries(Object.entries(c.props).filter(([k]) => keys.has(k)));
            controller.updateComponent(c.id, { type, props });
          }}
        >
          {groupedCatalog().map(([family, items]) => (
            <optgroup key={family} label={FAMILY_LABEL[family]}>
              {items.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <CommitInput
        label="Responsibility"
        multiline
        value={c.responsibility ?? ''}
        placeholder="What this part owns and does"
        onCommit={(v) =>
          controller.updateComponent(c.id, { responsibility: v.trim().slice(0, 500) || undefined })
        }
      />
      {info.properties.length > 0 && (
        <fieldset className="board-props">
          <legend>Properties</legend>
          {info.properties.map((f) => (
            <PropertyInput
              key={f.key}
              field={f}
              value={c.props[f.key]}
              onChange={(v) => setProp(f.key, v)}
            />
          ))}
        </fieldset>
      )}
      <div className="board-actions">
        <button type="button" onClick={() => void internals()}>
          {c.internalsBoardId ? 'Open internals' : 'Internals…'}
        </button>
        <button type="button" onClick={() => controller.reveal(c.id)}>
          Show on board
        </button>
      </div>
      {error && <p className="board-error">{error}</p>}
      <fieldset className="board-connect">
        <legend>Connections</legend>
        {links.length > 0 && (
          <ul className="board-links">
            {links.map((k) => {
              const other = board.document.components[k.from === c.id ? k.to : k.from];
              return (
                <li key={k.id}>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => select({ connectionId: k.id })}
                  >
                    {k.from === c.id ? '→' : '←'} {other?.label ?? '?'}
                    {k.protocol ? ` · ${k.protocol}` : ''}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="board-connect-row">
          <select
            aria-label="Connect to"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Connect to…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target}
            onClick={() => {
              const id = controller.connect(c.id, target);
              setTarget('');
              if (id) select({ connectionId: id });
            }}
          >
            Connect
          </button>
        </div>
      </fieldset>
      <div className="board-actions">
        {confirm ? (
          <>
            <button
              type="button"
              className="danger"
              onClick={() => controller.deleteComponent(c.id)}
            >
              Confirm delete
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirm(true)}>
            Delete component
          </button>
        )}
      </div>
    </section>
  );
}

export function ConnectionPanel({ connection: k }: { connection: Connection }) {
  const { board, controller, select } = useBoard();
  const from = board.document.components[k.from];
  const to = board.document.components[k.to];
  const set = (patch: Parameters<typeof controller.updateConnection>[1]) =>
    controller.updateConnection(k.id, patch);
  const text = (v: string, max: number) => v.trim().slice(0, max) || undefined;
  return (
    <section className="board-panel" aria-label="Connection">
      <p className="board-panel-kind">
        <button type="button" className="link-btn" onClick={() => select({ componentId: k.from })}>
          {from?.label ?? k.from}
        </button>
        {k.direction === 'bidirectional' ? ' ↔ ' : ' → '}
        <button type="button" className="link-btn" onClick={() => select({ componentId: k.to })}>
          {to?.label ?? k.to}
        </button>
      </p>
      <label className="board-field">
        <span>Protocol</span>
        <select
          value={k.protocol ?? ''}
          onChange={(e) =>
            set({ protocol: (e.target.value || undefined) as Connection['protocol'] })
          }
        >
          <option value="">—</option>
          {Protocol.options.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="board-field">
        <span>Mode</span>
        <select
          value={k.mode}
          onChange={(e) => set({ mode: e.target.value as Connection['mode'] })}
        >
          <option value="sync">sync</option>
          <option value="async">async</option>
        </select>
      </label>
      <label className="board-field">
        <span>Direction</span>
        <select
          value={k.direction}
          onChange={(e) => set({ direction: e.target.value as Connection['direction'] })}
        >
          <option value="request-response">request-response</option>
          <option value="one-way">one-way</option>
          <option value="bidirectional">bidirectional</option>
        </select>
      </label>
      <CommitInput
        label="Payload"
        value={k.payload ?? ''}
        placeholder="CreateOrder, order.created"
        onCommit={(v) => set({ payload: text(v, 120) })}
      />
      <CommitInput
        label="Volume"
        value={k.volume ?? ''}
        placeholder="~1k rps"
        onCommit={(v) => set({ volume: text(v, 60) })}
      />
      <CommitInput
        label="Label"
        value={k.label ?? ''}
        placeholder="shown instead of the payload"
        onCommit={(v) => set({ label: text(v, 120) })}
      />
      <div className="board-actions">
        <button type="button" onClick={() => controller.reverseConnection(k.id)}>
          Reverse direction
        </button>
        <button type="button" className="danger" onClick={() => controller.deleteConnection(k.id)}>
          Delete connection
        </button>
      </div>
    </section>
  );
}

export function BoardSummary() {
  const { board } = useBoard();
  const comps = Object.values(board.document.components);
  const byFamily = new Map<ComponentFamily, number>();
  for (const c of comps) {
    const f = componentTypeInfo(c.type).family;
    byFamily.set(f, (byFamily.get(f) ?? 0) + 1);
  }
  return (
    <section className="board-panel" aria-label="Board summary">
      <p className="empty-note">
        Select a component or connection on the board to edit it. Add components from the palette on
        the left.
      </p>
      <dl className="board-summary">
        <dt>Components</dt>
        <dd>{comps.length}</dd>
        {[...byFamily].map(([f, n]) => (
          <div key={f} className="board-summary-row">
            <dt>{FAMILY_LABEL[f]}</dt>
            <dd>{n}</dd>
          </div>
        ))}
        <dt>Connections</dt>
        <dd>{Object.keys(board.document.connections).length}</dd>
        <dt>Frames</dt>
        <dd>{board.document.frames.length}</dd>
      </dl>
      {board.document.doc.summary && (
        <p className="board-doc-summary">{board.document.doc.summary}</p>
      )}
    </section>
  );
}

function groupedCatalog() {
  const out = new Map<ComponentFamily, (typeof COMPONENT_CATALOG)[number][]>();
  for (const c of COMPONENT_CATALOG) out.set(c.family, [...(out.get(c.family) ?? []), c]);
  return [...out];
}
