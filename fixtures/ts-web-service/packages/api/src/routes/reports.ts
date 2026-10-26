import type { FastifyInstance } from 'fastify';
import { insertReport, getReport } from '../db.ts';
import { enqueueReport } from '../queue.ts';

export function registerReportRoutes(app: FastifyInstance) {
  app.post('/reports', async (req) => {
    const { topic } = req.body as { topic: string };
    const report = await insertReport(topic);
    await enqueueReport(report.id);
    return report;
  });

  app.get('/reports/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getReport(id);
  });
}
