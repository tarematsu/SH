import { collectRawChannel } from './raw-collector-entry.js';

const EMPTY_DEPENDENCIES = Object.freeze({});

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(collectRawChannel(env, EMPTY_DEPENDENCIES));
  },
};
