import WebSocket from 'ws';
import {
  boolEnv,
  deriveHostIngestUrl,
  nonNegativeNumber,
  normalizeComments,
  normalizeProfile,
  normalizeQueue,
  parsePusherData,
  positiveNumber,
  sha256,
  stationIdentity,
} from './host-monitor-normalize.mjs';

const PUSHER_KEY = '982c86a21530b654bfb2';
const PUSHER_URL = `wss://realtime-production.stationhead.com/app/${PUSHER_KEY}?protocol=7&client=js&version=7.4.0&flash=false`;

export function createHostMonitoring(options) {
  return new HostMonitoring(options);
}

class HostMonitoring {
  constructor(options) {
    this.apiBase = options.apiBase;
    this.fetchJson = options.fetchJson;
    this.ingestUrl = deriveHostIngestUrl(options.ingestUrl);
    this.ingestSecret = options.ingestSecret;
    this.collectorId = options.collectorId;
    this.collectorKind = options.collectorKind || process.env.COLLECTOR_KIND || 'local';
    this.sourcePriority = Number(options.sourcePriority || process.env.SOURCE_PRIORITY || (/[-_:]active(?:$|[-_:])/i.test(this.collectorId) ? 80 : 70));
    this.getBuddiesState = options.getBuddiesState;
    this.enrichTracks = options.enrichTracks;
    this.log = options.log || ((level, ...args) => console.log(level, ...args));

    this.config = {
      enabled: boolEnv('HOST_MONITOR_ENABLED', true),
      profileHandle: process.env.HOST_PROFILE_HANDLE || 'sakuramankai',
      profileAccountId: nonNegativeNumber('HOST_PROFILE_ACCOUNT_ID', 3334889) || null,
      profileIntervalMs: positiveNumber('HOST_PROFILE_INTERVAL_MS', 60 * 60 * 1000),
      soloHandle: process.env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp',
      soloAccountId: nonNegativeNumber('SOLO_BROADCAST_ACCOUNT_ID', 0) || null,
      soloPollIntervalMs: positiveNumber('SOLO_POLL_INTERVAL_MS', 60 * 1000),
      soloConfirmPolls: positiveNumber('SOLO_CONFIRM_POLLS', 2),
      soloEndConfirmPolls: positiveNumber('SOLO_END_CONFIRM_POLLS', 3),
      soloChatLimit: positiveNumber('SOLO_CHAT_LIMIT', 100),
      soloProfileIntervalMs: positiveNumber('SOLO_PROFILE_INTERVAL_MS', 60 * 60 * 1000),
      enableWebSocket: boolEnv('SOLO_ENABLE_WEBSOCKET', true),
    };

    this.timers = new Set();
    this.stopped = false;
    this.profileRunning = false;
    this.soloRunning = false;
    this.solo = {
      phase: 'idle',
      sessionId: null,
      stationId: null,
      accountId: this.config.soloAccountId,
      candidateCount: 0,
      endCount: 0,
      lastQueueHash: null,
      lastProfileAt: 0,
      ws: null,
      wsReconnectTimer: null,
      startedAt: null,
    };
  }

  async start({ once = false } = {}) {
    if (!this.config.enabled) {
      this.log('info', 'host monitoring disabled');
      return;
    }

    this.log('info', `host monitoring enabled profile=@${this.config.profileHandle} solo=@${this.config.soloHandle}`);
    await Promise.all([
      this.safeRun('profile initial', () => this.collectProfile()),
      this.safeRun('solo initial', () => this.probeSolo()),
    ]);

    if (once) return;

    this.addInterval(() => this.safeRun('profile poll', () => this.collectProfile()), this.config.profileIntervalMs);
    this.addInterval(() => this.safeRun('solo poll', () => this.probeSolo()), this.config.soloPollIntervalMs);
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    if (this.solo.wsReconnectTimer) clearTimeout(this.solo.wsReconnectTimer);
    this.solo.wsReconnectTimer = null;
    this.solo.ws?.close(1000, 'shutdown');
    this.solo.ws = null;
  }

  addInterval(fn, delay) {
    const timer = setInterval(fn, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  async safeRun(label, fn) {
    try {
      return await fn();
    } catch (error) {
      this.log('error', `${label} failed`, error?.message || error);
      return null;
    }
  }

  async hostIngest(type, data, observedAt = Date.now()) {
    const response = await fetch(this.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.ingestSecret}`,
      },
      body: JSON.stringify({
        type,
        observed_at: observedAt,
        collector_id: this.collectorId,
        collector_kind: this.collectorKind,
        source_priority: this.sourcePriority,
        data,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`host ingest failed ${response.status}: ${responseText.slice(0, 500)}`);
    return responseText ? JSON.parse(responseText) : {};
  }

  async fetchStation(handle) {
    return this.fetchJson(`${this.apiBase}/station/handle/${encodeURIComponent(handle)}/guest`, {
      method: 'POST',
      body: '{}',
    });
  }

  async fetchAccount(accountId) {
    if (!accountId) return null;
    const buddies = this.getBuddiesState?.() || {};
    const channelId = Number(buddies.channelId) || 318;
    const payload = await this.fetchJson(
      `${this.apiBase}/account?ids=${encodeURIComponent(accountId)}&channelId=${encodeURIComponent(channelId)}`,
    );
    return payload?.accounts?.[0] || null;
  }

  async collectProfile() {
    if (this.profileRunning || this.stopped) return;
    this.profileRunning = true;
    try {
      let accountId = this.config.profileAccountId;
      if (!accountId) {
        const station = await this.fetchStation(this.config.profileHandle);
        accountId = stationIdentity(station).account_id;
      }
      if (!accountId) throw new Error(`account id not found for @${this.config.profileHandle}`);
      const account = await this.fetchAccount(accountId);
      const profile = normalizeProfile(account, this.config.profileHandle);
      if (!profile?.handle) throw new Error(`profile response missing for account ${accountId}`);
      await this.hostIngest('host_profile_snapshot', profile);
      this.log('info', `profile saved @${profile.handle} followers=${profile.followers ?? '-'} total_streams=${profile.total_streams ?? '-'}`);
    } finally {
      this.profileRunning = false;
    }
  }

  soloDecision(station) {
    const identity = stationIdentity(station);
    const buddies = this.getBuddiesState?.() || {};
    const buddiesStationId = Number(buddies.stationId) || null;
    const buddiesChannelId = Number(buddies.channelId) || 318;
    const isBroadcasting = Boolean(station?.is_broadcasting && station?.broadcast);

    if (!isBroadcasting || !identity.station_id) {
      return { candidate: false, reason: 'not_broadcasting', identity, buddies };
    }
    if (!buddiesStationId) {
      return { candidate: false, reason: 'buddies_state_unavailable', identity, buddies };
    }
    if (identity.station_id === buddiesStationId) {
      return { candidate: false, reason: 'same_as_buddies_station', identity, buddies };
    }

    const reasons = ['station_id_diff'];
    if (!identity.channel_id) reasons.push('channel_missing');
    if (identity.channel_id && identity.channel_id !== buddiesChannelId) reasons.push('channel_id_diff');
    if (identity.channel_alias && identity.channel_alias !== 'buddies') reasons.push('channel_alias_diff');

    return {
      candidate: true,
      reason: reasons.join(','),
      identity,
      buddies,
    };
  }

  async probeSolo() {
    if (this.soloRunning || this.stopped) return;
    this.soloRunning = true;
    try {
      const observedAt = Date.now();
      const station = await this.fetchStation(this.config.soloHandle);
      const decision = this.soloDecision(station);

      if (decision.candidate) {
        await this.handleSoloCandidate(station, decision, observedAt);
      } else {
        await this.handleSoloAbsent(station, decision, observedAt);
      }
    } finally {
      this.soloRunning = false;
    }
  }

  async handleSoloCandidate(station, decision, observedAt) {
    const identity = decision.identity;

    if (this.solo.sessionId && this.solo.stationId !== identity.station_id) {
      await this.closeSoloSession('station_changed', observedAt, {}, 'ended');
    }

    if (!this.solo.sessionId) {
      const opened = await this.hostIngest('solo_session_open', {
        source_scope: 'sakurazaka46jp_solo',
        handle: this.config.soloHandle,
        account_id: identity.account_id,
        station_id: identity.station_id,
        broadcast_id: identity.broadcast_id,
        broadcast_stream_id: identity.broadcast_stream_id,
        started_at: identity.broadcast_start_time || observedAt,
        detection_reason: decision.reason,
        buddies_station_id: Number(decision.buddies.stationId) || null,
        channel_id: identity.channel_id,
        channel_alias: identity.channel_alias,
        total_listens_start: station?.total_listens ?? null,
        raw: station,
      }, observedAt);

      this.solo.phase = 'provisional';
      this.solo.sessionId = Number(opened.session_id);
      this.solo.stationId = identity.station_id;
      this.solo.accountId = identity.account_id || this.solo.accountId;
      this.solo.candidateCount = 1;
      this.solo.endCount = 0;
      this.solo.lastQueueHash = null;
      this.solo.lastProfileAt = 0;
      this.solo.startedAt = identity.broadcast_start_time || observedAt;
      this.log('warn', `solo broadcast provisional @${this.config.soloHandle} station=${identity.station_id}`);
    } else {
      this.solo.candidateCount += 1;
      this.solo.endCount = 0;
    }

    await this.collectSoloDetails(station, observedAt);

    if (this.solo.phase === 'provisional' && this.solo.candidateCount >= this.config.soloConfirmPolls) {
      await this.hostIngest('solo_session_confirm', {
        session_id: this.solo.sessionId,
        confirmed_at: observedAt,
      }, observedAt);
      this.solo.phase = 'active';
      this.log('info', `solo broadcast confirmed @${this.config.soloHandle} session=${this.solo.sessionId}`);
      this.connectSoloWebSocket();
    }
  }

  async handleSoloAbsent(station, decision, observedAt) {
    if (!this.solo.sessionId) {
      this.log('debug', `solo watcher idle reason=${decision.reason}`);
      return;
    }

    if (this.solo.phase === 'provisional') {
      await this.closeSoloSession('provisional_not_confirmed', observedAt, station, 'cancelled');
      return;
    }

    this.solo.endCount += 1;
    this.log('info', `solo end candidate ${this.solo.endCount}/${this.config.soloEndConfirmPolls} reason=${decision.reason}`);
    if (this.solo.endCount >= this.config.soloEndConfirmPolls) {
      await this.closeSoloSession(decision.reason, observedAt, station, 'ended');
    }
  }

  async collectSoloDetails(station, observedAt) {
    if (!this.solo.sessionId) return;
    const identity = stationIdentity(station);
    const queue = normalizeQueue(station, observedAt);

    await this.hostIngest('solo_station_snapshot', {
      session_id: this.solo.sessionId,
      source_scope: 'sakurazaka46jp_solo',
      handle: this.config.soloHandle,
      account_id: identity.account_id,
      station_id: identity.station_id,
      broadcast_id: identity.broadcast_id,
      broadcast_start_time: identity.broadcast_start_time,
      is_broadcasting: station?.is_broadcasting ?? null,
      status: station?.status ?? null,
      chat_status: station?.chat_status ?? null,
      listener_count: station?.listener_count ?? null,
      guest_count: station?.guest_count ?? null,
      total_listens: station?.total_listens ?? null,
      channel_id: identity.channel_id,
      channel_alias: identity.channel_alias,
      current_track_id: queue?.current_track_id ?? null,
      current_spotify_id: queue?.current_spotify_id ?? null,
      queue_id: queue?.queue_id ?? null,
      queue_start_time: queue?.start_time ?? null,
      raw: station,
    }, observedAt);

    if (queue) {
      const queueHash = sha256({
        start_time: queue.start_time,
        is_paused: queue.is_paused,
        tracks: queue.tracks.map((track) => [
          track.queue_track_id,
          track.stationhead_track_id,
          track.spotify_id,
          track.duration_ms,
        ]),
      });
      if (queueHash !== this.solo.lastQueueHash) {
        await this.hostIngest('solo_queue', {
          session_id: this.solo.sessionId,
          queue_hash: queueHash,
          ...queue,
        }, observedAt);
        this.solo.lastQueueHash = queueHash;
        await this.enrichTracks?.(queue, observedAt).catch((error) => {
          this.log('warn', 'solo track enrichment failed', error.message);
        });
      }
    }

    if (identity.station_id) {
      const history = await this.fetchJson(
        `${this.apiBase}/station/${identity.station_id}/chatHistory?limit=${this.config.soloChatLimit}`,
      );
      const comments = normalizeComments(history, identity.station_id);
      await this.hostIngest('solo_comments', {
        session_id: this.solo.sessionId,
        station_id: identity.station_id,
        comments,
      }, observedAt);
    }

    if (
      identity.account_id
      && observedAt - this.solo.lastProfileAt >= this.config.soloProfileIntervalMs
    ) {
      await this.collectSoloProfile(identity.account_id, observedAt);
    }
  }

  async collectSoloProfile(accountId, observedAt = Date.now()) {
    const account = await this.fetchAccount(accountId);
    const profile = normalizeProfile(account, this.config.soloHandle);
    if (!profile?.handle) return;
    await this.hostIngest('host_profile_snapshot', {
      ...profile,
      session_id: this.solo.sessionId,
      source_scope: 'sakurazaka46jp_solo',
    }, observedAt);
    this.solo.lastProfileAt = observedAt;
    this.solo.accountId = profile.account_id || accountId;
  }

  async closeSoloSession(reason, observedAt, station, status = 'ended') {
    if (!this.solo.sessionId) return;

    const sessionId = this.solo.sessionId;
    const accountId = this.solo.accountId || stationIdentity(station).account_id;
    let profile = null;
    if (accountId) {
      try {
        const account = await this.fetchAccount(accountId);
        profile = normalizeProfile(account, this.config.soloHandle);
        if (profile) {
          await this.hostIngest('host_profile_snapshot', {
            ...profile,
            session_id: sessionId,
            source_scope: 'sakurazaka46jp_solo',
          }, observedAt);
        }
      } catch (error) {
        this.log('warn', 'solo final profile failed', error.message);
      }
    }

    await this.hostIngest('solo_session_close', {
      session_id: sessionId,
      ended_at: observedAt,
      status,
      end_reason: reason,
      total_listens_end: station?.total_listens ?? null,
      followers_end: profile?.followers ?? null,
      total_streams_end: profile?.total_streams ?? null,
      raw: station,
    }, observedAt);

    this.stopSoloWebSocket();
    this.log('info', `solo session closed id=${sessionId} status=${status} reason=${reason}`);
    this.solo.phase = 'idle';
    this.solo.sessionId = null;
    this.solo.stationId = null;
    this.solo.candidateCount = 0;
    this.solo.endCount = 0;
    this.solo.lastQueueHash = null;
    this.solo.lastProfileAt = 0;
    this.solo.startedAt = null;
  }

  subscribe(ws, channel) {
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }));
  }

  soloChannels() {
    const id = this.solo.stationId;
    if (!id) return [];
    return [
      `production1_station_${id}_broadcast`,
      `production1_station_${id}_listener_count`,
      `production1_station_${id}_queue`,
      `production1_station_${id}_chats`,
      `production1_station_${id}_channel`,
      `production1_station_${id}`,
    ];
  }

  connectSoloWebSocket() {
    if (!this.config.enableWebSocket || this.stopped || this.solo.phase !== 'active' || !this.solo.stationId) return;
    if (this.solo.ws) return;

    const ws = new WebSocket(PUSHER_URL, { headers: { origin: 'https://www.stationhead.com' } });
    this.solo.ws = ws;

    ws.on('message', (raw) => {
      this.handleSoloWsMessage(raw).catch((error) => this.log('warn', 'solo websocket message failed', error.message));
    });
    ws.on('error', (error) => this.log('warn', 'solo websocket error', error.message));
    ws.on('close', (code, reason) => {
      if (this.solo.ws === ws) this.solo.ws = null;
      this.log('warn', `solo websocket closed code=${code} reason=${reason}`);
      this.scheduleSoloWsReconnect();
    });
  }

  stopSoloWebSocket() {
    if (this.solo.wsReconnectTimer) clearTimeout(this.solo.wsReconnectTimer);
    this.solo.wsReconnectTimer = null;
    this.solo.ws?.close(1000, 'solo session ended');
    this.solo.ws = null;
  }

  scheduleSoloWsReconnect() {
    if (
      this.stopped
      || this.solo.phase !== 'active'
      || this.solo.wsReconnectTimer
      || !this.config.enableWebSocket
    ) return;
    const delay = 5_000 + Math.floor(Math.random() * 5_000);
    this.solo.wsReconnectTimer = setTimeout(() => {
      this.solo.wsReconnectTimer = null;
      this.connectSoloWebSocket();
    }, delay);
    this.solo.wsReconnectTimer.unref?.();
  }

  async handleSoloWsMessage(raw) {
    const envelope = JSON.parse(raw.toString());
    const data = parsePusherData(envelope.data);

    if (envelope.event === 'pusher:connection_established') {
      for (const channel of this.soloChannels()) this.subscribe(this.solo.ws, channel);
      this.log('info', `solo websocket connected station=${this.solo.stationId}`);
      return;
    }
    if (envelope.event === 'pusher:ping') {
      this.solo.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      return;
    }
    if (envelope.event?.startsWith('pusher_internal:')) return;
    if (!this.solo.sessionId) return;

    await this.hostIngest('solo_ws_event', {
      session_id: this.solo.sessionId,
      station_id: this.solo.stationId,
      channel: envelope.channel ?? null,
      event: envelope.event ?? null,
      data,
      raw: envelope,
    }, Date.now());
  }
}
