const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const token = String(
  process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_BUILDS_API_TOKEN
    || process.env.CF_API_TOKEN
    || '',
).trim();
const legacyName = 'sh-monitor-minute';

if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
if (!token) throw new Error('Cloudflare API token is required');

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${legacyName}`;
const headers = { Authorization: `Bearer ${token}` };
const current = await fetch(endpoint, { headers });

if (current.status === 404) {
  console.log(`${legacyName} is already retired.`);
  process.exit(0);
}
if (!current.ok) {
  throw new Error(`failed to inspect ${legacyName}: ${current.status} ${await current.text()}`);
}

const removed = await fetch(endpoint, { method: 'DELETE', headers });
if (!removed.ok) {
  throw new Error(`failed to retire ${legacyName}: ${removed.status} ${await removed.text()}`);
}

console.log(`Retired legacy Worker ${legacyName}.`);
