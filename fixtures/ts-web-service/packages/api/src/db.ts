import pg from 'pg';
import type { Report } from '@reports/shared';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function insertReport(topic: string): Promise<Report> {
  const { rows } = await pool.query('INSERT INTO reports (id, topic) VALUES (gen_random_uuid(), $1) RETURNING *', [topic]);
  return rows[0];
}

export async function getReport(id: string): Promise<Report | undefined> {
  const { rows } = await pool.query('SELECT * FROM reports WHERE id = $1', [id]);
  return rows[0];
}
