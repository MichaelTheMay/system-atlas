import { pool } from '@shop/db';

export async function listProducts() {
  const { rows } = await pool.query('SELECT id, name, price_cents FROM products ORDER BY name');
  return rows;
}
