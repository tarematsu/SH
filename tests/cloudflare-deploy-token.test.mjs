import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
);

const deployTokenExpression = "secrets['CLOUDFLARE_API_TOKEN'] || secrets['CF_API_TOKEN'] || secrets['CLOUDFLARE_BUILDS_API_TOKEN']";

test('production deployment prefers write-scoped Cloudflare tokens', () => {
  assert.equal(workflow.split(deployTokenExpression).length - 1, 2);
  assert.doesNotMatch(
    workflow,
    /secrets\['CLOUDFLARE_BUILDS_API_TOKEN'\]\s*\|\|\s*secrets\['CLOUDFLARE_API_TOKEN'\]/,
  );
});
