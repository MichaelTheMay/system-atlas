import Fastify from 'fastify';
import { registerOrderRoutes } from './routes/orders.ts';
import { registerProductRoutes } from './routes/products.ts';

const app = Fastify();
registerOrderRoutes(app);
registerProductRoutes(app);

app.listen({ port: 8080, host: '0.0.0.0' });
