import { cartTotal, type CartItem } from '@shop/cart';

export function CheckoutPage({ items = [] }: { items?: CartItem[] }) {
  async function submit() {
    const res = await fetch('/orders', { method: 'POST', body: JSON.stringify({ items }) });
    const order = await res.json();
    window.location.href = `/orders/${order.id}`;
  }
  return (
    <form onSubmit={(e) => (e.preventDefault(), submit())}>
      <p>Total: {cartTotal(items)}</p>
      <button>Place order</button>
    </form>
  );
}
