import fs from 'node:fs/promises';
import path from 'node:path';

const SHEET_ID = '188dtzckvsE4xf_lIZTIqq_TJe7MEqr32Nk5qGizw-co';
const GID = '1163473737';
const SOURCE_ID = `weekly_leaderboard_${GID}`;
const SOURCE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
const OUT_DIR = path.resolve('database/ranking-import-parts');
const OUT_REPORT = path.resolve('database/ranking-import-report.json');
const OUT_MANIFEST = path.resolve('database/ranking-import-manifest.json');
const IMPORTED_AT = Date.now();

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const clean = (value) => String(value ?? '').trim();
const norm = (value) => clean(value).replace(/[\s　]/g, '').toLowerCase();

function numeric(value) {
  const text = clean(value);
  if (!text || /^[-—–]+$/.test(text) || /#(?:ERROR|N\/A|VALUE|REF)!?/i.test(text)) return null;
  const match = text.replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const valueNumber = Number(match[0]);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function integer(value) {
  const n = numeric(value);
  return n == null ? null : Math.round(n);
}

function parseDate(value) {
  const text = clean(value);
  const match = text.match(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(timestamp) ? { iso, timestamp } : null;
}

function sql(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `CAST(X'${Buffer.from(String(value), 'utf8').toString('hex')}' AS TEXT)`;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const cells = rows[i].map(norm);
    if (cells.some((cell) => cell.includes('開始日')) && cells.some((cell) => cell.includes('再生数'))) return i;
  }
  return -1;
}

function findColumn(headers, alternatives) {
  const normalized = headers.map(norm);
  return normalized.findIndex((header) => alternatives.some((name) => header.includes(norm(name))));
}

function validRank(value) {
  const rank = integer(value);
  return rank != null && rank >= 1 && rank <= 1000 ? rank : null;
}

async function main() {
  const response = await fetch(SOURCE_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Google Sheets download failed: HTTP ${response.status}`);
  const rows = parseCsv(await response.text());
  const headerIndex = findHeader(rows);
  if (headerIndex < 0) throw new Error('Weekly Leaderboard header not found');

  const headers = rows[headerIndex];
  const dateIndex = findColumn(headers, ['開始日']);
  const reflectedIndex = findColumn(headers, ['反映']);
  const updateIndex = findColumn(headers, ['更新目安日']);

  const reserved = new Set([dateIndex, reflectedIndex, updateIndex].filter((i) => i >= 0));
  const candidateColumns = headers
    .map((header, index) => ({ header: clean(header), index }))
    .filter(({ header, index }) => {
      if (!header || reserved.has(index)) return false;
      const h = norm(header);
      return !['再生数','メンバー数','平均同接','同接','最小','最大'].some((name) => h.includes(norm(name)));
    });

  // 数値の順位が実際に含まれる列だけをチャンネル列として採用する。
  const channelColumns = candidateColumns.filter(({ index }) => {
    let valid = 0;
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      if (validRank(rows[rowIndex][index]) != null) valid += 1;
      if (valid >= 2) return true;
    }
    return false;
  });

  const statements = [
    `DELETE FROM sh_channel_rankings WHERE source_sheet=${sql(SOURCE_ID)};`,
  ];
  const report = {
    generated_at: new Date().toISOString(),
    source_url: SOURCE_URL,
    source_rows: Math.max(0, rows.length - headerIndex - 1),
    imported_rankings: 0,
    skipped_no_date: 0,
    skipped_no_ranking: 0,
    estimated_rows: 0,
    formula_error_rows: 0,
    channel_columns: channelColumns.map((column) => column.header),
    weekly_metrics_source: 'sh_weekly_summary (derived from original detailed history)',
  };

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((cell) => clean(cell))) continue;

    let parsedDate = dateIndex >= 0 ? parseDate(row[dateIndex]) : null;
    if (!parsedDate) {
      for (const cell of row) {
        parsedDate = parseDate(cell);
        if (parsedDate) break;
      }
    }
    if (!parsedDate) { report.skipped_no_date += 1; continue; }

    const fullText = row.map(clean).join(' ');
    const estimated = /推定/.test(fullText);
    const formulaError = /#(?:ERROR|N\/A|VALUE|REF)!?/i.test(fullText);
    if (estimated) report.estimated_rows += 1;
    if (formulaError) report.formula_error_rows += 1;

    const reflected = reflectedIndex >= 0 ? clean(row[reflectedIndex]) || null : null;
    const updateTarget = updateIndex >= 0 ? clean(row[updateIndex]) || null : null;

    let rankingCount = 0;
    for (const column of channelColumns) {
      const rank = validRank(row[column.index]);
      if (rank == null) continue;
      rankingCount += 1;

      const flags = [];
      let quality = 1;
      if (estimated) { flags.push('estimated'); quality -= 0.2; }
      if (formulaError) { flags.push('formula_error_elsewhere'); quality -= 0.15; }

      const raw = {
        row,
        reflected,
        update_target: updateTarget,
        note: 'Ranking only. Weekly metrics are derived from sh_weekly_summary.',
      };

      statements.push(`INSERT OR REPLACE INTO sh_channel_rankings (
ranking_date,observed_at,ranking_type,rank,channel_name,channel_alias,
listener_count,member_count,total_listens,source_sheet,source_row,
quality_score,quality_flags,raw_json,imported_at
) VALUES (
${sql(parsedDate.iso)},${parsedDate.timestamp},${sql('週間チャンネル順位')},${rank},${sql(column.header)},NULL,
NULL,NULL,NULL,${sql(SOURCE_ID)},${rowIndex + 1},
${Math.max(0, quality)},${sql(JSON.stringify(flags))},${sql(JSON.stringify(raw))},${IMPORTED_AT}
);`);
      report.imported_rankings += 1;
    }
    if (!rankingCount) report.skipped_no_ranking += 1;
  }

  const chunkSize = 10000;
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  const files = [];
  for (let index = 0; index < statements.length; index += chunkSize) {
    const part = String(files.length + 1).padStart(3, '0');
    const filename = `ranking-import-part-${part}.sql`;
    await fs.writeFile(path.join(OUT_DIR, filename), statements.slice(index, index + chunkSize).join('\n') + '\n', 'utf8');
    files.push({ filename, statements: Math.min(chunkSize, statements.length - index) });
  }

  const manifest = { generated_at: new Date().toISOString(), total_statements: statements.length, files };
  await fs.writeFile(OUT_REPORT, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`OK rankings=${report.imported_rankings} channels=${report.channel_columns.join(', ')}`);
  console.log(`SQL parts: ${OUT_DIR}`);
  console.log(`Report: ${OUT_REPORT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
