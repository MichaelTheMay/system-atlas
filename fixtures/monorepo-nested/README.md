# monorepo-nested

A small shop monorepo, large enough for the system-design lens to nest (D04): four apps, fourteen
packages in three areas, two examples and root-level tool configuration. It is never installed or
run; Atlas only reads it.

- `apps/storefront`, `apps/admin`: React clients that call the API.
- `apps/api`: Fastify service. `POST /orders` stores the order and enqueues `order-jobs`.
- `apps/worker`: consumes `order-jobs`, charges the payment and sends the receipt.
- `packages/commerce`, `packages/platform`, `packages/content`: libraries.
- `examples/`: sample programs, not part of the running system.
