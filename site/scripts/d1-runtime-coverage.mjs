import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const TOKENLESS_MIGRATION_BASELINE = 126;
export const RUNTIME_MIGRATION_COVERAGE = {
  '127_add_secondary_playback_current.sql': {
    runtime_file: 'worker/src/buddy-runtime.js',
    required_tables: ['sh_playback_channel_current'],
  },
};

export function migrationNumber(name) {
  const match = String(name || '').match(/^(\d+)_/);
  return match ? Number(match[1]) : null;
}

export function uncoveredRuntimeMigrations(names, coverage = RUNTIME_MIGRATION_COVERAGE) {
  return names
    .filter((name) => {
      const number = migrationNumber(name);
      return number != null && number > TOKENLESS_MIGRATION_BASELINE;
    })
    .filter((name) => !coverage[name]);
}

function createdTables(sql) {
  return [...String(sql).matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)]
    .map((match) => match[1]);
}

export function assertRuntimeMigrationCoverage(repositoryRoot) {
  const migrationsDirectory = path.join(repositoryRoot, 'database', 'migrations');
  const names = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name))
    .sort();
  const uncovered = uncoveredRuntimeMigrations(names);
  if (uncovered.length) {
    throw new Error(`tokenless D1 build has migrations without runtime coverage: ${uncovered.join(', ')}`);
  }

  for (const [migrationName, definition] of Object.entries(RUNTIME_MIGRATION_COVERAGE)) {
    if (!names.includes(migrationName)) continue;
    const migrationPath = path.join(migrationsDirectory, migrationName);
    const runtimePath = path.join(repositoryRoot, definition.runtime_file);
    if (!existsSync(runtimePath)) {
      throw new Error(`runtime migration coverage file is missing: ${definition.runtime_file}`);
    }
    const migrationSql = readFileSync(migrationPath, 'utf8');
    const runtimeSource = readFileSync(runtimePath, 'utf8');
    const tables = createdTables(migrationSql);
    for (const table of definition.required_tables) {
      if (!tables.includes(table)) {
        throw new Error(`${migrationName} no longer creates required table ${table}`);
      }
      if (!runtimeSource.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) {
        throw new Error(`${definition.runtime_file} does not bootstrap ${table}`);
      }
    }
    const unexpectedTables = tables.filter((table) => !definition.required_tables.includes(table));
    if (unexpectedTables.length) {
      throw new Error(`${migrationName} creates tables without declared runtime coverage: ${unexpectedTables.join(', ')}`);
    }
  }
  return true;
}
