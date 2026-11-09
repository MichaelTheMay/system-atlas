import { listProducts } from '@shop/catalog';

export async function searchProducts(term: string) {
  const all = await listProducts();
  return all.filter((p: { name: string }) => p.name.toLowerCase().includes(term.toLowerCase()));
}
