import { collectBuddyPlayback } from './buddy-playback.js';
import { collectBuddyPlaybackReady } from './buddy-runtime.js';

export function createBuddyCollectionDependencies(_env = {}, dependencies = {}) {
  const baseFetch = dependencies.fetch || fetch;
  const baseCollect = dependencies.collect || collectBuddyPlayback;

  return {
    ...dependencies,
    fetch: baseFetch,
    collect(runtimeEnv, observedAt, runtimeDependencies = {}) {
      return baseCollect(runtimeEnv, observedAt, {
        ...runtimeDependencies,
        fetch: baseFetch,
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
