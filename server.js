import pg from 'pg';
import { createAuthenticator } from './auth.js';
import { createApp } from './app.js';
import { createService } from './service.js';
import { relworxProvider } from './provider.js';
const required = ['DATABASE_URL','RELWORX_API_KEY','RELWORX_ACCOUNT_NO','RELWORX_WEBHOOK_KEY','RELWORX_WEBHOOK_URL','AUTH_PUBLIC_KEY','AUTH_ISSUER','AUTH_AUDIENCE'];
for (const name of required) if (!process.env[name]) throw new Error('Missing configuration: ' + name);
const webhookUrl = new URL(process.env.RELWORX_WEBHOOK_URL);
if (webhookUrl.protocol !== 'https:' || webhookUrl.pathname !== '/webhooks/relworx' || webhookUrl.search || webhookUrl.hash) throw new Error('Use the public HTTPS /webhooks/relworx URL without a query or fragment.');
const origins = (process.env.FRONTEND_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
for (const origin of origins) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Use exact HTTPS frontend origins; no wildcard.');
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
const service = createService(pool, relworxProvider({ apiKey: process.env.RELWORX_API_KEY, account: process.env.RELWORX_ACCOUNT_NO }), { enablePayouts: process.env.ENABLE_PAYOUTS === 'true' });
const authenticate = await createAuthenticator({ publicKey: process.env.AUTH_PUBLIC_KEY, issuer: process.env.AUTH_ISSUER, audience: process.env.AUTH_AUDIENCE });
const app = createApp(service,authenticate,{ origins, webhookKey: process.env.RELWORX_WEBHOOK_KEY, webhookUrl: process.env.RELWORX_WEBHOOK_URL, health: () => pool.query('SELECT 1 FROM wallets LIMIT 1') });
await pool.query('SELECT 1 FROM wallets LIMIT 1'); // fail startup if schema is missing
const server = app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log('Payment service ready.'));
let sweeping = false;
const sweep = async () => {
  if (sweeping) return;
  sweeping = true;
  try { await service.sweep(); } catch { console.error('Payment reconciliation temporarily unavailable.'); }
  finally { sweeping = false; }
};
const timer = setInterval(sweep,30000);
timer.unref();
void sweep();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1),10000);
  deadline.unref();
  server.close(async () => { await pool.end(); process.exit(0); });
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
