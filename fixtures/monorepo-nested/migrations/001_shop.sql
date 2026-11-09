CREATE TABLE products (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  total_cents INTEGER NOT NULL
);

CREATE TABLE order_items (
  order_id UUID NOT NULL REFERENCES orders(id),
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL
);
