import app from './email-recap-index.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';

export default {
  async scheduled(controller, env, ctx) {
    await app.scheduled(controller, env, ctx);
    ctx.waitUntil(runCloudWeeklyLeaderboard(env));
  },

  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
