import { useCallback, useEffect, useState } from 'react';
import { api, resolveIssueApi, type IssueDto } from '../api.ts';

interface Props {
  token: string;
  projectId: string;
  onClose(): void;
  /** Called after a link or dismissal so counts and views refresh. */
  onChanged(): void;
}

const TITLES: Record<string, string> = {
  'ambiguous-rename': 'Ambiguous rename',
  'possible-rename': 'Possible rename',
};

/**
 * Rename issues the reconciler would not decide on its own (plan §9). Linking records a
 * user-accepted alias, so pins, notes and remembered positions stay with the moved file.
 */
export function IssuesPanel({ token, projectId, onClose, onChanged }: Props) {
  const [issues, setIssues] = useState<IssueDto[] | null>(null);
  const [error, setError] = useState<string>();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ issues: IssueDto[] }>(`/projects/${projectId}/issues`, token);
    setIssues(r.issues);
  }, [projectId, token]);

  useEffect(() => {
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const act = async (
    issueId: string,
    body: { action: 'link'; fromId: string; toId: string } | { action: 'dismiss' },
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      await resolveIssueApi(token, issueId, body);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="issues-panel" role="dialog" aria-label="Rename issues">
      <header>
        <h2>Rename issues</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close rename issues"
        >
          ✕
        </button>
      </header>
      <p className="hint">
        Atlas never merges these on its own. Linking an old file to its new location keeps pins,
        notes and history with it; dismissing treats them as unrelated files.
      </p>
      {error && <p className="error">{error}</p>}
      {issues === null ? (
        <p className="hint">Loading…</p>
      ) : issues.length === 0 ? (
        <p className="empty">No open rename issues.</p>
      ) : (
        <ul>
          {issues.map((i) => {
            const d = i.detail;
            const from = d.from ?? [];
            const to = d.to ?? [];
            const linkable = !!(d.fromIds?.length && d.toIds?.length);
            const linkedFrom = new Set((d.links ?? []).map((l) => l.fromId));
            const linkedTo = new Set((d.links ?? []).map((l) => l.toId));
            const label = (ids: string[] | undefined, paths: string[], id: string) =>
              paths[ids?.indexOf(id) ?? -1] ?? id;
            return (
              <li
                key={i.id}
                className="issue"
                aria-label={`${TITLES[i.kind] ?? i.kind}: ${from.join(', ')}`}
              >
                <h3>{TITLES[i.kind] ?? i.kind}</h3>
                {d.reason && <p className="hint">{d.reason}</p>}
                {(d.links ?? []).map((l) => (
                  <p key={l.fromId} className="linked">
                    <code>{label(d.fromIds, from, l.fromId)}</code> →{' '}
                    <code>{label(d.toIds, to, l.toId)}</code>{' '}
                    <span className="badge ready">linked</span>
                  </p>
                ))}
                {linkable ? (
                  d
                    .fromIds!.filter((fid) => !linkedFrom.has(fid))
                    .sort((x, y) =>
                      label(d.fromIds, from, x).localeCompare(label(d.fromIds, from, y)),
                    )
                    .map((fid) => {
                      const key = `${i.id}:${fid}`;
                      const options = d.toIds!.filter((t) => !linkedTo.has(t));
                      // with several candidates nothing is preselected: a wrong link is worse than none
                      const selected = choice[key] ?? (options.length === 1 ? options[0]! : '');
                      const oldPath = label(d.fromIds, from, fid);
                      return (
                        <div key={fid} className="issue-row">
                          <code>{oldPath}</code>
                          <span aria-hidden="true">→</span>
                          <select
                            aria-label={`New location of ${oldPath}`}
                            value={selected}
                            onChange={(e) => setChoice((c) => ({ ...c, [key]: e.target.value }))}
                          >
                            {options.length > 1 && (
                              <option value="" disabled>
                                Choose the new location…
                              </option>
                            )}
                            {options.map((t) => (
                              <option key={t} value={t}>
                                {label(d.toIds, to, t)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="action"
                            disabled={busy || !selected}
                            onClick={() =>
                              void act(i.id, { action: 'link', fromId: fid, toId: selected })
                            }
                          >
                            Link
                          </button>
                        </div>
                      );
                    })
                ) : (
                  <p className="hint">
                    {from.join(', ')} → {to.join(', ')} (detected before linking was available;
                    rescan after a new move to link)
                  </p>
                )}
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => void act(i.id, { action: 'dismiss' })}
                >
                  Dismiss
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
