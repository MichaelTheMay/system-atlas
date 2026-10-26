import { Worker } from 'bullmq';
import { REPORT_QUEUE } from '@reports/shared';
import { generateReport } from './generate.ts';

new Worker(REPORT_QUEUE, async (job) => generateReport(job.data.reportId), {
  connection: { url: process.env.REDIS_URL },
});
