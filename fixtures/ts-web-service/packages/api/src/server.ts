import Fastify from 'fastify';
import { registerReportRoutes } from './routes/reports.ts';

const app = Fastify();
registerReportRoutes(app);
app.get('/health', async () => ({ ok: true }));

app.listen({ port: 8080, host: '0.0.0.0' });
