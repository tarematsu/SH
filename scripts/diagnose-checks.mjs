import { spawnSync } from 'node:child_process';

const commands = [
  ['npm', ['run', 'check:js']],
  ['npm', ['run', 'test:js']],
  ['npm', ['run', 'test:sql']],
  ['npm', ['run', 'check:worker-bundle']],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status === 0) continue;
  const lines = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n');
  console.error(lines.slice(-160).join('\n'));
  process.exit(result.status || 1);
}
