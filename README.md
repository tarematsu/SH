# Stationhead Monitor

StationheadのBuddiesチャンネル、ホスト情報、単独放送、週間リーダーボード、公式ニュース連動放送、週間メールの累計再生数を収集し、Cloudflare D1へ保存してPagesで表示するシステムです。

## 現行構成

```text
Stationhead API / 櫻坂46公式ニュース
              ↓
Cloudflare Worker（主系・1分Cron）
              ↓
Cloudflare D1
              ↓
Cloudflare Pages / API

Gmail ─ Google Apps Script ─→ Worker ─→ D1

Windows Local Collector（auto待機）
              └ Worker停止時に自動昇格
```

### Cloudflare Worker

主系として次を取得します。

- Buddiesの1分スナップショット
- コメントと直近2分コメント速度
- キュー、現在曲、曲メタデータ
- `sakuramankai`プロフィール
- `sakurazaka46jp`単独配信
- 公式ニュース連動のフェイルセーフ監視
- 週間チャンネルリーダーボード
- Google Apps Scriptから送信される週間Recapメール
- Collectorリースとヘルス状態

### Local Collector

Workerの完全な非常用バックアップです。

| モード | 動作 |
|---|---|
| `auto` | Workerの180秒リースが切れたときだけ全収集を開始 |
| `active` | Workerに関係なく強制実行 |
| `standby` | 収集せず待機 |
| `start:direct` | Supervisorを通さず従来Collectorを直接実行 |

WorkerとLocalを同時実行しても、D1の論理キー、取得元優先度、既存のユニーク制約で重複を防ぎます。

取得元優先度:

```text
Cloudflare Worker       100
Local active             80
Local auto failover      70
Local WebSocket補完      60
Historical import        20
```

詳細は[`docs/architecture/cloud-primary-local-failover.md`](docs/architecture/cloud-primary-local-failover.md)を参照してください。

## ディレクトリ

```text
collector/   Windows用Collector、Supervisor、週間リーダーボード
worker/      Cloudflare Worker
site/        Cloudflare Pages、Functions、フロントエンド
database/    基本スキーマ、マイグレーション、初期データ
gas/         Google Apps Script関連
tests/       軽量単体テスト
docs/        アーキテクチャ・運用資料
```

## 初回セットアップ

### 1. D1の基本スキーマ

未作成DBにだけ、必要な基本スキーマを投入します。

```powershell
cd C:\stationhead-monitor\worker

npx wrangler d1 execute stationhead-monitor --remote --file=..\database\schema.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\history-schema.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\host-monitoring.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\worker-collector.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\official-news-monitor.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\email-recap-streams.sql
```

既存本番DBでは基本スキーマを再実行せず、下のマイグレーションだけを順番に実行します。

### 2. 現行マイグレーション

```powershell
cd C:\stationhead-monitor\worker

npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\004_collector_coordination.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\005_cloud_host_monitor.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\006_email_weekly_summary.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\migrations\007_host_session_safety.sql
```

各ファイルは空のSQLiteへ2回適用するCIテストを通しています。

### 3. WorkerのSecret

```powershell
cd C:\stationhead-monitor\worker

npx wrangler secret put EMAIL_RECAP_SECRET --name stationhead-monitor-collector --config .\wrangler.jsonc
```

`RUN_SECRET`や`INGEST_SECRET`を外部HTTPエンドポイントで使用する場合は同様に登録します。Secret値をリポジトリやチャットへ貼らないでください。

### 4. Workerデプロイ

```powershell
cd C:\stationhead-monitor\worker
npm install
npm run check
npx wrangler deploy --config .\wrangler.jsonc
```

## Local Collector

### 環境設定

```powershell
cd C:\stationhead-monitor\collector
Copy-Item .env.example .env
notepad .env
```

最低限、次を設定します。

```env
INGEST_URL=https://YOUR-PAGES-DOMAIN.pages.dev/api/ingest
INGEST_SECRET=CHANGE_ME
COLLECTOR_MODE=auto
COORDINATION_URL=https://stationhead-monitor-collector.tarematsu.workers.dev/coordination/lease
```

### 起動

通常運用:

```powershell
cd C:\stationhead-monitor\collector
npm install
npm start
```

強制稼働:

```powershell
npm run start:active
```

完全待機:

```powershell
npm run start:standby
```

従来Collectorを直接起動:

```powershell
npm run start:direct
```

1回だけ取得:

```powershell
npm run once
```

## Google Apps Script

GASは6時間ごとにGmailのBuddies Channel Recapを確認し、解析した週・送信時刻・累計StreamsだけをWorkerへ送ります。メール本文全体は送信しません。

設定資料:

```text
gas/stationhead-email-recap/
```

GASとWorkerには同じ`EMAIL_RECAP_SECRET`を設定します。

## ヘルス確認

Worker:

```text
https://stationhead-monitor-collector.tarematsu.workers.dev/health
```

Collectorリース:

```text
https://stationhead-monitor-collector.tarematsu.workers.dev/coordination/lease
```

期待値:

```json
{
  "ok": true,
  "healthy": true,
  "holder_id": "cloudflare-worker"
}
```

D1確認:

```powershell
cd C:\stationhead-monitor\worker

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT scope,holder_id,datetime(lease_until/1000,'unixepoch','+9 hours') AS lease_until_jst FROM sh_collector_leases;"

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT data_type,collector_id,source_priority,COUNT(*) AS count FROM sh_ingest_claims GROUP BY data_type,collector_id,source_priority ORDER BY data_type,source_priority DESC;"

npx wrangler d1 execute stationhead-monitor --remote --command="SELECT resolution,COUNT(*) AS count FROM sh_ingest_conflicts GROUP BY resolution;"
```

## テスト

GitHub Actionsとローカルで次を検査します。

- 全JavaScript/MJSの構文
- Collector ID・優先度・ハッシュの単体テスト
- マイグレーションの2回適用とトリガー動作
- Wrangler dry-runバンドル

```powershell
cd C:\stationhead-monitor\collector
npm run check

cd ..\worker
npm install
npx wrangler deploy --dry-run --outdir=dist-dry-run

cd ..
node --test tests\*.test.mjs
python -m unittest tests\sql_migrations_test.py -v
```

## 本番切替確認

1. D1マイグレーションを投入
2. Workerをデプロイ
3. `/health`と`/coordination/lease`を確認
4. D1へCloud Collectorのclaimsが作成されることを確認
5. Localを`auto`で起動し、Worker正常時に子Collectorが起動しないことを確認
6. Worker Cronを一時停止する検証環境で、180秒後にLocalが昇格することを確認
7. Worker復旧後にLocalが停止することを確認
8. `active`で両方を動かし、1分あたりの論理スナップショットが1件であることを確認

## 安全設計

- 同一論理データは`sh_ingest_claims`で1件に限定
- 高優先度の取得元を採用
- 内容不一致は`sh_ingest_conflicts`へ記録
- コメントID、Spotify ID、メール週、セッションIDなど既存ユニーク制約も併用
- メール値変更・非単調・異常増加は自動登録を拒否
- メール値は週次履歴の欠損アンカーへ反映
- Worker失敗とホスト監視失敗は他の収集処理を停止させない

## 注意

ローカル通信断中のディスクOutboxは別PRでCollector内部へ追加します。現在も次回ポーリングで再取得できるスナップショット・コメント・キューは復旧後に補完されますが、完全な送信キューではありません。
