import { useEffect, useState } from 'react';
import { banner } from '@shop/cms';

export function ProductsPage() {
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void fetch('/products')
      .then((res) => res.json())
      .then(setProducts);
  }, []);
  return (
    <main>
      <h1>{banner().title}</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </ul>
    </main>
  );
}
