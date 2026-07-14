export function splitSqlValues(values) {
  const result = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "'") {
      if (quoted && values[index + 1] === "'") index += 1;
      else quoted = !quoted;
    } else if (values[index] === ',' && !quoted) {
      result.push(values.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) throw new Error('Unterminated SQL string literal in D1 export');
  result.push(values.slice(start));
  return result;
}

export function canonicalStatement(statement) {
  const match = statement.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES\((.*)\);$/u);
  if (!match) return statement;
  const columns = [...match[2].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
  const values = splitSqlValues(match[3]);
  if (columns.length !== values.length) {
    throw new Error(`Could not canonicalize D1 export for ${match[1]}`);
  }
  return `${match[1]}|${columns.map((column, index) => [column, values[index]])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([column, value]) => `${column}=${value}`).join('|')}`;
}

export function canonicalizeD1Export(sql) {
  return String(sql || '')
    .replace(/^PRAGMA defer_foreign_keys=TRUE;\s*/u, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(canonicalStatement)
    .sort()
    .join('\n');
}

export function countD1ExportRows(sql, tables) {
  const normalized = String(sql || '').replace(/\r\n/g, '\n');
  return Object.fromEntries(tables.map((table) => {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = normalized.match(new RegExp(`^INSERT INTO "${escaped}" `, 'gmu'));
    return [table, matches?.length || 0];
  }));
}

export function ownershipPolicyRequiresCleanup(mode) {
  return mode === 'seed' || mode === 'finalize';
}
