# リアルタイムSpotifyプレイリスト＋ページ内再生

## 機能
- Stationheadの現在曲＋予定曲をSpotifyプレイリストへ同期
- 曲順や内容が変わった時だけSpotify APIを更新
- D1へプレイリストURL・曲数・同期時刻を保存
- サイトにプレイリストリンクを表示
- 現在曲をSpotify Embedでページ内再生

## Spotify側の準備
1. Spotify Developer Dashboardでアプリを作成
2. Redirect URIに `http://127.0.0.1:43821/callback` を登録
3. `collector/.env`へ追加

```env
SPOTIFY_PLAYLIST_SYNC=true
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:43821/callback
SPOTIFY_PLAYLIST_NAME=Buddies Live Queue
SPOTIFY_PLAYLIST_PUBLIC=false
```

4. 初回だけ実行

```powershell
cd collector
npm install
npm run spotify-auth
```

ブラウザでSpotify認可後、表示された `SPOTIFY_REFRESH_TOKEN=...` を `.env`へ追加。

5. D1スキーマ適用・Pagesデプロイ後、通常起動

```powershell
npm start
```

## 注意
- ページ内再生はSpotify Embedを使用します。
- ブラウザの自動再生制限により、最初の再生は「このページで再生」を押す必要があります。
- Spotify Web APIのプレイリスト変更にはSpotify OAuthが必要です。
