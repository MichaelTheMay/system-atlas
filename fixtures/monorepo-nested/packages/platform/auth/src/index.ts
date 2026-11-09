import { env } from '@shop/config';
import { log } from '@shop/logger';

export function verifyToken(token: string | undefined): boolean {
  const ok = !!token && token === env('API_TOKEN');
  if (!ok) log('rejected token');
  return ok;
}
