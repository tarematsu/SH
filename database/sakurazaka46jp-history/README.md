# sakurazaka46jp 過去放送データ

Excel「公式リスパ - 櫻坂ステへ統計」から、6放送・518件を `sh_legacy_snapshots` に追加します。
既存のBuddies履歴は削除しません。

## D1へ反映

```powershell
cd C:\stationhead-monitor\site
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\history-schema.sql
npx wrangler d1 execute stationhead-monitor --remote --file=..\database\sakurazaka46jp-history\import.sql
```

`stationhead-monitor` は `site/wrangler.jsonc` のD1 database_nameと異なる場合、その名前に置き換えてください。
反映後にPagesを再デプロイすると、履歴ページの「放送履歴」タブと「詳細」タブで確認できます。

- 放送履歴: 放送単位の開始・終了、最大/平均同接、最大いいね、曲数
- 詳細: 取得日時、放送名、同接、曲名、いいね、コメント勢い
