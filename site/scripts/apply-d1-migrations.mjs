import { spawnSync } from 'node:child_process';

const productionBranch = 'main';
const currentBranch = process.env.CF_PAGES_BRANCH;

if (currentBranch !== productionBranch) {
  console.log(`D1 migration skipped: CF_PAGES_BRANCH=${currentBranch || '(not set)'}`);
  process.exit(0);
}

for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (!process.env[name]) {
    console.error(`D1 migration failed: ${name} is not configured in Cloudflare Pages build variables.`);
    process.exit(1);
  }
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'db:migrate'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CI: 'true',
  },
});

if (result.error) {
  console.error(`D1 migration failed: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
