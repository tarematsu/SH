import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RENAMED_WORKERS } from '../scripts/retire-renamed-workers.mjs';
import {
  cloudflareBuildConfig,
  renamedCloudflareWorkerReplacement,
} from '../scripts/select-cloudflare-build-config.mjs';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('retired Worker names resolve directly to the deployed canonical script', () => {
  const legacyNames = new Set();
  const replacementNames = new Set();

  for (const { legacy, replacement } of RENAMED_WORKERS) {
    assert.equal(legacyNames.has(legacy), false, `duplicate legacy Worker: ${legacy}`);
    assert.equal(replacementNames.has(replacement), false, `duplicate replacement Worker: ${replacement}`);
    legacyNames.add(legacy);
    replacementNames.add(replacement);

    assert.equal(renamedCloudflareWorkerReplacement(legacy), replacement);
    assert.equal(renamedCloudflareWorkerReplacement(replacement), null,
      `${replacement} must be canonical rather than another rename alias`);

    const configName = cloudflareBuildConfig(legacy);
    assert.ok(configName, `${legacy} must retain a build alias during cutover`);
    assert.equal(cloudflareBuildConfig(replacement), configName);
    assert.equal(config(configName).name, replacement,
      `${configName} must deploy the replacement, not the retired script`);
  }

  for (const replacement of replacementNames) {
    assert.equal(legacyNames.has(replacement), false,
      `${replacement} cannot be both a replacement and a retirement target`);
  }
});
