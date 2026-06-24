import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const collectorPath = path.join(root, 'collector', 'collector.mjs');
const backupPath = `${collectorPath}.before-host-monitor`;

let source;
try {
  source = await fs.readFile(collectorPath, 'utf8');
} catch (error) {
  throw new Error(`collector not found: ${collectorPath}`);
}

if (!source.includes("import { createHostMonitoring } from './host-monitor.mjs';")) {
  const importAnchor = "import crypto from 'node:crypto';";
  if (!source.includes(importAnchor)) throw new Error('collector import anchor not found');
  source = source.replace(
    importAnchor,
    `${importAnchor}\nimport { createHostMonitoring } from './host-monitor.mjs';`,
  );
}

if (!source.includes('const hostMonitoring = createHostMonitoring({')) {
  const mainAnchor = `  await pollOnce();\n  if (once) return;`;
  if (!source.includes(mainAnchor)) throw new Error('collector main anchor not found');
  const integration = `  await pollOnce();\n\n  const hostMonitoring = createHostMonitoring({\n    apiBase: API_BASE,\n    fetchJson,\n    ingestUrl: config.ingestUrl,\n    ingestSecret: config.ingestSecret,\n    collectorId: config.collectorId,\n    getBuddiesState: () => ({\n      channelId: runtime.channelId,\n      stationId: runtime.stationId,\n      streamingPartyId: runtime.streamingPartyId,\n    }),\n    enrichTracks: enrichNewTracks,\n    log,\n  });\n  await hostMonitoring.start({ once });\n\n  if (once) return;`;
  source = source.replace(mainAnchor, integration);
}

if (!source.includes('hostMonitoring.stop();')) {
  const shutdownAnchor = `    clearInterval(timer);`;
  if (!source.includes(shutdownAnchor)) throw new Error('collector shutdown anchor not found');
  source = source.replace(shutdownAnchor, `${shutdownAnchor}\n    hostMonitoring.stop();`);
}

try {
  await fs.access(backupPath);
} catch {
  await fs.copyFile(collectorPath, backupPath);
}
await fs.writeFile(collectorPath, source, 'utf8');
console.log(`Patched: ${collectorPath}`);
console.log(`Backup : ${backupPath}`);
