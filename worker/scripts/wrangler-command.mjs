import { fileURLToPath } from 'node:url';

export const WRANGLER_SCRIPT = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);

export function wranglerCommand(
  args = [],
  { nodeExecutable = process.execPath, scriptPath = WRANGLER_SCRIPT } = {},
) {
  return {
    executable: nodeExecutable,
    args: [scriptPath, ...args],
  };
}
