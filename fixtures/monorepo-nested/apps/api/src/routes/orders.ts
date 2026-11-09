import type { FastifyInstance } from 'fastify';
import { verifyToken } from '@shop/auth';
import { getOrder, placeOrder } from '@shop/orders';

export function registerOrderRoutes(app: FastifyInstance) {
  app.post('/orders', async (req, reply) => {
    if (!verifyToken(req.headers.authorization)) return reply.code(401).send();
    const { items } = req.body as { items: Parameters<typeof placeOrder>[0] };
    return placeOrder(items);
  });

  app.get('/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getOrder(id);
  });
}
