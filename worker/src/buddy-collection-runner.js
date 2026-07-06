import { collectBuddyPlayback } from './buddy-playback.js';
import { createBuddyGuardedFetch } from './buddy-fetch-guard.js';
import { collectBuddyPlaybackReady } from './buddy-runtime.js';

function metadataDisabled(env = {}) {
  const value = env.BUDDY_PLAYBACK_METADATA_LIMIT;
  if (value === undefined || value === null || value === '') return false;
  return Number(value) === 0;
}

export function createBuddyCollectionDependencies(env = {}, dependencies = {}) {
  const alias = String(env.BUDDY_PLAYBACK_ALIAS || 'buddy46').trim().toLowerCase() || 'buddy46';
  const baseFetch = dependencies.fetch || fetch;
  const guardedFetch = createBuddyGuardedFetch(baseFetch, alias);
  const baseCollect = dependencies.collect || collectBuddyPlayback;
  const disableMetadata = metadataDisabled(env);

  return {
    ...dependencies,
    fetch: baseFetch,
    collect(authenticatedEnv, observedAt, runtimeDependencies = {}) {
      return baseCollect(authenticatedEnv, observedAt, {
        ...runtimeDependencies,
        fetch: guardedFetch,
        ...(disableMetadata ? { fetchTrackMetadata: async () => null } : {}),
      });
    },
  };
}

export function collectBuddyPlaybackGuarded(env, observedAt = Date.now(), dependencies = {}) {
  return collectBuddyPlaybackReady(
    env,
    observedAt,
    createBuddyCollectionDependencies(env, dependencies),
  );
}
