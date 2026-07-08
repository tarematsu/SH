export const DEFAULT_D1_BATCH_VARIABLE_LIMIT = 90;
export const DEFAULT_D1_BATCH_STATEMENT_LIMIT = 40;

export function prepared(statement, bindCount) {
  return { statement, bindCount };
}

export function unwrapPreparedStatement(entry) {
  return entry?.statement || entry;
}

export function preparedStatementBindCount(entry, fallback = DEFAULT_D1_BATCH_VARIABLE_LIMIT) {
  if (Number.isFinite(entry?.bindCount)) return entry.bindCount;
  if (Array.isArray(entry?.params)) return entry.params.length;
  if (Array.isArray(entry?.statement?.params)) return entry.statement.params.length;
  return fallback;
}

export function splitD1Batches(statements, options = {}) {
  const variableLimit = Number.isFinite(options.variableLimit)
    ? options.variableLimit
    : DEFAULT_D1_BATCH_VARIABLE_LIMIT;
  const statementLimit = Number.isFinite(options.statementLimit)
    ? options.statementLimit
    : DEFAULT_D1_BATCH_STATEMENT_LIMIT;
  const groups = [];
  let current = [];
  let bindCount = 0;

  for (const statement of Array.isArray(statements) ? statements : []) {
    const nextBindCount = preparedStatementBindCount(statement, variableLimit);
    if (current.length > 0 && (
      current.length >= statementLimit
      || bindCount + nextBindCount > variableLimit
    )) {
      groups.push(current);
      current = [];
      bindCount = 0;
    }
    current.push(statement);
    bindCount += nextBindCount;
  }

  if (current.length) groups.push(current);
  return groups;
}

export async function runPreparedD1Batches(db, statements, options = {}) {
  const fallbackMethod = options.fallbackMethod || 'run';
  const results = [];
  for (const group of splitD1Batches(statements, options)) {
    if (!group.length) continue;
    const unwrapped = group.map(unwrapPreparedStatement);
    const batchResults = typeof db.batch === 'function'
      ? await db.batch(unwrapped)
      : await Promise.all(unwrapped.map((statement) => statement[fallbackMethod]()));
    results.push(...batchResults);
  }
  return results;
}
