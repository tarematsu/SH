# コメント勢い（直近2分）

`buddies` チャンネルと個別ホスト監視の両方で、コメント勢いを「観測時刻から直近120秒以内に投稿されたユニークコメント数」として保存します。

## D1更新

```powershell
cd C:\sh-monitor\site
npx wrangler d1 execute sh-db --remote --file=..\database\comment-velocity-2min.sql
```

その後、Pagesを再デプロイし、collectorを再起動してください。

- チャンネル: `sh_channel_snapshots.comment_velocity`
- 個別ホスト: `sh_host_station_snapshots.comment_velocity`
- 同一コメントIDはDB上で一意のため、毎分同じ履歴を再取得しても重複加算されません。
- 投稿時刻がないコメントだけ、初回観測時刻を代用します。
