export class FakeD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = String(sql);
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() {
    return this.db.resolve('first', this.sql, this.params);
  }

  all() {
    return this.db.resolve('all', this.sql, this.params);
  }

  run() {
    return this.db.resolve('run', this.sql, this.params);
  }
}

export class FakeD1Database {
  constructor(routes = []) {
    this.routes = [...routes];
    this.calls = [];
    this.batches = [];
  }

  route(kind, matcher, result) {
    this.routes.push({ kind, matcher, result });
    return this;
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, params: [...statement.params] })));
    const results = [];
    for (const statement of statements) {
      const read = /^(SELECT|WITH|PRAGMA)\b/i.test(statement.sql.trim());
      results.push(read ? await statement.all() : await statement.run());
    }
    return results;
  }

  async resolve(kind, sql, params) {
    this.calls.push({ kind, sql, params: [...params] });
    const route = this.routes.find((candidate) => {
      if (candidate.kind !== kind && candidate.kind !== '*') return false;
      if (typeof candidate.matcher === 'string') return sql.includes(candidate.matcher);
      if (candidate.matcher instanceof RegExp) return candidate.matcher.test(sql);
      return typeof candidate.matcher === 'function' && candidate.matcher(sql, params);
    });
    if (route) {
      return typeof route.result === 'function'
        ? route.result({ kind, sql, params, db: this })
        : structuredClone(route.result);
    }
    if (kind === 'first') return null;
    if (kind === 'all') return { results: [] };
    return { success: true, meta: { changes: 1 } };
  }

  callsMatching(pattern, kind = null) {
    return this.calls.filter((call) => (!kind || call.kind === kind) && pattern.test(call.sql));
  }
}

export async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
