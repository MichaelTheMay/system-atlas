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

/**
 * Redact every string inside a JSON-like value (event payloads, environment summaries).
 * Keys that name secrets are withheld entirely rather than pattern-filtered.
 */
const SECRET_KEY =
  /(pass(word)?|secret|token|api[_-]?key|auth|cookie|session|credential|private[_-]?key)/i;

export function redactValue<T>(value: T): { value: T; redacted: boolean } {
  let redacted = false;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SECRET_KEY.test(key)) {
        redacted = true;
        return '[REDACTED]';
      }
      const r = redactExcerpt(v);
      if (r.redacted) redacted = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]),
      );
    return v;
  };
  return { value: walk(value) as T, redacted };
}

/** Remove credentials and sensitive query parameters from a URL before it is stored. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_KEY.test(k) || /^(code|state|sig|signature|key|access_token|id_token)$/i.test(k))
        u.searchParams.set(k, '[REDACTED]');
    }
    return u.toString();
  } catch {
    return redactExcerpt(url).text;
  }
}
