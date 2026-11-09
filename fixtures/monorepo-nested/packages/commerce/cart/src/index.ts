import { totalCents } from '@shop/pricing';

export interface CartItem {
  productId: string;
  priceCents: number;
  quantity: number;
}

export const cartTotal = (items: CartItem[]) => totalCents(items);
