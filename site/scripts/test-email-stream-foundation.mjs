import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const stateDirectory = path.resolve('.wrangler-email-foundation-test-state');
const migrationRunner = path.resolve('scripts/apply-d1-migrations.mjs');
const wranglerScript = path.resolve('node_modules/wrangler/bin/wrangler.js');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

rmSync(stateDirectory, { recursive: true, force: true });

try {
  run(process.execPath, [migrationRunner], {
    ...process.env,
    CI: 'true',
    CF_PAGES_BRANCH: 'main',
    D1_MIGRATION_NAME: '003_email_stream_snapshots.sql',
    D1_MIGRATION_TARGET: 'local',
    D1_MIGRATION_PERSIST_TO: stateDirectory,
  });

  run(process.execPath, [wranglerScript, ...[
    'd1', 'execute', 'sh-monitor',
    '--local', '--persist-to', stateDirectory,
    '--command', `INSERT INTO sh_email_stream_snapshots (
      source_key,week_of,email_sent_at,effective_at,stream_count,source,
      validation_status,timing_basis,timing_offset_minutes,reference_source,
      estimated_stream_count,difference,relative_difference,nearest_distance_minutes,
      validation_notes,imported_at
    ) VALUES (
      'stationhead-email:2026-06-29','2026-06-29',1751212800000,1751209380000,123456,
      'stationhead_email_recap','series_plausible','email_sent_minus_offset',57,
      'daily_end',123000,456,0.0037,12.5,'{}',1751212800000
    );
    SELECT source_key,week_of,stream_count,validation_status
    FROM sh_email_stream_snapshots
    WHERE source_key='stationhead-email:2026-06-29';`,
  ]]);
} finally {
  rmSync(stateDirectory, { recursive: true, force: true });
}
