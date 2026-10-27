import { useEffect, useState } from 'react';
import type { Scenario } from '@atlas/schema';
import { useBoard } from './context.ts';
import { scenarioToMermaid } from './scenarios.ts';

let renderSeq = 0;

/**
 * A scenario as a sequence diagram (D03 wave 1b): Mermaid text generated from the steps, rendered
 * with the bundled `mermaid` package (no CDN; lazy-loaded so it stays out of the main chunk).
 * `securityLevel: 'strict'` makes Mermaid sanitize labels, which come from the board.
 */
export function SequenceView({ scenario }: { scenario: Scenario }) {
  const { board } = useBoard();
  const text = scenarioToMermaid(board.document, scenario);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [large, setLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          suppressErrorRendering: true,
          sequence: { useMaxWidth: false, mirrorActors: false },
        });
        const r = await mermaid.render(`atlas-seq-${++renderSeq}`, text);
        if (!cancelled) setSvg(r.svg);
      } catch (e) {
        if (!cancelled) {
          setSvg('');
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  // Esc closes the enlarged view
  useEffect(() => {
    if (!large) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLarge(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [large]);

  return (
    <div
      className={`seq-view${large ? ' seq-large' : ''}`}
      role="figure"
      aria-label={`Sequence diagram: ${scenario.name}`}
    >
      <div className="seq-actions">
        {large && <strong className="seq-title">{scenario.name}</strong>}
        <button type="button" aria-pressed={large} onClick={() => setLarge((l) => !l)}>
          {large ? 'Close' : 'Enlarge'}
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => setCopied('Copied'))
              .catch(() => setCopied('Clipboard blocked'))
              .finally(() => setTimeout(() => setCopied(undefined), 1500))
          }
        >
          {copied ?? 'Copy Mermaid'}
        </button>
      </div>
      {error ? (
        <>
          <p className="board-error">Could not render the diagram: {error}</p>
          <pre className="seq-source">{text}</pre>
        </>
      ) : svg ? (
        <div
          className="seq-svg"
          title={large ? undefined : 'Enlarge'}
          onClick={() => setLarge(true)}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="board-loading">Rendering…</p>
      )}
    </div>
  );
}
