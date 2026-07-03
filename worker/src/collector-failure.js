const STATE_ID = 'stationhead';

const DEFINITIONS = {
  D1_BINDING_MISSING: {
    summary: 'Cloudflare D1のバインディングが見つかりません',
    hint: 'WorkerのD1バインディング名がDBになっているか、デプロイ設定を確認してください。',
  },
  D1_SCHEMA_ERROR: {
    summary: 'D1のテーブルまたは列が不足しています',
    hint: '未適用のD1マイグレーションがないか確認してください。',
  },
  D1_READ_ERROR: {
    summary: 'D1から必要な状態を読み込めませんでした',
    hint: 'Cloudflare D1の障害状況、DBバインディング、読み取りクエリを確認してください。',
  },
  D1_WRITE_ERROR: {
    summary: '取得したデータをD1へ保存できませんでした',
    hint: 'Cloudflare D1の障害状況、容量・制限、書き込みクエリ、マイグレーションを確認してください。',
  },
  STATIONHEAD_AUTH_ERROR: {
    summary: 'Stationheadの認証またはゲストセッション取得に失敗しました',
    hint: 'Stationheadの認証API、トークン発行仕様、app-version、アクセス制限を確認してください。',
  },
  STATIONHEAD_API_CHANGED: {
    summary: 'Stationhead APIのエンドポイントまたはレスポンス形式が変わった可能性があります',
    hint: '対象エンドポイント、HTTPステータス、JSON構造、必須項目名を再調査してください。',
  },
  STATIONHEAD_RATE_LIMIT: {
    summary: 'Stationhead APIのアクセス制限を受けました',
    hint: '収集間隔とリトライ頻度を確認し、429応答が続く場合は呼び出し回数を減らしてください。',
  },
  STATIONHEAD_UPSTREAM_ERROR: {
    summary: 'Stationhead側のサーバーエラーで取得できませんでした',
    hint: 'Stationhead側の一時障害の可能性があります。継続する場合はAPI仕様も確認してください。',
  },
  STATIONHEAD_TIMEOUT: {
    summary: 'Stationhead APIが時間内に応答しませんでした',
    hint: 'Stationhead側の応答遅延、ネットワーク、REQUEST_TIMEOUT_MSを確認してください。',
  },
  NETWORK_ERROR: {
    summary: '外部APIへのネットワーク接続に失敗しました',
    hint: 'Cloudflare Workerの外部通信、DNS、接続先の稼働状況を確認してください。',
  },
  DATA_VALIDATION_ERROR: {
    summary: '取得データが想定している構造を満たしていません',
    hint: 'Stationheadのレスポンス構造変更または欠損データを確認してください。',
  },
  COLLECTOR_INTERNAL_ERROR: {
    summary: '収集処理内部で予期しないエラーが発生しました',
    hint: 'Workerログと直近のコード変更を確認してください。',
  },
};

const STAGE_LABELS = {
  collector_start: '収集開始',
  d1_read_auth_state: 'D1から認証状態を読み込み',
  d1_write_auth_state: 'D1へ認証状態を書き込み',
  d1_read_collector_state: 'D1から収集状態を読み込み',
  stationhead_auth: 'Stationheadゲスト認証',
  stationhead_channel_request: 'Stationheadチャンネル情報取得',
  stationhead_channel_payload: 'Stationheadチャンネル応答検証',
  d1_write_collector_heartbeat: 'D1へ収集ハートビートを書き込み',
  d1_write_snapshot: 'D1へチャンネルスナップショットを書き込み',
  d1_write_queue: 'D1へ再生キューを書き込み',
  stationhead_chat_history: 'Stationheadコメント履歴取得',
  d1_write_comments: 'D1へコメントを書き込み',
  d1_write_track_metadata: 'D1へ楽曲メタデータを書き込み',
  d1_write_collector_state: 'D1へ収集結果状態を書き込み',
  collector_unknown: '収集処理',
};

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function occurredAfterSuccess(eventAt, lastSuccessAt) {
  return eventAt == null || eventAt > lastSuccessAt;
}

export function sanitizeFailureDetail(value) {
  return text(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/authorization["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, 'authorization=[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt-redacted]')
    .replace(/\bre_[A-Za-z0-9_-]{12,}\b/g, '[api-key-redacted]')
    .slice(0, 800);
}

function hasStatus(detail, status) {
  return new RegExp(`(?:status[=: ]*|HTTP\\s*|API\\s*)${status}\\b`, 'i').test(detail);
}

function definition(code) {
  return DEFINITIONS[code] || DEFINITIONS.COLLECTOR_INTERNAL_ERROR;
}

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || STAGE_LABELS.collector_unknown;
}

export function diagnoseCollectorFailure(error, stage = 'collector_unknown', at = Date.now()) {
  if (error?.diagnosis?.code) {
    return {
      ...error.diagnosis,
      at: finite(error.diagnosis.at) ?? at,
    };
  }

  const detail = sanitizeFailureDetail(error?.message || error || 'unknown error');
  const lower = detail.toLowerCase();
  let code = 'COLLECTOR_INTERNAL_ERROR';

  if (/db binding (?:is )?missing|d1 binding/i.test(detail)) {
    code = 'D1_BINDING_MISSING';
  } else if (/no such table|no such column|has no column named|migration required|SQLITE_SCHEMA/i.test(detail)) {
    code = 'D1_SCHEMA_ERROR';
  } else if (stage.startsWith('d1_read_')) {
    code = 'D1_READ_ERROR';
  } else if (stage.startsWith('d1_write_')) {
    code = 'D1_WRITE_ERROR';
  } else if (/D1_ERROR|database error|SQLITE_BUSY|SQLITE_FULL|SQLITE_IOERR|D1 ingest failed/i.test(detail)) {
    code = /select|read|first\(|\.all\(|prepare.*select/i.test(lower) ? 'D1_READ_ERROR' : 'D1_WRITE_ERROR';
  } else if (
    stage === 'stationhead_auth'
    || hasStatus(detail, 401)
    || hasStatus(detail, 403)
    || /authentication failed|session expired|guest token failed|guest login failed|guest verification failed|authentication backoff/i.test(detail)
  ) {
    code = 'STATIONHEAD_AUTH_ERROR';
  } else if (hasStatus(detail, 429)) {
    code = 'STATIONHEAD_RATE_LIMIT';
  } else if (
    stage === 'stationhead_channel_payload'
    || hasStatus(detail, 404)
    || hasStatus(detail, 410)
    || /invalid json|unexpected token|response shape|payload shape|missing required|仕様変更|schema changed/i.test(detail)
  ) {
    code = 'STATIONHEAD_API_CHANGED';
  } else if (/timeout|timed out|aborted|aborterror/i.test(detail)) {
    code = 'STATIONHEAD_TIMEOUT';
  } else if (/(?:status[=: ]*|HTTP\s*|API\s*)5\d\d\b|Stationhead API 5\d\d/i.test(detail)) {
    code = 'STATIONHEAD_UPSTREAM_ERROR';
  } else if (/fetch failed|network|dns|econn|socket|connection reset|connection refused/i.test(detail)) {
    code = 'NETWORK_ERROR';
  } else if (/validation|expected object|required field|invalid channel/i.test(detail)) {
    code = 'DATA_VALIDATION_ERROR';
  }

  const meta = definition(code);
  return {
    code,
    stage,
    stageLabel: stageLabel(stage),
    summary: meta.summary,
    detail,
    hint: meta.hint,
    at,
  };
}

export class CollectorFailure extends Error {
  constructor(diagnosis, cause = null) {
    super(`${diagnosis.code} at ${diagnosis.stage}: ${diagnosis.detail || diagnosis.summary}`);
    this.name = 'CollectorFailure';
    this.diagnosis = diagnosis;
    this.cause = cause || undefined;
  }
}

export function asCollectorFailure(error, stage = 'collector_unknown', at = Date.now()) {
  if (error instanceof CollectorFailure) return error;
  return new CollectorFailure(diagnoseCollectorFailure(error, stage, at), error);
}

export function isD1Failure(value) {
  const diagnosis = value?.code ? value : diagnoseCollectorFailure(value);
  return diagnosis.code.startsWith('D1_');
}

export async function recordCollectorFailure(
  env,
  error,
  stage = 'collector_unknown',
  source = 'worker',
  at = Date.now(),
) {
  const diagnosis = diagnoseCollectorFailure(error, stage, at);
  const eventAt = finite(diagnosis.at) ?? at;
  const firstAt = finite(diagnosis.firstAt) ?? eventAt;
  if (!env?.DB) return { diagnosis, recorded: false, recordError: 'DB binding missing' };

  try {
    await env.DB.prepare(`INSERT INTO sh_collector_failure_state (
        id,first_failure_at,last_failure_at,code,stage,summary,detail,hint,source,
        consecutive_failures,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET
        first_failure_at=CASE
          WHEN sh_collector_failure_state.code=excluded.code
           AND sh_collector_failure_state.stage=excluded.stage
          THEN MIN(sh_collector_failure_state.first_failure_at,excluded.first_failure_at)
          ELSE excluded.first_failure_at
        END,
        last_failure_at=excluded.last_failure_at,
        code=excluded.code,stage=excluded.stage,summary=excluded.summary,
        detail=excluded.detail,hint=excluded.hint,source=excluded.source,
        consecutive_failures=CASE
          WHEN sh_collector_failure_state.code=excluded.code
           AND sh_collector_failure_state.stage=excluded.stage
          THEN sh_collector_failure_state.consecutive_failures+1
          ELSE 1
        END,
        updated_at=excluded.updated_at`)
      .bind(
        STATE_ID,
        firstAt,
        eventAt,
        diagnosis.code,
        diagnosis.stage,
        diagnosis.summary,
        diagnosis.detail || null,
        diagnosis.hint || null,
        source,
        eventAt,
      ).run();
    return { diagnosis, recorded: true };
  } catch (recordError) {
    return {
      diagnosis,
      recorded: false,
      recordError: sanitizeFailureDetail(recordError?.message || recordError),
    };
  }
}

export async function clearCollectorFailure(env) {
  if (!env?.DB) return false;
  await env.DB.prepare('DELETE FROM sh_collector_failure_state WHERE id=?')
    .bind(STATE_ID).run();
  return true;
}

export function diagnosisFromState(state = {}) {
  const lastSuccessAt = finite(state.last_success_at) ?? 0;
  const failureAt = finite(state.failure_last_at);
  if (failureAt != null && occurredAfterSuccess(failureAt, lastSuccessAt) && state.failure_code) {
    return {
      code: text(state.failure_code),
      stage: text(state.failure_stage) || 'collector_unknown',
      stageLabel: stageLabel(state.failure_stage),
      summary: text(state.failure_summary) || definition(state.failure_code).summary,
      detail: sanitizeFailureDetail(state.failure_detail),
      hint: text(state.failure_hint) || definition(state.failure_code).hint,
      at: failureAt,
      firstAt: finite(state.failure_first_at),
      count: finite(state.failure_count),
      source: text(state.failure_source) || null,
    };
  }

  const authAttemptAt = finite(state.auth_last_attempt_at);
  if (state.auth_last_error && occurredAfterSuccess(authAttemptAt, lastSuccessAt)) {
    return {
      ...diagnoseCollectorFailure(state.auth_last_error, 'stationhead_auth', authAttemptAt || Date.now()),
      count: null,
      source: 'auth-control',
    };
  }

  const collectorRunAt = finite(state.last_run_at);
  if (state.last_error && occurredAfterSuccess(collectorRunAt, lastSuccessAt)) {
    return {
      ...diagnoseCollectorFailure(state.last_error, 'collector_unknown', collectorRunAt || Date.now()),
      count: null,
      source: 'collector-state',
    };
  }

  return null;
}

export function failureEmailLines(diagnosis) {
  if (!diagnosis) {
    return [
      '推定原因: 記録なし',
      '説明: 収集成功時刻は古いものの、直近の失敗理由を取得できませんでした。',
      '確認候補: Workerログ、D1状態、Stationhead APIの応答を確認してください。',
    ];
  }

  return [
    `推定原因: ${diagnosis.summary}`,
    `原因コード: ${diagnosis.code}`,
    `失敗段階: ${diagnosis.stageLabel || stageLabel(diagnosis.stage)}`,
    `原因記録時刻: ${diagnosis.at ? new Date(diagnosis.at).toISOString() : '不明'}`,
    ...(diagnosis.count ? [`同種の連続失敗: ${diagnosis.count}回`] : []),
    `詳細: ${diagnosis.detail || '記録なし'}`,
    `確認候補: ${diagnosis.hint || 'Workerログを確認してください。'}`,
  ];
}
