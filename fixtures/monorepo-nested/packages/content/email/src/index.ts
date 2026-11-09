import { log } from '@shop/logger';

export async function sendReceipt(orderId: string) {
  log('receipt sent', { orderId });
}
