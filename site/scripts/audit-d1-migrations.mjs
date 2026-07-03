import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(siteDirectory, '..');
const migrationsDirectory = path.join(repositoryRoot, 'database', 'migrations');
const remoteResultPath = path.join(siteDirectory, 'd1-audit-remote.json');
const listOutputPath = path.join(siteDirectory, 'd1-audit-list.txt');
const reportPath = path.join(siteDirectory, 'd1-audit-report.md');
const schemaPath = path.join(siteDirectory, '.d1-audit-schema.sql');
const stateDirectory = path.join(siteDirectory, '.d1-audit-state');
const wrangler = process.platform === 'win32'
  ? path.join(siteDirectory, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(siteDirectory, 'node_modules', '.bin', 'wrangler');

function flattenResults(value) {
  const groups = Array.isArray(value) ? value : [value];
  const rows = [];
  for (const group of groups) {
    if (Array.isArray(group?.results)) rows.push(...group.results);
    else if (Array.isArray(group?.result?.[0]?.results)) rows.push(...group.result[0].results);
  }
  return rows;
}

function runWrangler(args) {
  return spawnSync(wrangler, args, {
    cwd: siteDirectory,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
}

function excerpt(text, maxLines = 40) {
  return String(text || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n')
    .slice(-12000);
}

function collectMatches(sql, expression, group = 1) {
  const values = [];
  for (const match of sql.matchAll(expression)) values.push(match[group]);
  return values.filter(Boolean).map((value) => String(value).replace(/^[`"\[]|[`"\]]$/g, ''));
}

const remotePayload = JSON.parse(readFileSync(remoteResultPath, 'utf8'));
const remoteRows = flattenResults(remotePayload);
if (!remoteRows.length) throw new Error('Remote D1 audit query returned no rows.');

const applied = new Set(
  remoteRows
    .filter((row) => row.kind === 'migration')
    .map((row) => String(row.name)),
);
const schemaRows = remoteRows.filter((row) => row.kind === 'schema' && row.sql);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.+\.sql$/i.test(name))
  .sort((a, b) => a.localeCompare(b, 'en'));
const unapplied = migrationFiles.filter((name) => !applied.has(name));
const appliedRepositoryFiles = migrationFiles.filter((name) => applied.has(name));
const appliedUnknownFiles = [...applied].filter((name) => !migrationFiles.includes(name)).sort();

const typeOrder = new Map([['table', 0], ['view', 1], ['index', 2], ['trigger', 3]]);
const userSchemaRows = schemaRows.filter((row) => {
  const name = String(row.name || '');
  const table = String(row.tbl_name || '');
  return name.startsWith('sh_') || table.startsWith('sh_');
});
const schemaSql = userSchemaRows
  .sort((a, b) => (typeOrder.get(a.type) ?? 9) - (typeOrder.get(b.type) ?? 9) || String(a.name).localeCompare(String(b.name)))
  .map((row) => `${String(row.sql).replace(/;\s*$/, '')};`)
  .join('\n\n');
writeFileSync(schemaPath, `${schemaSql}\n`, 'utf8');

const knownObjects = new Set(
  userSchemaRows
    .filter((row) => row.type === 'table' || row.type === 'view')
    .map((row) => String(row.name).toLowerCase()),
);
const staticFindings = [];
const ignoredNames = new Set([
  'new', 'old', 'excluded', 'seed', 'set', 'of', 'select', 'values',
]);

for (const name of unapplied) {
  const sql = readFileSync(path.join(migrationsDirectory, name), 'utf8');
  const creates = new Set([
    ...collectMatches(sql, /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bCREATE\s+VIEW(?:\s+IF\s+NOT\s+EXISTS)?\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
  ].map((value) => value.toLowerCase()));
  const ctes = new Set(collectMatches(sql, /(?:\bWITH|,)\s*([A-Za-z_][\w]*)\s+AS\s*\(/gi).map((value) => value.toLowerCase()));
  const references = new Set([
    ...collectMatches(sql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+\S+\s+ON\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bCREATE\s+TRIGGER(?:\s+IF\s+NOT\s+EXISTS)?\s+\S+[\s\S]*?\bON\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bALTER\s+TABLE\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bDELETE\s+FROM\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bUPDATE\s+(?!OF\b)([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bFROM\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
    ...collectMatches(sql, /\bJOIN\s+([`"\[]?[A-Za-z_][\w]*[`"\]]?)/gi),
  ].map((value) => value.toLowerCase()));

  const missing = [...references]
    .filter((value) => !ignoredNames.has(value))
    .filter((value) => !ctes.has(value))
    .filter((value) => !knownObjects.has(value) && !creates.has(value))
    .sort();
  if (missing.length) staticFindings.push({ name, missing });
  for (const created of creates) knownObjects.add(created);
}

rmSync(stateDirectory, { recursive: true, force: true });
mkdirSync(stateDirectory, { recursive: true });
let schemaImportError = null;
let firstBlockingError = null;
const simulatedSuccessfully = [];

const schemaImport = runWrangler([
  'd1', 'execute', 'stationhead-monitor', '--local',
  '--persist-to', stateDirectory,
  '--file', schemaPath,
  '--config', path.join(siteDirectory, 'wrangler.jsonc'),
]);
if (schemaImport.status !== 0) {
  schemaImportError = excerpt(`${schemaImport.stdout}\n${schemaImport.stderr}`);
} else {
  for (const name of unapplied) {
    const result = runWrangler([
      'd1', 'execute', 'stationhead-monitor', '--local',
      '--persist-to', stateDirectory,
      '--file', path.join(migrationsDirectory, name),
      '--config', path.join(siteDirectory, 'wrangler.jsonc'),
    ]);
    if (result.status !== 0) {
      firstBlockingError = {
        name,
        output: excerpt(`${result.stdout}\n${result.stderr}`),
      };
      break;
    }
    simulatedSuccessfully.push(name);
  }
}

const migrationListOutput = readFileSync(listOutputPath, 'utf8').trim();
const lines = [];
lines.push('# D1マイグレーション調査結果');
lines.push('');
lines.push('本番D1には書き込まず、リモート一覧・スキーマ照会とローカル複製DBで検証しました。');
lines.push('');
lines.push(`- リポジトリ内マイグレーション: **${migrationFiles.length}件**`);
lines.push(`- 本番D1で適用済みと記録されたリポジトリ内ファイル: **${appliedRepositoryFiles.length}件**`);
lines.push(`- 未適用: **${unapplied.length}件**`);
if (appliedUnknownFiles.length) lines.push(`- 本番記録にだけ存在するファイル: ${appliedUnknownFiles.map((name) => `\`${name}\``).join(', ')}`);
lines.push('');
lines.push('## 未適用ファイル');
lines.push('');
if (unapplied.length) {
  for (const name of unapplied) lines.push(`- \`${name}\``);
} else {
  lines.push('- なし');
}
lines.push('');
lines.push('## 順次ローカル検証');
lines.push('');
if (schemaImportError) {
  lines.push('本番スキーマのローカル複製に失敗しました。');
  lines.push('');
  lines.push('```text');
  lines.push(schemaImportError);
  lines.push('```');
} else {
  lines.push(`本番スキーマの複製後、未適用ファイルを順番に試し、**${simulatedSuccessfully.length}件**がエラーなく通過しました。`);
  lines.push('');
  if (firstBlockingError) {
    lines.push(`最初の停止対象: \`${firstBlockingError.name}\``);
    lines.push('');
    lines.push('```text');
    lines.push(firstBlockingError.output);
    lines.push('```');
  } else {
    lines.push('未適用ファイルはすべて空データのローカル複製DBで通過しました。');
  }
}
lines.push('');
lines.push('## 静的な依存関係の疑い');
lines.push('');
if (staticFindings.length) {
  for (const finding of staticFindings) {
    lines.push(`- \`${finding.name}\`: ${finding.missing.map((name) => `\`${name}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('この欄はSQL文字列の静的走査なので、CTEや別名による誤検出があり得ます。実行検証の停止対象を優先してください。');
} else {
  lines.push('- 明白な未定義テーブル参照は検出されませんでした。');
}
lines.push('');
lines.push('## Cloudflareの未適用一覧出力');
lines.push('');
lines.push('```text');
lines.push(excerpt(migrationListOutput, 120));
lines.push('```');
lines.push('');
lines.push('注: データ依存の制約違反は、データをコピーしない今回の検証では再現できない場合があります。');

writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
rmSync(schemaPath, { force: true });
rmSync(stateDirectory, { recursive: true, force: true });
