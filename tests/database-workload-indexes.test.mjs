import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const migration=readFileSync(new URL('../database/migrations/010_database_workload_indexes.sql',import.meta.url),'utf8');
test('database workload indexes are repeatable',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`
 CREATE TABLE sh_channel_snapshots(id INTEGER PRIMARY KEY,channel_id INTEGER,observed_at INTEGER);
 CREATE TABLE sh_comments(id INTEGER PRIMARY KEY,station_id INTEGER,chat_time_ms INTEGER,chat_time INTEGER,observed_at INTEGER);
 CREATE TABLE sh_track_like_observations(id INTEGER PRIMARY KEY,station_id INTEGER,track_key TEXT,observed_at INTEGER);
 CREATE TABLE sh_host_station_snapshots(id INTEGER PRIMARY KEY,session_id INTEGER,observed_at INTEGER);
 CREATE TABLE sh_host_comments(id INTEGER PRIMARY KEY,session_id INTEGER,chat_time_ms INTEGER,chat_time INTEGER,observed_at INTEGER);
 CREATE TABLE sh_host_queue_items(id INTEGER PRIMARY KEY,session_id INTEGER,stationhead_track_id INTEGER,spotify_id TEXT,queue_track_id INTEGER);
 CREATE TABLE sh_legacy_snapshots(id INTEGER PRIMARY KEY,host_handle TEXT,observed_at INTEGER,source_note TEXT);
 CREATE TABLE sh_channel_rankings(id INTEGER PRIMARY KEY,ranking_date TEXT,channel_name TEXT,rank INTEGER);`);
 db.exec(migration);db.exec(migration);
 const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row)=>row.name));
 for(const name of ['idx_sh_channel_snapshots_channel_time_id','idx_sh_comments_station_effective_time','idx_sh_track_like_observations_station_track_time','idx_sh_host_station_snapshots_session_time_id','idx_sh_host_comments_session_effective_time','idx_sh_host_queue_items_session_identity','idx_sh_legacy_snapshots_host_time_source','idx_sh_channel_rankings_date_name_rank'])assert.ok(names.has(name),name);
});
