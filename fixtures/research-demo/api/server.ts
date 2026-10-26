import Fastify from 'fastify';
import { Queue } from 'bullmq';

export const RESEARCH_QUEUE = 'research-jobs';
const queue = new Queue(RESEARCH_QUEUE, { connection: { url: process.env.REDIS_URL } });
const app = Fastify();

app.post('/research', async (req) => {
  const { topic } = req.body as { topic: string };
  const job = await queue.add('report', { topic });
  return { jobId: job.id };
});

app.get('/reports/:id', async (req) => ({ id: (req.params as { id: string }).id }));

app.listen({ port: 8080 });
