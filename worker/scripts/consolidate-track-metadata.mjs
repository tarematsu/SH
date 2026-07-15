import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const sourceDatabase = process.env.OTHER_DATABASE_NAME || 'stationhead-other';
const targetDatabase = process.env.BUDDIES_DATABASE_NAME || 'stationhead-buddies';
const configuredPageSize = Number(process.env.TRACK_METADATA_PAGE_SIZE || 200);
const pageSize = Number.isFinite(configuredPageSize)
  ? Math.max(1, Math.min(500, Math.trunc(configuredPageSize)))
  : 200;
const apply = String(process.env.TRACK_METADATA_APPLY || '').toLowerCase() === 'true';
const dropSource = String(process.env.TRACK_METADATA_DROP_SOURCE || '').toLowerCase() === 'true';
const columns = [
  'spotify_id', 'title', 'artist', 'display_title', 'thumbnail_url',
  'spotify_url', 'source', 'fetched_at', 'raw_json',
];

if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN is required');
}
if (dropSource && !apply) {
  throw new Error('TRACK_METADATA_DROP_SOURCE=true requires TRACK_METADATA_APPLY=true');
}

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) throw new Error(`Wrangler did not return JSON: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(Math.min(...starts)));
}

function rowsFrom(payload) {
  const containers = Array.isArray(payload) ? payload : [payload];
  return containers.flatMap((container) => (
    container?.results || container?.result?.[0]?.results || container?.result?.results || []
  ));
}

function execute(database, command) {
  return parseJsonOutput(wrangler([
    'd1', 'execute', database,
    '--remote', '--yes', '--json', '--command', command,
  ]));
}

function executeDdl(database, command) {
  wrangler([
    'd1', 'execute', database,
    '--remote', '--yes', '--command', command,
  ]);
}

function countRows(database) {
  const rows = rowsFrom(execute(database, 'SELECT COUNT(*) AS row_count FROM sh_track_metadata'));
  return Number(rows[0]?.row_count || 0);
}

function quote(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sourcePage(offset) {
  return rowsFrom(execute(
    sourceDatabase,
    `SELECT ${columns.join(',')} FROM sh_track_metadata
     ORDER BY spotify_id LIMIT ${pageSize} OFFSET ${offset}`,
  ));
}

function writePage(database, rows, directory, page) {
  const statements = rows.map((row) => `INSERT INTO sh_track_metadata(${columns.join(',')}) VALUES(${columns.map((column) => quote(row[column])).join(',')})
ON CONFLICT(spotify_id) DO UPDATE SET
  title=COALESCE(sh_track_metadata.title,excluded.title),
  artist=COALESCE(sh_track_metadata.artist,excluded.artist),
  display_title=COALESCE(sh_track_metadata.display_title,excluded.display_title),
  thumbnail_url=COALESCE(sh_track_metadata.thumbnail_url,excluded.thumbnail_url),
  spotify_url=COALESCE(sh_track_metadata.spotify_url,excluded.spotify_url),
  source=COALESCE(sh_track_metadata.source,excluded.source),
  fetched_at=MAX(sh_track_metadata.fetched_at,excluded.fetched_at),
  raw_json=COALESCE(sh_track_metadata.raw_json,excluded.raw_json);`);
  const sqlPath = join(directory, `track-metadata-${page}.sql`);
  writeFileSync(sqlPath, `BEGIN;\n${statements.join('\n')}\nCOMMIT;\n`, 'utf8');
  wrangler([
    'd1', 'execute', targetDatabase,
    '--remote', '--yes', '--file', sqlPath,
  ]);
}

let sourceCount;
try {
  sourceCount = countRows(sourceDatabase);
} catch (error) {
  if (/no such table:\s*sh_track_metadata/i.test(String(error?.message || error))) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'source-table-missing' }));
    process.exit(0);
  }
  throw error;
}

const targetBefore = countRows(targetDatabase);
if (!apply || sourceCount === 0) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    source_database: sourceDatabase,
    target_database: targetDatabase,
    source_rows: sourceCount,
    target_rows_before: targetBefore,
    drop_source: false,
  }));
  process.exit(0);
}

const tempDirectory = mkdtempSync(join(workerRoot, '.track-metadata-'));
try {
  let copied = 0;
  for (let offset = 0, page = 0; offset < sourceCount; offset += pageSize, page += 1) {
    const rows = sourcePage(offset);
    if (!rows.length) break;
    writePage(targetDatabase, rows, tempDirectory, page);
    copied += rows.length;
  }

  const targetAfter = countRows(targetDatabase);
  if (targetAfter < sourceCount) {
    throw new Error(`Target metadata count ${targetAfter} is smaller than source count ${sourceCount}`);
  }
  if (dropSource) {
    executeDdl(sourceDatabase, 'DROP TABLE IF EXISTS sh_track_metadata');
  }
  console.log(JSON.stringify({
    ok: true,
    applied: true,
    source_database: sourceDatabase,
    target_database: targetDatabase,
    source_rows: sourceCount,
    copied_rows: copied,
    target_rows_before: targetBefore,
    target_rows_after: targetAfter,
    drop_source: dropSource,
  }));
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
