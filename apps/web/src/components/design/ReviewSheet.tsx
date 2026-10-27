import { useCallback, useEffect, useState } from 'react';
import type { CanvasSpecDto, CatalogDto } from '../../api.ts';
import './design-agent.css';
import { call, type DesignClaimDto } from './useDesignJobs.ts';

/**
 * Review of generated design proposals (D02b): proposed design-subsystem canvases grouped by
 * level. Accept promotes the agent's claims to human claims through the validator (a parent takes
 * its nested subsystems along); Reject rejects the agent's subsystem claims (audited). Nothing
 * becomes accepted without a person.
 */

const segs = (v: unknown) =>
  typeof v === 'string'
    ? v
        .split('/')
        .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
        .filter(Boolean)
    : [];

/** "Services/Api" path of a design-subsystem canvas: owner titles below the System design root. */
export function canvasPath(catalog: CatalogDto, c: CanvasSpecDto): string[] {
  const out: string[] = [];
  let cur: CanvasSpecDto | undefined = c;
  for (let i = 0; cur && cur.lens === 'design-subsystem' && i < 10; i++) {
    out.unshift(cur.title);
    const owner: string | undefined = cur.ownerCanvasId;
    cur = catalog.canvases.find((x) => x.id === owner);
  }
  return out;
}

/** Model subsystem claims at or below a path (what promote and reject act on). */
export function claimsUnder(claims: DesignClaimDto[], path: string[]): DesignClaimDto[] {
  const p = path.map((s) => s.toLowerCase());
  return claims.filter((c) => {
    if (c.predicate !== 'subsystem' || c.origin !== 'model' || c.status === 'rejected')
      return false;
    const v = segs(c.value);
    return v.length >= p.length && p.every((x, i) => v[i] === x);
  });
}

export async function promotePath(
  token: string,
  projectId: string,
  snapshotId: string,
  canvasId: string,
  path: string,
): Promise<string | undefined> {
  const r = await call<{ accepted?: unknown[]; rejected?: { reasons: string[] }[] }>(
    token,
    'PUT',
    `/views/${canvasId}/override`,
    { action: 'promote', enabled: true, projectId, snapshotId, subsystemPath: path },
  );
  if (r.ok) return undefined;
  if (r.body.error === 'promotion_rejected')
    return `Refused by the claim validator: ${(r.body.rejected ?? [])
      .flatMap((x) => x.reasons)
      .slice(0, 3)
      .join('; ')}`;
  return r.body.error ?? `HTTP ${r.status}`;
}

export async function rejectClaims(token: string, claims: DesignClaimDto[], reason: string) {
  let n = 0;
  for (const c of claims)
    if ((await call(token, 'POST', `/claims/${c.id}/reject`, { reason })).ok) n++;
  return n;
}

interface Item {
  canvas: CanvasSpecDto;
  path: string[];
  members: string[];
  model?: string;
}

export function ReviewSheet({
  token,
  projectId,
  snapshotId,
  runId,
  onOpenRun,
  onChanged,
}: {
  token: string;
  projectId: string;
  /** Latest snapshot: promotions are validated against it. */
  snapshotId: string;
  runId?: string;
  onOpenRun(runId: string): void;
  onChanged(): void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  /** Paths reviewed in this sheet; rejected ones are dropped from the list. */
  const [status, setStatus] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [claims, setClaims] = useState<DesignClaimDto[]>([]);

  const load = useCallback(async () => {
    const [cat, cl] = await Promise.all([
      call<CatalogDto>(token, 'GET', `/snapshots/${snapshotId}/canvases`),
      call<{ claims: DesignClaimDto[] }>(token, 'GET', `/snapshots/${snapshotId}/design/claims`),
    ]);
    if (!cat.ok) return;
    const all = cl.ok ? cl.body.claims : [];
    setClaims(all);
    const subs = cat.body.canvases.filter(
      (c) => c.lens === 'design-subsystem' && c.state !== 'suppressed',
    );
    setItems(
      subs.map((c) => {
        const path = canvasPath(cat.body, c);
        const exact = all.filter(
          (x) =>
            x.predicate === 'subsystem' &&
            segs(x.value).join('/') === segs(path.join('/')).join('/'),
        );
        return {
          canvas: c,
          path,
          members: [...new Set(exact.map((x) => x.subjectName))].sort(),
          model: exact.find((x) => x.model)?.model,
        };
      }),
    );
  }, [token, snapshotId]);

  useEffect(() => {
    void load();
  }, [load]);

  const key = (it: Item) => it.path.join('/');
  const accept = async (list: Item[]) => {
    setBusy(true);
    setMessage(undefined);
    const errs: string[] = [];
    for (const it of list) {
      const err = await promotePath(token, projectId, snapshotId, it.canvas.id, key(it));
      if (err) errs.push(`${key(it)}: ${err}`);
      else setStatus((s) => ({ ...s, [key(it)]: 'accepted' }));
    }
    if (errs.length) setMessage(errs.join(' · '));
    await load();
    setBusy(false);
    onChanged();
  };
  const reject = async (it: Item) => {
    setBusy(true);
    setMessage(undefined);
    const n = await rejectClaims(token, claimsUnder(claims, it.path), 'rejected in design review');
    setStatus((s) => ({ ...s, [key(it)]: 'rejected' }));
    setMessage(`Rejected ${key(it)} (${n} claim${n === 1 ? '' : 's'}).`);
    await load();
    setBusy(false);
    onChanged();
  };

  if (!items) return <p className="muted">Loading proposals…</p>;
  // shown: proposals, plus what was accepted here; rejected (and earlier accepted) work stays out
  const shown = items.filter(
    (it) => it.canvas.provenance === 'proposed' || status[key(it)] === 'accepted',
  );
  const pending = shown.filter((it) => it.canvas.provenance === 'proposed');
  const levels = [...new Set(shown.map((it) => it.path.length - 1))].sort();
  const topPending = pending.filter(
    (it) => !pending.some((p) => p !== it && key(it).startsWith(`${key(p)}/`)),
  );

  return (
    <section className="da-review" role="region" aria-label="Review proposals">
      <div className="da-review-head">
        <p>
          {pending.length
            ? `${pending.length} proposed subsystem${pending.length === 1 ? '' : 's'} to review. Nothing is accepted until you accept it.`
            : 'No proposals left to review.'}
        </p>
        <div className="da-buttons">
          <button
            type="button"
            className="action-sm primary"
            disabled={busy || !topPending.length}
            onClick={() => void accept(topPending)}
          >
            Accept all
          </button>
          {runId && (
            <button type="button" className="action-sm" onClick={() => onOpenRun(runId)}>
              Open run in Outputs &amp; Audit
            </button>
          )}
        </div>
      </div>
      {levels.map((lvl) => (
        <div key={lvl} className="da-level">
          <h3 className="da-h">Level {lvl}</h3>
          <ul className="da-items" aria-label={`Level ${lvl} proposals`}>
            {shown
              .filter((it) => it.path.length - 1 === lvl)
              .map((it) => {
                const accepted = it.canvas.provenance !== 'proposed';
                const nested = items.some((x) => key(x).startsWith(`${key(it)}/`));
                return (
                  <li key={it.canvas.id} className="da-item" aria-label={key(it)}>
                    <div className="da-item-main">
                      <span className="da-item-title">{key(it)}</span>
                      <span className={`tag ${accepted ? 'tag-added' : 'st-inferred'}`}>
                        {accepted ? 'accepted' : 'proposed'}
                      </span>
                      {it.model && <span className="da-agent">agent: {it.model}</span>}
                      <span className="muted small">
                        {it.members.length
                          ? `${it.members.length} box${it.members.length === 1 ? '' : 'es'}: ${it.members.slice(0, 6).join(', ')}${it.members.length > 6 ? '…' : ''}`
                          : `${it.canvas.coverageSummary.entityCount} entities`}
                      </span>
                    </div>
                    {!accepted && (
                      <div className="da-buttons">
                        <button
                          type="button"
                          className="action-sm primary"
                          disabled={busy}
                          title={
                            nested
                              ? 'Accept this subsystem and the subsystems nested in it'
                              : 'Accept this subsystem'
                          }
                          onClick={() => void accept([it])}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="action-sm"
                          disabled={busy}
                          onClick={() => void reject(it)}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
      {message && (
        <p className="muted small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
