# Stationhead表示・複数収集対応アップグレード

## 主な変更

- オンライン数を主指標に変更
- リスナー数をオンライン数の内訳として表示
- コメント欄を非表示
- 直近24時間のストリーム推移から目標到達日時を予測
- Buddies、App Store、Google Playへのリンクを追加
- Spotify曲情報はD1キャッシュのみ参照
- 複数Collectorの同時実行に対応
  - チャンネル・キュースナップショットを1分単位で重複排除
  - WebSocketイベントを5秒単位＋内容一致で重複排除
  - 曲メタデータはSpotify IDでUPSERT
  - Collectorごとのハートビートを保存

## 適用順序

### 1. ファイルを上書き

このZIPの内容を既存プロジェクトへ同じパスで上書きしてください。

### 2. D1スキーマを適用

```powershell
cd C:\Users\yuuki\Documents\stationhead-monitor
npx wrangler d1 execute stationhead-monitor --remote --file=database/schema.sql
```

既存テーブルは削除されません。`sh_collector_heartbeats`だけ追加されます。

### 3. GitHubへ反映

```powershell
git add site database collector/collector.mjs
git commit -m "Upgrade dashboard and multi collector support"
git push
```

### 4. Collectorを起動

```powershell
cd collector
npm start
```

複数環境で動かす場合は、それぞれの`.env`へ識別名を指定できます。

```env
COLLECTOR_ID=home-windows
```

クラウド側は例として次のようにします。

```env
COLLECTOR_ID=oracle-osaka
```

未指定時はPCまたはVMのホスト名が使われます。

## 予測について

- 直近24時間の`current_stream_count`を線形回帰
- 最低5件かつ15分以上の履歴が必要
- 増加速度が0以下の場合は予測を表示しない
- R²と履歴時間から「信頼度 高・中・低」を表示
- あくまで現在の増加ペースが継続した場合の推定

## 検索エンジン除外

`robots.txt`、HTMLのrobotsメタタグ、Cloudflare Pagesの`X-Robots-Tag`ヘッダーでサイト全体をnoindexにしています。既に検索結果へ登録済みの場合、検索結果から消えるまで時間がかかることがあります。

## Stationhead匿名認証の自動更新

Collectorは`.stationhead-session.json`へ端末UIDと最新ゲストJWTを保存します。JWT期限の1時間前、またはAPIが401を返した時に、Stationheadの公開bootstrapレスポンスから新しい`Authorization`ヘッダーを取得して一度だけ再試行します。`.env`の`STATIONHEAD_AUTH_TOKEN`と`STATIONHEAD_DEVICE_UID`は初回フォールバックとして残せますが、以後は保存済みセッションを優先します。

`.gitignore`へ以下を追加してください。

```gitignore
collector/.env
collector/.stationhead-session.json
collector/node_modules/
```
