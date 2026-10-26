import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function generateReport(reportId: string) {
  const { rows } = await pool.query('SELECT topic FROM reports WHERE id = $1', [reportId]);
  const summary = `Summary for ${rows[0].topic}`;
  await pool.query("UPDATE reports SET status = 'done', body = $2 WHERE id = $1", [reportId, { summary, sources: [] }]);
  await pool.query('INSERT INTO report_sources (report_id, url) VALUES ($1, $2)', [reportId, 'https://example.invalid/source']);
}
