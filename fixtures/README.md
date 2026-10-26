# Fixtures

Small, deterministic systems used to test Atlas. Atlas analysis must never modify, install or
execute them; tests assert their content hash is unchanged after registration and scanning.

| Fixture | Shape | Used by |
|---|---|---|
| `ts-web-service` | TS monorepo: React UI, Fastify API, BullMQ worker, Redis queue, Postgres tables, Docker Compose | A03-A07, Phase 1 acceptance |
| `py-cli-api` | Python package: FastAPI API, argparse CLI, export job, SQLite store | A03-A07, Phase 1 acceptance |

Hand-authored expected graphs (`expected.json`) are added with the analyzers in A04 and are
written independently of extractor output (plan §16).
