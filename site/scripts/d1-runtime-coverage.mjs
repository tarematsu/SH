import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const RUNTIME_MIGRATION_COVERAGE = {
  '127_add_secondary_playback_current.sql': {
    runtime_file: 'worker/src/buddy-runtime.js',
    required_tables: ['sh_playback_channel_current'],
  },
};

export function changedMigrationNames(repositoryRoot) {
  const result = spawnSync('git', [
    'diff-tree', '--no-commit-id', '--name-only', '--diff-filter=AM', '-r',
    'HEAD', '--', 'database/migrations',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot inspect changed migrations: ${result.error?.message || result.stderr || `git exited ${result.status}`}`);
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.basename(value))
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name));
}

export function uncoveredRuntimeMigrations(names, coverage = RUNTIME_MIGRATION_COVERAGE) {
  return names.filter((name) => !coverage[name]);
}

function createdTables(sql) {
  return [...String(sql).matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)]
    .map((match) => match[1]);
}

export function assertRuntimeMigrationCoverage(repositoryRoot, names = null) {
  const changed = names || changedMigrationNames(repositoryRoot);
  const uncovered = uncoveredRuntimeMigrations(changed);
  if (uncovered.length) {
    throw new Error(`tokenless D1 build has changed migrations without runtime coverage: ${uncovered.join(', ')}`);
  }

  for (const migrationName of changed) {
    const definition = RUNTIME_MIGRATION_COVERAGE[migrationName];
    if (!definition) continue;
    const migrationPath = path.join(repositoryRoot, 'database', 'migrations', migrationName);
    const runtimePath = path.join(repositoryRoot, definition.runtime_file);
    if (!existsSync(migrationPath)) {
      throw new Error(`changed migration file is missing: ${migrationName}`);
    }
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
