import { useEffect, useState } from 'react';

export function OrderPage({ id }: { id: string }) {
  const [order, setOrder] = useState<{ status: string } | null>(null);
  useEffect(() => {
    void fetch(`/orders/${id}`)
      .then((res) => res.json())
      .then(setOrder);
  }, [id]);
  return <p>{order ? order.status : 'Loading…'}</p>;
}
