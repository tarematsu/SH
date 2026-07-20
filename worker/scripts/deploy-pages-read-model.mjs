// Compatibility entrypoint: Pages read-model ownership now belongs to the
// consolidated minute-enrichment Worker.
await import('./deploy-minute-enrichment.mjs');
