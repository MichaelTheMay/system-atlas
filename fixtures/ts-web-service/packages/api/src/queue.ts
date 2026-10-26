import { Queue } from 'bullmq';
import { REPORT_QUEUE } from '@reports/shared';

const queue = new Queue(REPORT_QUEUE, { connection: { url: process.env.REDIS_URL } });

export async function enqueueReport(reportId: string) {
  await queue.add('generate', { reportId });
}
