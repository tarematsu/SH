import { spawnSync } from 'node:child_process';

const roots = ['collector', 'worker', 'site', 'tools', 'scripts', 'tests'];
const listed = spawnSync('git', ['ls-files', ...roots], { encoding: 'utf8' });

if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'git ls-files failed\n');
  process.exit(listed.status || 1);
}

const files = listed.stdout
  .split(/\r?\n/)
  .filter((file) => /\.(?:mjs|js)$/.test(file))
  .filter((file) => !file.includes('/node_modules/'))
  .sort();

for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) {
    process.stderr.write(checked.stdout);
    process.stderr.write(checked.stderr);
    process.exit(checked.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
