import { Worker } from 'bullmq';
import { ORDER_QUEUE, env } from '@shop/config';
import { fulfil } from './fulfil.ts';

new Worker(ORDER_QUEUE, async (job) => fulfil(job.data.orderId), {
  connection: { url: env('REDIS_URL') },
});
