/**
 * Media type from content (plan §11 MIME sniffing). The declared type is never trusted for
 * rendering decisions: an "image/png" that is really HTML must be treated as HTML.
 */
export function sniffMediaType(head: Buffer, declared?: string): string {
  const starts = (sig: number[]) => sig.every((b, i) => head[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    head.subarray(0, 6).toString('latin1') === 'GIF87a' ||
    head.subarray(0, 6).toString('latin1') === 'GIF89a'
  )
    return 'image/gif';
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (starts([0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (head.includes(0)) return 'application/octet-stream';
  const text = head.toString('utf8').trimStart().slice(0, 512).toLowerCase();
  if (
    /^(<!doctype html|<html|<head|<body|<script|<iframe)/.test(text) ||
    /<(script|iframe|object|embed)[\s>]/.test(text)
  )
    return 'text/html';
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg')))
    return 'image/svg+xml';
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(head.toString('utf8'));
      return 'application/json';
    } catch {
      if (declared === 'application/json') return 'application/json';
    }
  }
  if (declared && /^text\/(csv|plain|markdown)$/.test(declared)) return declared;
  return 'text/plain';
}

/** Types that may execute script when rendered as a document; previews must isolate them. */
export function isActiveContent(mediaType: string): boolean {
  return (
    mediaType === 'text/html' ||
    mediaType === 'image/svg+xml' ||
    mediaType === 'application/xhtml+xml'
  );
}
