import { log } from '@shop/logger';

export async function getJson<T>(url: string): Promise<T> {
  log('GET', { url });
  const res = await fetch(url);
  return (await res.json()) as T;
}
