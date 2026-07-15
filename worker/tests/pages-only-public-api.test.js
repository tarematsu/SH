import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CONFIG_PATHS = [
  '../wrangler.jsonc',
  '../wrangler.minute.jsonc',
  '../wrangler.other.jsonc',
];

test('scheduled Workers cannot publish workers.dev or preview URLs', () => {
  for (const path of CONFIG_PATHS) {
    const config = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    assert.equal(config.workers_dev, false, `${config.name} workers.dev must remain disabled`);
    assert.equal(config.preview_urls, false, `${config.name} preview URLs must remain disabled`);
    assert.equal(Object.hasOwn(config, 'route'), false, `${config.name} must not own a public route`);
    assert.equal(Object.hasOwn(config, 'routes'), false, `${config.name} must not own public routes`);
  }
});

test('public API ownership documentation points to Pages', () => {
  const documentation = readFileSync(
    new URL('../../site/functions/api/README.md', import.meta.url),
    'utf8',
  );
  assert.match(documentation, /All public HTTP APIs are owned by Cloudflare Pages/);
  assert.match(documentation, /Do not add public HTTP routes to Worker entrypoints/);
});
