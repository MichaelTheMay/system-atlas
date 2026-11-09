import { Queue } from 'bullmq';
import { cartTotal, type CartItem } from '@shop/cart';
import { ORDER_QUEUE, env } from '@shop/config';
import { pool } from '@shop/db';

const queue = new Queue(ORDER_QUEUE, { connection: { url: env('REDIS_URL') } });

export async function placeOrder(items: CartItem[]) {
  const { rows } = await pool.query(
    'INSERT INTO orders (id, total_cents) VALUES (gen_random_uuid(), $1) RETURNING *',
    [cartTotal(items)],
  );
  for (const item of items)
    await pool.query('INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)', [
      rows[0].id,
      item.productId,
      item.quantity,
    ]);
  await queue.add('fulfil', { orderId: rows[0].id });
  return rows[0];
}

export async function getOrder(id: string) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0];
}

export async function markPaid(id: string) {
  await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [id]);
}
