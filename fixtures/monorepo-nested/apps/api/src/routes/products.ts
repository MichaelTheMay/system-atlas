import type { FastifyInstance } from 'fastify';
import { listProducts } from '@shop/catalog';
import { searchProducts } from '@shop/search';

export function registerProductRoutes(app: FastifyInstance) {
  app.get('/products', async (req) => {
    const { q } = req.query as { q?: string };
    return q ? searchProducts(q) : listProducts();
  });
}
