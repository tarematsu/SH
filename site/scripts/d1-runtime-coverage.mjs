import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TOKENLESS_SCHEMA_BASELINE = 'a835cdf3619970af7e3e82fa8d77187376dafd11';
export const DATA_ONLY_MIGRATIONS = new Set([
  '106_drop_stale_validated_stream_trigger.sql',
  '105_backfill_comment_velocity_history.sql',
  '129_add_queue_reachability_index.sql',
]);
export const RUNTIME_MIGRATION_COVERAGE = {
  '008_buddy_auth_control.sql': {
    runtime_file: 'worker/src/auth-state.js',
    required_tables: ['sh_worker_auth_control'],
    allowed_statement_prefixes: ['INSERT OR IGNORE INTO sh_worker_auth_control'],
    runtime_fragments: ['INSERT OR IGNORE INTO sh_worker_auth_control'],
  },
  '127_add_secondary_playback_current.sql': {
    runtime_file: 'worker/src/buddy-runtime.js',
    required_tables: ['sh_playback_channel_current'],
  },
  '128_add_collector_status.sql': {
    runtime_file: 'worker/src/buddy-health.js',
    required_tables: ['sh_collector_status'],
  },
  '130_add_primary_run_lock.sql': {
    runtime_file: 'worker/src/primary-run-lock.js',
    required_tables: ['sh_primary_run_lock'],
  },
};

function gitOutput(repositoryRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '');
}

function migrationNames(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.basename(value))
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name));
}

export function changedMigrationNames(repositoryRoot) {
  const baselineOutput = gitOutput(repositoryRoot, [
    'diff', '--name-only', '--diff-filter=A',
    `${TOKENLESS_SCHEMA_BASELINE}..HEAD`, '--', 'database/migrations',
  ]);
  if (baselineOutput != null) return migrationNames(baselineOutput);

  const headOutput = gitOutput(repositoryRoot, [
    'diff', '--name-only', '--diff-filter=A',
    'HEAD^..HEAD', '--', 'database/migrations',
  ]);
  return headOutput == null ? [] : migrationNames(headOutput);
}

export function uncoveredRuntimeMigrations(names, coverage = RUNTIME_MIGRATION_COVERAGE) {
  return [...new Set(names)].filter((name) => !coverage[name] && !DATA_ONLY_MIGRATIONS.has(name));
}

function migrationStatements(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function createdTables(sql) {
  return [...String(sql).matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)]
    .map((match) => match[1]);
}

export function assertRuntimeMigrationCoverage(repositoryRoot, names = null) {
  const changed = [...new Set(names || changedMigrationNames(repositoryRoot))];
  const uncovered = uncoveredRuntimeMigrations(changed);
  if (uncovered.length) {
    throw new Error(`tokenless D1 build has changed migrations without runtime coverage: ${uncovered.join(', ')}`);
  }

  for (const migrationName of changed) {
    if (DATA_ONLY_MIGRATIONS.has(migrationName)) continue;
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
    const allowedStatements = [
      ...definition.required_tables.map(
      (table) => new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i'),
      ),
      ...(definition.allowed_statement_prefixes || []).map(
        (prefix) => new RegExp(`^${prefix}\\b`, 'i'),
      ),
    ];
    const unsupported = migrationStatements(migrationSql)
      .filter((statement) => !allowedStatements.some((pattern) => pattern.test(statement)));
    if (unsupported.length) {
      throw new Error(`${migrationName} contains statements without runtime coverage`);
    }
    for (const table of definition.required_tables) {
      if (!tables.includes(table)) {
        throw new Error(`${migrationName} no longer creates required table ${table}`);
      }
      if (!runtimeSource.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) {
        throw new Error(`${definition.runtime_file} does not bootstrap ${table}`);
      }
    }
    for (const fragment of definition.runtime_fragments || []) {
      if (!runtimeSource.toUpperCase().includes(fragment.toUpperCase())) {
        throw new Error(`${definition.runtime_file} does not cover ${fragment}`);
      }
    }
    const unexpectedTables = tables.filter((table) => !definition.required_tables.includes(table));
    if (unexpectedTables.length) {
      throw new Error(`${migrationName} creates tables without declared runtime coverage: ${unexpectedTables.join(', ')}`);
    }
  }
  return true;
}
