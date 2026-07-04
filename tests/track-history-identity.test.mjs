import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeTrackRows } from '../site/functions/lib/track-history-merge.js';
import { bestText, looksLikePlaceholder } from '../site/functions/lib/track-history-text.js';

test('artist placeholders are treated as missing metadata',()=>{
  assert.equal(looksLikePlaceholder('-'),true);
  assert.equal(looksLikePlaceholder('—'),true);
  assert.equal(bestText('-', '櫻坂46'),'櫻坂46');
  assert.equal(bestText('アーティスト不明'),null);
});

test('same recording still aggregates by ISRC without repairing display metadata',()=>{
  const rows=mergeTrackRows([
    {play_date:'2026-07-01',played_at:1000,play_count:2,title:'Interlude #1',artist:'-',spotify_id:'spotify-a',isrc:'JPABC2600001'},
    {play_date:'2026-07-01',played_at:2000,play_count:3,title:'Interlude #1',artist:'櫻坂46',spotify_id:'spotify-b',isrc:'jpabc2600001'},
  ]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].play_count,5);
  assert.equal(rows[0].artist,null);
  assert.equal(rows[0].track_key,'isrc:JPABC2600001');
  assert.deepEqual(new Set(rows[0].source_ids),new Set(['spotify-a','spotify-b','JPABC2600001']));
});

test('identifier bridge still aggregates partial observations',()=>{
  const rows=mergeTrackRows([
    {play_date:'2026-07-01',played_at:1000,play_count:1,title:'Interlude #1',artist:'櫻坂46',spotify_id:'spotify-a',isrc:'JPABC2600001'},
    {play_date:'2026-07-01',played_at:2000,play_count:1,title:'Interlude #1',artist:'櫻坂46',spotify_id:'spotify-a'},
    {play_date:'2026-07-01',played_at:3000,play_count:1,title:'Interlude #1',artist:'櫻坂46',spotify_id:'spotify-b',isrc:'JPABC2600001'},
  ]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].play_count,3);
});

test('id-less rows are no longer inferred from matching titles',()=>{
  const rows=mergeTrackRows([
    {play_date:'2026-07-01',played_at:1000,play_count:1,title:'Interlude #1',artist:'櫻坂46'},
    {play_date:'2026-07-01',played_at:2000,play_count:1,title:'Interlude #1',artist:'-'},
  ]);
  assert.equal(rows.length,2);
});

test('identical ids on different UTC dates remain separate daily counts',()=>{
  const rows=mergeTrackRows([
    {play_date:'2026-07-01',played_at:1000,play_count:1,title:'Song',artist:'Artist',spotify_id:'spotify-a'},
    {play_date:'2026-07-02',played_at:2000,play_count:2,title:'Song',artist:'Artist',spotify_id:'spotify-a'},
  ]);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map((row)=>row.play_date),['2026-07-02','2026-07-01']);
});
