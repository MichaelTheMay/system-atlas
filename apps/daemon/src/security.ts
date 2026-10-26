import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** DNS-rebinding defence: Host must be a loopback name on our port. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return LOOPBACK_HOSTS.some((h) => hostHeader === `${h}:${port}`);
}

/** CSRF defence: if a browser sends Origin, it must be our own origin or an explicitly allowed dev origin. */
export function isAllowedOrigin(
  origin: string | undefined,
  port: number,
  extra: readonly string[],
): boolean {
  if (origin === undefined) return true; // non-browser clients (CLI, SDK) still need the token
  const own = LOOPBACK_HOSTS.map((h) => `http://${h}:${port}`);
  return own.includes(origin) || extra.includes(origin);
}

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}
