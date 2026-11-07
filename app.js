import express from 'express';
import { z } from 'zod';
import { ApiError, verifyWebhook } from './rules.js';
export function createApp(service, authenticate, config) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    const origin = req.headers.origin;
    if (origin) {
      if (!config.origins.includes(origin)) return res.status(403).json({ error: 'Origin not allowed.' });
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.get('/health', async (req,res) => {
    try { await config.health(); res.json({ ok: true, gameFundingEnabled: false }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.post('/webhooks/relworx', async (req,res) => {
    verifyWebhook(req.headers['relworx-signature'],req.body,config.webhookKey,config.webhookUrl);
    await service.webhook(req.body);
    res.json({ received: true });
  });
  app.use('/v1', async (req,res,next) => {
    req.identity = await authenticate(req);
    await service.limit('authenticated-api:' + req.identity.sub,120,60);
    next();
  });
  app.get('/v1/wallet', async (req,res) => res.json(await service.balance(req.identity.sub)));
  app.post('/v1/deposits', async (req,res) => res.status(202).json(await service.initiate('deposit',req.identity,req.body,req.headers['idempotency-key'])));
  app.post('/v1/withdrawals', async (req,res) => res.status(202).json(await service.initiate('withdrawal',req.identity,req.body,req.headers['idempotency-key'])));
  app.get('/v1/payments/:id', async (req,res) => {
    const id = z.uuid().parse(req.params.id);
    res.json(await service.payment(req.identity.sub,id));
  });
  app.get('/v1/payments', async (req,res) => {
    const cursor = z.iso.datetime({ offset: true }).optional().parse(req.query.cursor);
    res.json(await service.history(req.identity.sub,cursor));
  });
  app.use((req,res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error,req,res,next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof ApiError ? error.status : error instanceof z.ZodError ? 422 : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    // Never log tokens, keys, phone numbers or provider responses.
    if (status === 500) console.error('Payment service internal error.');
    res.status(status).json({ error: error instanceof ApiError ? error.message : status === 422 ? 'Check the payment details: amount 1,000–5,000,000 UGX and confirmation required.' : 'Request could not be completed.' });
  });
  return app;
}
