import { handleCollectorRequest } from './collector-http.js';
import { runCollection } from './collector-runner.js';

export {
  API_BASE,
  COLLECTOR_VERSION,
  DEFAULT_USER_AGENT,
  configFromEnv,
  firstDefined,
  shHeaders,
  shJson,
} from './collector-config.js';
export { collectOptionalComments } from './collector-comments.js';
export { authorized, handleCollectorRequest, health } from './collector-http.js';
export { ingest } from './collector-ingest.js';
export {
  extractIds,
  extractQueue,
  normalizeSnapshot,
  validateChannelPayload,
} from './collector-payload.js';
export { collectOnce, runCollection } from './collector-runner.js';
export {
  collectorStateFromAuthState,
  loadCollectorState,
  saveCollectorState,
} from './collector-state.js';

export default {
  async scheduled(controller, env) {
    const result = await runCollection(env, `cron:${controller.cron}`);
    console.log(JSON.stringify(result));
  },

  async fetch(request, env) {
    return handleCollectorRequest(request, env);
  },
};
