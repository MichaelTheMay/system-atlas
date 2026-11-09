export const totalCents = (items: { priceCents: number; quantity: number }[]) =>
  items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);
