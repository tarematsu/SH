# KV read-model rollout

1. Deploy `sh-pages-read-model` first so Wrangler provisions the `PAGES_RESPONSE_KV` binding and the internal fetch endpoint is available.
2. Deploy Pages with the `PAGES_READ_MODEL_SERVICE` binding.
3. Confirm `x-api-source: worker-kv` on a six-hour materialized endpoint after an edge-cache miss.
4. Monitor KV reads/writes, Worker CPU, and D1 rows read/written. The expected KV write rate is 33/day.
5. Leave `track-history` on D1 until its encoded response size and publication CPU are measured below safe KV limits.

Rollback is configuration-safe: remove or disable the service binding, or allow KV operations to fail. Pages then uses the existing D1 manifest/chunk response and finally the live API handler.
