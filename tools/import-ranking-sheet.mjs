import fs from 'node:fs/promises';
import path from 'node:path';

// One-off migration script: point this at your own Google Sheets via RANKING_IMPORT_SHEETS, e.g.:
//   RANKING_IMPORT_SHEETS='[{"id":"weekly_leaderboard","kind":"vertical","sheetId":"XXX","gid":"0","priority":1}]'
const SOURCES = JSON.parse(process.env.RANKING_IMPORT_SHEETS || 'null');
if (!SOURCES) {
  throw new Error('Set RANKING_IMPORT_SHEETS to a JSON array of {id, kind, sheetId, gid, priority} sources.');
}

const RANKING_TYPE = '週間チャンネル順位';
const OUT_DIR = path.resolve('database/ranking-import-parts');
const OUT_REPORT = path.resolve('database/ranking-import-report.json');
const OUT_MANIFEST = path.resolve('database/ranking-import-manifest.json');
const IMPORTED_AT = Date.now();
const MAX_RANK = 100;

function sourceUrl(source) {
  return `https://docs.google.com/spreadsheets/d/${source.sheetId}/export?format=csv&gid=${source.gid}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

const clean = (value) => String(value ?? '').trim();
const norm = (value) => clean(value).replace(/[\s　]/g, '').toLowerCase();

function numeric(value) {
  const text = clean(value);
  if (!text || /^[-—–]+$/.test(text) || /#(?:ERROR|N\/A|VALUE|REF)!?/i.test(text)) return null;
  const normalized = text.replace(/[,，]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function validRank(value) {
  const n = numeric(value);
  if (n == null) return null;
  const rank = Math.round(n);
  return rank >= 1 && rank <= MAX_RANK ? rank : null;
}

function parseDate(value) {
  const text = clean(value);
  const match = text.match(/(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timestamp = Date.parse(`${iso}T00:00:00+09:00`);
  return Number.isFinite(timestamp) ? { iso, timestamp } : null;
}

function sql(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `CAST(X'${Buffer.from(String(value), 'utf8').toString('hex')}' AS TEXT)`;
}

function validChannelName(value) {
  const name = clean(value);
  if (!name || name.length > 120) return null;
  if (/<!doctype|<html|javascript|browser error|loading/i.test(name)) return null;
  if (/^#(?:ERROR|N\/A|VALUE|REF)!?$/i.test(name)) return null;
  if (/^\d+$/.test(name)) return null;
  if (['名前', 'name', 'ranking', 'namelist'].includes(norm(name))) return null;
  return name;
}

function putRecord(records, record) {
  const key = `${record.rankingDate}|${record.channelName.toLowerCase()}`;
  const existing = records.get(key);
  if (!existing || record.priority >= existing.priority) records.set(key, record);
}

function findColumn(headers, alternatives) {
  const normalized = headers.map(norm);
  return normalized.findIndex((header) => alternatives.some((name) => header.includes(norm(name))));
}

function parseVertical(rows, source, report, records) {
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const cells = rows[i].map(norm);
    if (cells.some((cell) => cell.includes('開始日')) && cells.some((cell) => cell.includes('再生数'))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) {
    report.sources[source.id].error = 'vertical header not found';
    return;
  }

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
      return !['再生数', 'メンバー数', '平均同接', '同接', '最小', '最大'].some((name) => h.includes(norm(name)));
    });

  const channelColumns = candidateColumns.filter(({ index }) => {
    let valid = 0;
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      if (validRank(rows[rowIndex][index]) != null) valid += 1;
      if (valid >= 1) return true;
    }
    return false;
  });

  report.sources[source.id].detected_channels = channelColumns.map((column) => column.header);

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.some((cell) => clean(cell))) continue;
    let date = dateIndex >= 0 ? parseDate(row[dateIndex]) : null;
    if (!date) {
      for (const cell of row) {
        date = parseDate(cell);
        if (date) break;
      }
    }
    if (!date) { report.sources[source.id].skipped_no_date += 1; continue; }

    const fullText = row.map(clean).join(' ');
    const flags = [];
    let quality = 1;
    if (/推定/.test(fullText)) { flags.push('estimated'); quality -= 0.2; }
    if (/#(?:ERROR|N\/A|VALUE|REF)!?/i.test(fullText)) { flags.push('formula_error_elsewhere'); quality -= 0.15; }

    for (const column of channelColumns) {
      const channelName = validChannelName(column.header);
      const rank = validRank(row[column.index]);
      if (!channelName || rank == null) continue;
      putRecord(records, {
        rankingDate: date.iso,
        observedAt: date.timestamp,
        channelName,
        rank,
        sourceId: source.id,
        sourceRow: rowIndex + 1,
        quality: Math.max(0, quality),
        flags,
        raw: { source: source.id, row: rowIndex + 1, raw_rank: clean(row[column.index]) },
        priority: source.priority,
      });
      report.sources[source.id].accepted += 1;
    }
  }
}

function parseMatrix(rows, source, report, records) {
  let headerIndex = -1;
  let nameIndex = -1;
  let dateColumns = [];

  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const row = rows[i];
    const candidateNameIndex = row.findIndex((cell) => ['名前', 'name'].includes(norm(cell)));
    const candidates = row
      .map((cell, index) => ({ index, date: parseDate(cell), label: clean(cell) }))
      .filter((item) => item.date);
    if (candidateNameIndex >= 0 && candidates.length >= 2) {
      headerIndex = i;
      nameIndex = candidateNameIndex;
      dateColumns = candidates;
      break;
    }
  }

  if (headerIndex < 0) {
    report.sources[source.id].error = 'matrix header not found';
    return;
  }

  report.sources[source.id].date_columns = dateColumns.map((item) => item.date.iso);
  const channelSet = new Set();

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const channelName = validChannelName(row[nameIndex]);
    if (!channelName) {
      if (row.some((cell) => clean(cell))) report.sources[source.id].skipped_invalid_channel += 1;
      continue;
    }

    let acceptedForChannel = 0;
    for (const column of dateColumns) {
      const rawRank = row[column.index];
      const rank = validRank(rawRank);
      if (rank == null) continue;
      putRecord(records, {
        rankingDate: column.date.iso,
        observedAt: column.date.timestamp,
        channelName,
        rank,
        sourceId: source.id,
        sourceRow: rowIndex + 1,
        quality: 1,
        flags: [],
        raw: {
          source: source.id,
          row: rowIndex + 1,
          date_header: column.label,
          raw_rank: clean(rawRank),
        },
        priority: source.priority,
      });
      acceptedForChannel += 1;
      report.sources[source.id].accepted += 1;
    }
    if (acceptedForChannel) channelSet.add(channelName);
    else report.sources[source.id].skipped_no_ranking += 1;
  }

  report.sources[source.id].detected_channel_count = channelSet.size;
}

async function fetchRows(source) {
  const url = sourceUrl(source);
  const response = await fetch(url, {
    headers: {
      accept: 'text/csv,*/*',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`${source.id}: Google Sheets download failed HTTP ${response.status}`);
  return { rows: parseCsv(await response.text()), url };
}

async function main() {
  const records = new Map();
  const report = {
    generated_at: new Date().toISOString(),
    ranking_type: RANKING_TYPE,
    merge_rule: 'When the same week and channel exist in both sheets, all_channels_matrix has priority.',
    weekly_metrics_source: 'sh_weekly_summary (derived from original detailed history)',
    sources: {},
  };

  for (const source of SOURCES) {
    report.sources[source.id] = {
      kind: source.kind,
      source_url: sourceUrl(source),
      downloaded_rows: 0,
      accepted: 0,
      skipped_no_date: 0,
      skipped_invalid_channel: 0,
      skipped_no_ranking: 0,
    };
    try {
      const { rows } = await fetchRows(source);
      report.sources[source.id].downloaded_rows = rows.length;
      if (source.kind === 'matrix') parseMatrix(rows, source, report, records);
      else parseVertical(rows, source, report, records);
    } catch (error) {
      report.sources[source.id].error = error?.message || String(error);
    }
  }

  const sorted = [...records.values()].sort((a, b) =>
    a.rankingDate.localeCompare(b.rankingDate) || a.rank - b.rank || a.channelName.localeCompare(b.channelName));
  const channels = new Set(sorted.map((row) => row.channelName));
  const dates = new Set(sorted.map((row) => row.rankingDate));

  const statements = [
    `DELETE FROM sh_channel_rankings WHERE ranking_type=${sql(RANKING_TYPE)};`,
  ];

  for (const row of sorted) {
    statements.push(`INSERT INTO sh_channel_rankings (
ranking_date,observed_at,ranking_type,rank,channel_name,channel_alias,
listener_count,member_count,total_listens,source_sheet,source_row,
quality_score,quality_flags,raw_json,imported_at
) VALUES (
${sql(row.rankingDate)},${row.observedAt},${sql(RANKING_TYPE)},${row.rank},${sql(row.channelName)},${sql(row.channelName)},
NULL,NULL,NULL,${sql(row.sourceId)},${row.sourceRow},
${row.quality},${sql(JSON.stringify(row.flags))},${sql(JSON.stringify(row.raw))},${IMPORTED_AT}
)
ON CONFLICT(ranking_date,ranking_type,channel_name) DO UPDATE SET
observed_at=excluded.observed_at,
rank=excluded.rank,
channel_alias=excluded.channel_alias,
source_sheet=excluded.source_sheet,
source_row=excluded.source_row,
quality_score=excluded.quality_score,
quality_flags=excluded.quality_flags,
raw_json=excluded.raw_json,
imported_at=excluded.imported_at;`);
  }

  const chunkSize = 5000;
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  const files = [];
  for (let index = 0; index < statements.length; index += chunkSize) {
    const part = String(files.length + 1).padStart(3, '0');
    const filename = `ranking-import-part-${part}.sql`;
    const slice = statements.slice(index, index + chunkSize);
    await fs.writeFile(path.join(OUT_DIR, filename), `${slice.join('\n')}\n`, 'utf8');
    files.push({ filename, statements: slice.length });
  }

  report.merged_rankings = sorted.length;
  report.unique_channels = channels.size;
  report.unique_weeks = dates.size;
  report.first_week = sorted[0]?.rankingDate || null;
  report.last_week = sorted.at(-1)?.rankingDate || null;
  report.sql_parts = files.length;

  const manifest = {
    generated_at: new Date().toISOString(),
    total_statements: statements.length,
    ranking_records: sorted.length,
    files,
  };
  await fs.writeFile(OUT_REPORT, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');

  if (!sorted.length) throw new Error('No ranking records were generated. Check sheet sharing and report errors.');
  console.log(`OK rankings=${sorted.length} channels=${channels.size} weeks=${dates.size}`);
  console.log(`SQL parts: ${OUT_DIR}`);
  console.log(`Report: ${OUT_REPORT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
