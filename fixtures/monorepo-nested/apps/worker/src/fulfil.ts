import { sendReceipt } from '@shop/email';
import { getOrder, markPaid } from '@shop/orders';
import { charge } from '@shop/payments';

export async function fulfil(orderId: string) {
  const order = await getOrder(orderId);
  if (await charge(orderId, order.total_cents)) {
    await markPaid(orderId);
    await sendReceipt(orderId);
  }
}
