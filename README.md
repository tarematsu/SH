# Stationhead ホスト並行監視システム

既存のBuddies監視を止めず、同じ`collector.mjs`プロセス内へ次の2系統を追加します。

1. `sakuramankai`のプロフィール・フォロワー推移を1時間ごとに保存
2. `sakurazaka46jp`の単独放送を1分ごとに監視し、検知時だけ詳細収集

通信調査で確認したAPIを使用します。

```text
POST /station/handle/{handle}/guest
GET  /account?ids={account_id}&channelId=318
GET  /station/{station_id}/chatHistory?limit=100
```

## 単独放送の判定

次をすべて満たす場合に候補とします。

- `sakurazaka46jp`が放送中
- 取得した`station_id`がBuddiesの現在ステーションと異なる
- チャンネル情報がない、Buddies以外、またはステーションがBuddiesの現在値と異なる

初回検知時点で`provisional`セッションを作り、スナップショット・キュー・コメントを保存します。
2回連続で検出したら`active`へ昇格し、専用WebSocketを開始します。
放送終了またはBuddiesと同一になった状態を3回連続で確認すると終了します。

## 保存内容

- `sakuramankai`: followers / following / total_streams / active_stream_days / 画像 / バッジ
- 単独放送セッション: 開始・確認・終了、放送ID、ステーションID、理由
- 1分ごとの同接、累計聴取、現在曲
- 最大同接・平均同接・サンプル数
- キュー全体と各曲のSpotify/Apple Music/Deezer/ISRC/時間
- コメント
- WebSocket生イベント
- 単独放送開始・終了時および1時間ごとのプロフィール値

## 導入

ZIP内の内容を`C:\stationhead-monitor`へ上書きします。

### 1. D1テーブル作成

```powershell
cd C:\stationhead-monitor
npx wrangler d1 execute stationhead-monitor --remote --file=database/host-monitoring.sql
```

### 2. 既存Collectorへ統合

```powershell
node tools\apply-host-monitor.mjs
```

この処理は既存`collector/collector.mjs`を上書きする前に、次のバックアップを作ります。

```text
collector/collector.mjs.before-host-monitor
```

同じコマンドを複数回実行しても重複挿入しません。

### 3. 環境設定

`collector/.env`へ追加します。

```env
HOST_MONITOR_ENABLED=true
HOST_PROFILE_HANDLE=sakuramankai
HOST_PROFILE_ACCOUNT_ID=3334889
HOST_PROFILE_INTERVAL_MS=3600000

SOLO_BROADCAST_HANDLE=sakurazaka46jp
SOLO_BROADCAST_ACCOUNT_ID=0
SOLO_POLL_INTERVAL_MS=60000
SOLO_CONFIRM_POLLS=2
SOLO_END_CONFIRM_POLLS=3
SOLO_CHAT_LIMIT=100
SOLO_PROFILE_INTERVAL_MS=3600000
SOLO_ENABLE_WEBSOCKET=true
```

`SOLO_BROADCAST_ACCOUNT_ID=0`では、単独放送APIの`owner_id`から自動取得します。

### 4. 構文確認

```powershell
node --check collector\collector.mjs
node --check collector\host-monitor.mjs
node --check site\functions\api\host-ingest.js
node --check site\functions\api\host-history.js
```

### 5. GitHubへ反映

```powershell
git add collector/collector.mjs collector/host-monitor.mjs site/functions/api/host-ingest.js site/functions/api/host-history.js database/host-monitoring.sql tools/apply-host-monitor.mjs
git commit -m "Add host profile and solo broadcast monitoring"
git push
```

### 6. Collector再起動

```powershell
cd C:\stationhead-monitor\collector
npm start
```

起動時にBuddies監視、プロフィール監視、単独放送監視が同一プロセス内で開始します。

## 動作確認

1回だけ実行:

```powershell
cd C:\stationhead-monitor\collector
npm run once
```

`sakuramankai`の最新プロフィール:

```text
https://stationhead-monitor.pages.dev/api/host-history?mode=profile&handle=sakuramankai&days=30
```

単独放送セッション一覧:

```text
https://stationhead-monitor.pages.dev/api/host-history?mode=sessions&handle=sakurazaka46jp
```

概要:

```text
https://stationhead-monitor.pages.dev/api/host-history
```

## D1確認

```powershell
npx wrangler d1 execute stationhead-monitor --remote --command="SELECT observed_at,handle,followers,total_streams FROM sh_host_profile_snapshots ORDER BY observed_at DESC LIMIT 10;"
```

```powershell
npx wrangler d1 execute stationhead-monitor --remote --command="SELECT id,handle,station_id,started_at,ended_at,status,peak_listeners,average_listeners,track_count,comment_count FROM sh_host_broadcast_sessions ORDER BY started_at DESC LIMIT 20;"
```

## 既存週間リーダーボードとの関係

`weekly-leaderboard.mjs`は別スケジュールですが、本システムと競合しません。Buddies・ホスト監視は`collector.mjs`内、週間リーダーボードは月曜夜だけ独立して動作します。
