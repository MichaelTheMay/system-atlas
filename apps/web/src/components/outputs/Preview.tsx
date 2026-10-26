import { useEffect, useState } from 'react';
import { api, type ArtifactDto, type PreviewUrlDto } from '../../api.ts';

/**
 * Renders an artifact only through the isolated preview origin (docs/evidence.md). Untrusted
 * HTML/SVG gets a sandboxed frame without allow-same-origin (the server adds a sandbox CSP too);
 * text-like artifacts use the server-rendered, script-free viewer. Nothing is rendered in this origin.
 */
export function Preview({
  token,
  artifact,
  size = 'full',
}: {
  token: string;
  artifact: ArtifactDto;
  size?: 'thumb' | 'full';
}) {
  const [p, setP] = useState<PreviewUrlDto | null>(null);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setP(null);
    setErr(undefined);
    if (artifact.bytesState !== 'available') return;
    api<PreviewUrlDto>(`/artifacts/${artifact.id}/preview-url`, token).then(setP, (e: Error) =>
      setErr(e.message),
    );
  }, [token, artifact.id, artifact.bytesState]);

  if (artifact.bytesState !== 'available') {
    const reason = String(
      artifact.metadata.missingReason ??
        artifact.metadata.uploadErrorDetail ??
        artifact.metadata.uploadError ??
        artifact.bytesState,
    );
    return (
      <div className={`preview missing ${size}`} role="note">
        <strong>{artifact.bytesState === 'pending' ? 'Bytes pending' : 'Missing'}</strong>
        <span>{reason}</span>
      </div>
    );
  }
  if (err) return <div className={`preview error ${size}`}>Preview unavailable: {err}</div>;
  if (!p) return <div className={`preview loading ${size}`}>Loading…</div>;
  const mt = artifact.mediaType;
  if (mt.startsWith('image/') && mt !== 'image/svg+xml') {
    return (
      <img
        className={`preview img ${size}`}
        src={p.url}
        alt={`${artifact.role} ${artifact.logicalName}`}
        loading="lazy"
      />
    );
  }
  if (mt.startsWith('video/'))
    return <video className={`preview ${size}`} src={p.url} controls preload="metadata" />;
  if (p.viewer === 'text') {
    return (
      <iframe
        className={`preview frame ${size}`}
        title={`Contents of ${artifact.logicalName}`}
        src={p.url}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    );
  }
  if (mt === 'text/html' || mt === 'image/svg+xml') {
    return (
      <iframe
        className={`preview frame ${size}`}
        title={`Isolated preview of ${artifact.logicalName}`}
        src={p.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        data-isolated="true"
      />
    );
  }
  return (
    <div className={`preview other ${size}`}>
      <span>{mt}</span>
      <a href={p.url} target="_blank" rel="noopener noreferrer">
        Open in isolated tab
      </a>
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}
