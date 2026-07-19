# Pages read-model KV path

The Pages read-model Worker publishes the small six-hour materialized API responses to Workers KV. Pages reads them through a zero-cost Service Binding only after a Cache API miss.

The large `track-history` response remains in D1 because its chunked publication path can approach the 25 MiB KV value limit and should be measured separately before migration.

## Free-plan budget

- 8 six-hour response keys × 4 writes/day = 32 writes/day
- 1 daily host-summary key × 1 write/day = 1 write/day
- Expected steady-state KV writes: 33/day, below the 1,000/day free limit
- KV reads occur only after Cache API misses; materialized responses use up to a 30-minute edge TTL
- KV failures and quota exhaustion fall back to the existing D1 manifest/chunk format

The service binding does not add a separately billed Worker request. KV values are read as streams to minimize CPU and avoid JSON decoding in the serving path.
