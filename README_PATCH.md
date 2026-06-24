# コメントAPI構造修正版

Stationhead の chatHistory は次の形式を返します。

```json
{
  "chats": {
    "next": "...",
    "items": []
  }
}
```

`collector/collector.mjs` の `normalizeComments()` を `chats.items` 対応に修正し、配列でない値に `map()` を呼ばないようにしました。
