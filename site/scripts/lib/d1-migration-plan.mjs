import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const GRANDFATHERED_DUPLICATE_MIGRATION_GROUPS = new Set([
  '005_cloud_host_monitor.sql|005_weekly_summary_foundation.sql',
  '008_buddy_auth_control.sql|008_runtime_query_indexes.sql',
  '019_collector_failure_diagnostics.sql|019_comment_counts.sql',
]);

export function assertSafeMigrationNumbering({ migrationsDirectory, grandfatheredGroups = GRANDFATHERED_DUPLICATE_MIGRATION_GROUPS }) {
  const files = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name))
    .sort();
  const byNumber = new Map();
  for (const file of files) {
    const number = file.match(/^(\d+)_/)?.[1];
    if (!number) continue;
    const group = byNumber.get(number) || [];
    group.push(file);
    byNumber.set(number, group);
  }
  const unexpected = [...byNumber.entries()]
    .filter(([, filesForNumber]) => filesForNumber.length > 1)
    .filter(([, filesForNumber]) => !grandfatheredGroups.has([...filesForNumber].sort().join('|')));
  if (unexpected.length) {
    const details = unexpected
      .map(([number, filesForNumber]) => `${number}: ${filesForNumber.join(', ')}`)
      .join('; ');
    throw new Error(`unsafe duplicate D1 migration numbers detected: ${details}`);
  }
}

export function validateMigrationName(migrationName) {
  if (!/^\d+_[A-Za-z0-9._-]+\.sql$/.test(migrationName) || path.basename(migrationName) !== migrationName) {
    throw new Error(`invalid D1_MIGRATION_NAME=${migrationName}`);
  }
}

export function createSingleMigrationConfig({ siteDirectory, wranglerConfigPath, migrationsDirectory, migrationName }) {
  validateMigrationName(migrationName);
  const sourceMigration = path.join(migrationsDirectory, migrationName);
  if (!existsSync(sourceMigration)) throw new Error(`migration file not found: ${sourceMigration}`);

  const temporaryName = `.single-d1-migration-${process.pid}-${Date.now()}`;
  const temporaryDirectory = path.join(siteDirectory, temporaryName);
  const temporaryConfigPath = path.join(siteDirectory, `${temporaryName}.jsonc`);
  mkdirSync(temporaryDirectory, { recursive: false });
  copyFileSync(sourceMigration, path.join(temporaryDirectory, migrationName));

  const baseConfig = JSON.parse(readFileSync(wranglerConfigPath, 'utf8'));
  const temporaryConfig = {
    ...baseConfig,
    d1_databases: baseConfig.d1_databases.map((entry) => (
      entry.database_name === 'stationhead-monitor'
        ? { ...entry, migrations_dir: temporaryName }
        : entry
    )),
  };
  writeFileSync(temporaryConfigPath, `${JSON.stringify(temporaryConfig, null, 2)}\n`, 'utf8');
  return { configPath: temporaryConfigPath, temporaryConfigPath, temporaryDirectory };
}

export function migrationApplyArgs({ target, configPath, persistTo = process.env.D1_MIGRATION_PERSIST_TO }) {
  const args = [
    'd1', 'migrations', 'apply', 'stationhead-monitor',
    target === 'local' ? '--local' : '--remote',
    '--config', configPath,
  ];
  if (target === 'local' && persistTo) {
    args.push('--persist-to', path.resolve(persistTo));
  }
  return args;
}
