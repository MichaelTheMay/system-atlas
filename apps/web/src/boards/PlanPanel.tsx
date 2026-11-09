import { useState, type ReactNode } from 'react';
import './board-agent.css';

/** The ```text block under "## Agent brief", or the whole plan when there is none. */
export function agentBrief(plan: string): string {
  const m = /##\s*Agent brief[\s\S]*?```(?:text)?\n([\s\S]*?)```/.exec(plan);
  return (m?.[1] ?? plan).trim();
}

/** Small, safe Markdown view (text nodes only): headings, checklists, bullets, fences, bold. */
function MarkdownView({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  const inline = (s: string) =>
    s
      .split(/(\*\*[^*]+\*\*)/)
      .map((part, i) =>
        /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
      );
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) body.push(lines[i]!);
      out.push(
        <pre key={i} className="ba-pre">
          {body.join('\n')}
        </pre>,
      );
    } else if (l.startsWith('# ')) out.push(<h3 key={i}>{l.slice(2)}</h3>);
    else if (l.startsWith('## ')) out.push(<h4 key={i}>{l.slice(3)}</h4>);
    else if (l.startsWith('### ')) out.push(<h5 key={i}>{l.slice(4)}</h5>);
    else if (/^- \[[ x]\] /.test(l))
      out.push(
        <p key={i} className="ba-check">
          ☐ {inline(l.slice(6))}
        </p>,
      );
    else if (l.startsWith('- '))
      out.push(
        <p key={i} className="ba-bullet">
          • {inline(l.slice(2))}
        </p>,
      );
    else if (l.trim() === '---') out.push(<hr key={i} />);
    else if (l.trim()) out.push(<p key={i}>{inline(l.replace(/^_(.*)_$/, '$1'))}</p>);
  }
  return <div className="ba-md">{out}</div>;
}

/**
 * Implementation plan of a board (D03c): Markdown tickets per component with acceptance criteria,
 * kept on the board's design doc. "Copy as agent brief" copies the brief block for a coding agent.
 */
export function PlanPanel({
  plan,
  model,
  busy,
  onRegenerate,
}: {
  plan: string;
  model?: string;
  busy?: boolean;
  onRegenerate(): void;
}) {
  const [copied, setCopied] = useState<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agentBrief(plan));
      setCopied('Copied');
    } catch {
      setCopied('Copy failed: select the brief text instead');
    }
  };
  const tickets = (plan.match(/^### /gm) ?? []).length;
  return (
    <aside className="ba-plan" role="region" aria-label="Implementation plan">
      <header className="ba-panel-head">
        <strong>Implementation plan</strong>
        <span className="muted small">
          {tickets} ticket(s){model ? ` · agent: ${model}` : ''}
        </span>
        <button type="button" className="action-sm primary" onClick={() => void copy()}>
          Copy as agent brief
        </button>
        <button type="button" className="action-sm" disabled={busy} onClick={onRegenerate}>
          Regenerate
        </button>
      </header>
      {copied && (
        <p className="muted small" role="status">
          {copied}
        </p>
      )}
      <div className="ba-panel-body">
        <MarkdownView text={plan} />
      </div>
    </aside>
  );
}
