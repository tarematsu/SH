# Stationhead Chrome認証自動取得版

- `npm start`時にChrome/Chromiumを短時間だけ起動します。
- Buddiesページが実際に送信した `Authorization` と `sth-device-uid` を取得します。
- 認証情報は `collector/.sh-session.json` に保存します。
- JWT期限接近時または401時に同じ処理を自動実行します。
- `.env` の `STATIONHEAD_AUTH_TOKEN` と `STATIONHEAD_DEVICE_UID` は不要です。

Windowsの通常のChromeは自動検出します。検出できない場合だけ `.env` に以下を追加します。

```env
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
AUTH_BROWSER_TIMEOUT_MS=45000
```

適用後:

```powershell
cd collector
npm install
npm start
```
