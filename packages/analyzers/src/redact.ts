/**
 * Best-effort redaction for evidence excerpts (plan §14). Filename-based secret skipping does not
 * catch credentials embedded in ordinary files, so every excerpt passes through here before it is
 * stored. Pattern filters are best effort, which is why excerpts stay short.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
];
const ASSIGNMENT =
  /((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

export function redactExcerpt(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const re of PATTERNS)
    out = out.replace(re, (m, p1: string) =>
      re.source.startsWith('([a-z]') ? `${p1}[REDACTED]@` : '[REDACTED]',
    );
  out = out.replace(ASSIGNMENT, (_m, k: string) => `${k}[REDACTED]`);
  return { text: out, redacted: out !== text };
}
