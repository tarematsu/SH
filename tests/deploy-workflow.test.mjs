import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deployWorkflow = readFileSync(
  new URL('../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);

test('all Cloudflare deploy targets accept the builds API token fallback', () => {
  const fallback = 'secrets.CLOUDFLARE_API_TOKEN || secrets.CLOUDFLARE_BUILDS_API_TOKEN || secrets.CF_API_TOKEN';
  const occurrences = deployWorkflow.split(fallback).length - 1;

  assert.match(deployWorkflow, /wrangler pages deploy/);
  assert.match(deployWorkflow, /npm run deploy:buddies/);
  assert.match(deployWorkflow, /npm run deploy:other/);
  assert.match(deployWorkflow, /npm run deploy:minute/);
  assert.equal(occurrences, 4);
});
