# KV read-model rollout

1. Run `npm run deploy:pages-read-model`. The deploy helper lists the existing `sh-pages-read-model-pages-response-kv` namespace, creates it only when absent, injects the resolved namespace ID into an ephemeral Wrangler config, and removes that file after deployment.
2. Deploy Pages with the `PAGES_READ_MODEL_SERVICE` binding.
3. Confirm `x-api-source: worker-kv` on a six-hour materialized endpoint after an edge-cache miss.
4. Monitor KV reads/writes, Worker CPU, and D1 rows read/written. The expected KV write rate is 33/day.
5. Leave `track-history` on D1 until its encoded response size and publication CPU are measured below safe KV limits.

The Pages read-model entry recognizes `stationhead-read-model` batches and delegates them to the existing minute read-model handler. This does not add that Queue consumer, but prevents message corruption if an overlapping deployment temporarily leaves the consumer attached while Worker-consolidation changes are being tested.

Rollback is configuration-safe: remove or disable the service binding, or allow KV operations to fail. Pages then uses the existing D1 manifest/chunk response and finally the live API handler.
