# Stationhead 週間リーダーボード通信調査

Stationhead公式の週間リーダーボードページを開き、API通信・表示内容・WebSocketを記録します。

対象ページ:

```text
https://www.stationhead.com/on/leaderboard
```

## 配置

`capture-leaderboard.mjs`を次へコピーします。

```text
C:\sh-monitor\collector\capture-leaderboard.mjs
```

## 実行

```powershell
cd C:\sh-monitor\collector
node capture-leaderboard.mjs
```

ブラウザが開いたら、期間切替やタブがあれば一度ずつ押し、ランキングの末尾までスクロールします。
終了時にPowerShellへ戻ってEnterを押します。

## 出力場所

```text
C:\sh-monitor\collector\captures\weekly-leaderboard\
```

分析に必要なファイル:

```text
leaderboard-candidates.json
network.json
summary.json
visible-text.txt
```

Authorization、Cookie、Set-Cookieは自動的に伏せます。

## 自動取得の予定設計

API確定後、既存Collectorへ次のスケジュールを追加します。

- 月曜日 18:00〜23:59 JST: 15分間隔で更新確認
- 新しい週を検出した時点で全順位を保存
- 同一週・同一ホストは上書きし、重複を作らない
- 月曜日に更新されなければ火曜日 00:00〜02:00 JSTも確認
- 保存後は翌週まで取得を停止
