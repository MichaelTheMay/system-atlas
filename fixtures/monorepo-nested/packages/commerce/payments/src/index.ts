import { getJson } from '@shop/http';
import { log } from '@shop/logger';

export async function charge(orderId: string, cents: number): Promise<boolean> {
  log('charging', { orderId, cents });
  const res = await getJson<{ ok: boolean }>(`https://payments.example.invalid/charge/${orderId}`);
  return res.ok;
}
