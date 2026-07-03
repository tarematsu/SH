// Reuse the Worker-focused integration suite from the repository-level test run.
// This keeps Cloudflare's /worker build and GitHub Actions on the same scenarios.
await import('../worker/tests/collector.integration.test.js');
