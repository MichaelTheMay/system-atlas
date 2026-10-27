import { useState } from 'react';
import { DOC_SECTION_LABEL, DocSection, type DocItem } from '@atlas/schema';
import { useBoard } from './context.ts';
import { connectionTitle, newLocalId } from './scenarios.ts';

/**
 * The board's design doc (D03 wave 1b): a summary and items in seven sections (requirements, NFRs,
 * estimates, API, data model, decisions, risks), each optionally pinned to components or
 * connections. Agent items arrive `proposed` (labeled "agent") and become active only when a
 * person accepts them; rejected ones are kept out of the doc and exports.
 */
export function DocPanel() {
  const { board, patchDocument, selection, select } = useBoard();
  const doc = board.document;
  const [section, setSection] = useState<DocSection>('requirements');
  const [text, setText] = useState('');
  const [pinSel, setPinSel] = useState(true);
  const [editing, setEditing] = useState<string>();

  const selPin = selection.componentId ?? selection.connectionId;
  const pinLabel = (id: string) =>
    doc.components[id]?.label ??
    (doc.connections[id] ? connectionTitle(doc, doc.connections[id]!) : undefined);

  const patchItems = (fn: (items: DocItem[]) => DocItem[]) =>
    patchDocument((d) => ({ ...d, doc: { ...d.doc, items: fn(d.doc.items) } }));
  const patchItem = (id: string, fn: (i: DocItem) => DocItem) =>
    patchItems((items) => items.map((i) => (i.id === id ? fn(i) : i)));

  const add = () => {
    const t = text.trim();
    if (!t) return;
    patchItems((items) => [
      ...items,
      {
        id: newLocalId('doc'),
        section,
        text: t,
        pins: pinSel && selPin ? [selPin] : [],
        origin: { author: 'user' },
        status: 'active',
      },
    ]);
    setText('');
  };

  const items = doc.doc.items.filter((i) => i.status !== 'rejected');
  return (
    <div className="doc-panel">
      <div className="panel-head">
        <h3>Design doc</h3>
      </div>
      <label className="doc-summary">
        Summary
        <textarea
          key={`summary-${board.id}`}
          defaultValue={doc.doc.summary ?? ''}
          rows={3}
          maxLength={4000}
          placeholder="What this system does, for whom, and the shape of the solution"
          onBlur={(e) => {
            const summary = e.target.value.trim() || undefined;
            if (summary !== doc.doc.summary)
              patchDocument((d) => ({ ...d, doc: { ...d.doc, summary } }));
          }}
        />
      </label>

      <form
        className="doc-add"
        aria-label="Add design doc item"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select
          aria-label="Section"
          value={section}
          onChange={(e) => setSection(e.target.value as DocSection)}
        >
          {DocSection.options.map((s) => (
            <option key={s} value={s}>
              {DOC_SECTION_LABEL[s]}
            </option>
          ))}
        </select>
        <textarea
          aria-label="New item"
          value={text}
          rows={2}
          maxLength={4000}
          placeholder="Requirement, estimate, decision, risk…"
          onChange={(e) => setText(e.target.value)}
        />
        <label className="doc-pin-sel">
          <input
            type="checkbox"
            checked={pinSel}
            disabled={!selPin}
            onChange={(e) => setPinSel(e.target.checked)}
          />
          {selPin ? `Pin to selection: ${pinLabel(selPin) ?? selPin}` : 'Select a box to pin to it'}
        </label>
        <button type="submit" className="primary" disabled={!text.trim()}>
          Add item
        </button>
      </form>

      {DocSection.options.map((s) => {
        const xs = items.filter((i) => i.section === s);
        return (
          <section key={s} className="doc-section" aria-label={DOC_SECTION_LABEL[s]}>
            <h4>
              {DOC_SECTION_LABEL[s]} <span className="doc-count">{xs.length || ''}</span>
            </h4>
            <ul>
              {xs.map((i) => (
                <li key={i.id} className={`doc-item${i.status === 'proposed' ? ' proposed' : ''}`}>
                  {editing === i.id ? (
                    <textarea
                      aria-label="Edit item"
                      defaultValue={i.text}
                      autoFocus
                      rows={3}
                      maxLength={4000}
                      onBlur={(e) => {
                        const t = e.target.value.trim();
                        if (t && t !== i.text) patchItem(i.id, (x) => ({ ...x, text: t }));
                        setEditing(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditing(undefined);
                      }}
                    />
                  ) : (
                    <p className="doc-text" onDoubleClick={() => setEditing(i.id)}>
                      {i.text}
                    </p>
                  )}
                  <div className="doc-meta">
                    {i.status === 'proposed' && (
                      <>
                        <span className="chip chip-agent" title={i.origin.name}>
                          agent
                        </span>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => patchItem(i.id, (x) => ({ ...x, status: 'active' }))}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => patchItem(i.id, (x) => ({ ...x, status: 'rejected' }))}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {i.pins.map((p) => (
                      <span key={p} className="chip chip-pin">
                        <button
                          type="button"
                          title="Select on the canvas"
                          onClick={() =>
                            select(doc.components[p] ? { componentId: p } : { connectionId: p })
                          }
                        >
                          {pinLabel(p) ?? `${p} (gone)`}
                        </button>
                        <button
                          type="button"
                          aria-label={`Unpin ${pinLabel(p) ?? p}`}
                          className="chip-x"
                          onClick={() =>
                            patchItem(i.id, (x) => ({ ...x, pins: x.pins.filter((y) => y !== p) }))
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <span className="doc-item-actions">
                      {selPin && !i.pins.includes(selPin) && (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            patchItem(i.id, (x) => ({ ...x, pins: [...x.pins, selPin] }))
                          }
                        >
                          Pin selection
                        </button>
                      )}
                      <button type="button" className="link-btn" onClick={() => setEditing(i.id)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        aria-label="Delete item"
                        onClick={() => patchItems((all) => all.filter((x) => x.id !== i.id))}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
