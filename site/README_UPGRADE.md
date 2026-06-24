# Stationhead表示サイト 強化版

## 変更内容
- 新しい `sh_*` テーブルから表示
- 現在のリスナー、オンライン人数、総メンバー、累計Listen
- ストリーム目標の進捗
- 配信状態、ホスト、チャンネル画像
- 再生中の曲と進捗
- 今後の再生予定曲
- Spotify IDを公式oEmbedで曲名・アーティスト・ジャケットへ変換
- 24時間のリスナー／オンライン推移
- コメントをカード形式で表示
- スマホ対応

## 配置
このZIP内の `site` フォルダを既存の `stationhead-monitor/site` に上書きします。

## デプロイ
```powershell
cd C:\Users\yuuki\Documents\stationhead-monitor
git add site
git commit -m "Upgrade Stationhead dashboard"
git push
```

Cloudflare Pagesのデプロイ完了後、以下を開きます。

https://stationhead-monitor.pages.dev/

## 備考
曲名変換は `functions/api/dashboard.js` がSpotify公式oEmbedを呼び出します。Spotify Client IDやSecretは不要です。変換結果はCloudflare Cache APIへ7日間キャッシュします。

## sakurazaka46jp 過去放送データ追加

`database/sakurazaka46jp-history/README.md` の手順で `import.sql` をD1へ適用してください。履歴ページに「放送履歴」タブが追加され、詳細一覧にも放送名・いいね・コメント勢いが表示されます。
