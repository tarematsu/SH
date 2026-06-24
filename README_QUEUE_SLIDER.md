# プレイリスト廃止・予定曲スライダー版

- Spotifyプレイリスト同期機能を削除
- ページ内の現在曲Spotify再生は維持
- 今後の再生予定をメイン右側へ移動
- ストリーム目標をその下の全幅パネルへ移動
- 予定曲は約5曲分の高さに固定し、縦スクロールで全曲確認

`.env`から以下があれば削除してください。

```env
SPOTIFY_PLAYLIST_SYNC
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
SPOTIFY_REDIRECT_URI
SPOTIFY_REFRESH_TOKEN
SPOTIFY_PLAYLIST_NAME
SPOTIFY_PLAYLIST_PUBLIC
```

既存の `sh_spotify_playlist_state` テーブルは残っていても動作に影響しません。
