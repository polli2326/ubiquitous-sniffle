import crypto from 'node:crypto';
import { ApiError, paymentInput, recipient, reference, settlement, walletEffect } from './rules.js';

export async function transaction(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export function publicPayment(p) {
  return { id: p.id, kind: p.kind, amount: Number(p.amount), currency: 'UGX', state: p.state,
    reference: p.reference, createdAt: p.created_at, updatedAt: p.updated_at };
}
export function createService(pool, provider, { enablePayouts = false } = {}) {
  async function limit(key, max, seconds) {
    const bucket = Math.floor(Date.now() / (seconds * 1000));
    const { rows } = await pool.query(`INSERT INTO rate_limits(key,bucket,count) VALUES($1,$2,1)
      ON CONFLICT(key,bucket) DO UPDATE SET count=rate_limits.count+1 RETURNING count`, [key,bucket]);
    if (rows[0].count > max) throw new ApiError(429, 'Too many requests. Try again later.');
  }
  async function balance(user) {
    const { rows } = await pool.query('SELECT available,reserved FROM wallets WHERE user_id=$1', [user]);
    return { currency: 'UGX', available: Number(rows[0]?.available ?? 0), reserved: Number(rows[0]?.reserved ?? 0),
      scope: 'relworx_wallet_only', gameFundingEnabled: false };
  }
  async function prepare(kind, identity, body, key) {
    const input = paymentInput.parse(body);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key ?? '')) throw new ApiError(400, 'Use a stable Idempotency-Key (16–100 letters, digits, underscores or hyphens).');
    const msisdn = recipient(kind, input, identity);
    if (kind === 'withdrawal' && !enablePayouts) throw new ApiError(403, 'Withdrawals are not enabled by the operator.');
    return transaction(pool, async c => {
      await c.query('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING', [identity.sub]);
      const wallet = (await c.query('SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE', [identity.sub])).rows[0];
      const existing = (await c.query('SELECT * FROM payments WHERE user_id=$1 AND idempotency_key=$2', [identity.sub,key])).rows[0];
      if (existing) {
        if (existing.kind !== kind || Number(existing.amount) !== input.amount || existing.phone !== msisdn) throw new ApiError(409, 'This payment key was already used with different details.');
        return { row: existing, isNew: false };
      }
      if (kind === 'withdrawal' && Number(wallet.available) < input.amount) throw new ApiError(422, 'Insufficient available wallet balance.');
      const id = crypto.randomUUID();
      const row = (await c.query(`INSERT INTO payments(id,user_id,kind,amount,phone,reference,idempotency_key,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'created') RETURNING *`, [id,identity.sub,kind,input.amount,msisdn,reference(),key])).rows[0];
      if (kind === 'withdrawal') {
        await c.query('UPDATE wallets SET available=available-$2,reserved=reserved+$2 WHERE user_id=$1', [identity.sub,input.amount]);
        await c.query(`INSERT INTO ledger(user_id,payment_id,event,available_delta,reserved_delta) VALUES($1,$2,'reserve',$3,$4)`, [identity.sub,id,-input.amount,input.amount]);
      }
      return { row, isNew: true };
    });
  }
  async function dispatch(row) {
    // Persist the attempt before sending. Crashes and timeouts NEVER trigger a repeat payout.
    const claimed = await pool.query(`UPDATE payments SET state='dispatching',updated_at=now() WHERE id=$1 AND state='created' RETURNING *`, [row.id]);
    if (!claimed.rowCount) return;
    try {
      const result = await provider.initiate(row);
      if (result.success !== true || typeof result.internal_reference !== 'string' ||
        result.internal_reference.length > 100 || !result.internal_reference ||
        (result.customer_reference && result.customer_reference !== row.reference)) throw new Error('Unconfirmed initiation');
      await pool.query(`UPDATE payments SET internal_reference=COALESCE(internal_reference,$2),state='pending',updated_at=now()
        WHERE id=$1 AND state IN ('dispatching','unknown') AND (internal_reference IS NULL OR internal_reference=$2)`, [row.id,result.internal_reference]);
    } catch {
      // Even a refusal/HTTP error is reconciled manually when no authoritative reference is returned.
      await pool.query(`UPDATE payments SET state='unknown',updated_at=now() WHERE id=$1 AND state='dispatching'`, [row.id]);
    }
  }
  async function apply(id, result) {
    return transaction(pool, async c => {
      // All wallet-changing paths take the wallet lock before the payment lock.
      const owner = (await c.query('SELECT user_id FROM payments WHERE id=$1', [id])).rows[0];
      if (!owner) throw new ApiError(404, 'Payment not found.');
      await c.query('SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE', [owner.user_id]);
      const row = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id])).rows[0];
      let status;
      try { status = settlement(row, result); }
      catch (e) {
        if (!['success','failed'].includes(row.state)) await c.query("UPDATE payments SET state='review',updated_at=now() WHERE id=$1", [id]);
        return { review: true }; // commit the review flag, do not credit/refund
      }
      if (['success','failed'].includes(row.state)) {
        if (row.state !== status) return { review: true }; // never reverse a settled ledger automatically
        return { duplicate: true };
      }
      if (row.state === 'review') return { review: true }; // explicit operator investigation needed
      if (status === 'pending') return { pending: true };
      const amount = Number(row.amount);
      const delta = walletEffect(row.kind,status,amount);
      await c.query('UPDATE wallets SET available=available+$2,reserved=reserved+$3 WHERE user_id=$1', [row.user_id,delta.available,delta.reserved]);
      await c.query('INSERT INTO ledger(user_id,payment_id,event,available_delta,reserved_delta) VALUES($1,$2,$3,$4,$5)', [row.user_id,id,status,delta.available,delta.reserved]);
      await c.query('UPDATE payments SET state=$2,updated_at=now() WHERE id=$1', [id,status]);
      return { settled: true };
    });
  }
  async function reconcile(row) {
    if (!row.internal_reference || ['success','failed','review'].includes(row.state)) return;
    const result = await provider.status(row.internal_reference);
    return apply(row.id,result);
  }
  async function initiate(kind, identity, body, key) {
    await limit('user-payments:' + identity.sub,20,600);
    const prepared = await prepare(kind,identity,body,key);
    if (prepared.isNew) {
      if (kind === 'deposit') {
        try { await limit('phone-collections:' + prepared.row.phone,5,600); }
        catch (e) {
          await pool.query("UPDATE payments SET state='failed',updated_at=now() WHERE id=$1 AND state='created'", [prepared.row.id]);
          throw e;
        }
      }
      await dispatch(prepared.row);
    }
    return payment(identity.sub,prepared.row.id,false);
  }
  async function payment(user,id,refresh=true) {
    let row = (await pool.query('SELECT * FROM payments WHERE id=$1 AND user_id=$2', [id,user])).rows[0];
    if (!row) throw new ApiError(404, 'Payment not found.');
    if (refresh) {
      try { await reconcile(row); } catch { /* retained as pending/unknown, never fabricated failure */ }
      row = (await pool.query('SELECT * FROM payments WHERE id=$1 AND user_id=$2', [id,user])).rows[0];
    }
    return publicPayment(row);
  }
  async function history(user, cursor) {
    const { rows } = await pool.query(`SELECT * FROM payments WHERE user_id=$1 AND ($2::timestamptz IS NULL OR created_at<$2)
      ORDER BY created_at DESC LIMIT 50`, [user,cursor ?? null]);
    return { payments: rows.map(publicPayment), nextCursor: rows.length === 50 ? rows.at(-1).created_at : null };
  }
  async function webhook(body) {
    const row = (await pool.query('SELECT * FROM payments WHERE reference=$1', [body.customer_reference])).rows[0];
    if (!row) throw new ApiError(503, 'Payment not yet available; retry callback.');
    if (row.state === 'created') throw new ApiError(409, 'Payment was not dispatched.');
    if (row.internal_reference && row.internal_reference !== body.internal_reference) throw new ApiError(409, 'Reference mismatch.');
    // The signed callback is only a wake-up signal. Fetch monetary fields directly from Relworx.
    const result = await provider.status(body.internal_reference);
    settlement({ ...row, internal_reference: body.internal_reference },result);
    await pool.query(`UPDATE payments SET internal_reference=$2,state=CASE WHEN state IN ('dispatching','unknown') THEN 'pending' ELSE state END,updated_at=now()
      WHERE id=$1 AND (internal_reference IS NULL OR internal_reference=$2)`, [row.id,body.internal_reference]);
    const applied = await apply(row.id,result);
    if (applied.review) throw new ApiError(409, 'Payment requires operator review.');
    await pool.query(`INSERT INTO webhook_receipts(reference,internal_reference,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [row.reference,body.internal_reference,result.status]);
  }
  async function sweep() {
    const rows = (await pool.query(`SELECT * FROM payments WHERE internal_reference IS NOT NULL AND state IN ('pending','unknown','dispatching') ORDER BY updated_at LIMIT 50`)).rows;
    for (const row of rows) { try { await reconcile(row); } catch { /* provider unavailable: next cycle */ } }
    await pool.query('DELETE FROM rate_limits WHERE bucket < $1', [Math.floor(Date.now()/600000)-144]);
  }
  return { balance, initiate, payment, history, webhook, sweep, apply, prepare, dispatch, limit };
}
