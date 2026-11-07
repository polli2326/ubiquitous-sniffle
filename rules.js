import crypto from 'node:crypto';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const paymentInput = z.object({
  amount: z.number().int().min(1000).max(5000000),
  phone: z.string().max(30).optional(),
  confirmed: z.literal(true),
}).strict();
export function phone(value) {
  let p = String(value ?? '').replace(/[\s()-]/g, '');
  if (/^0\d{9}$/.test(p)) p = '+256' + p.slice(1);
  if (/^256\d{9}$/.test(p)) p = '+' + p;
  if (!/^\+256(?:7[046789]|39|20)\d{7}$/.test(p)) throw new ApiError(422, 'Enter a supported Uganda mobile-money number.');
  return p;
}
export function recipient(kind, input, identity) {
  // Only an authenticated issuer may assert the verified payout number.
  if (kind === 'withdrawal') {
    if (identity.phone_verified !== true) throw new ApiError(403, 'Verify your registered phone before withdrawing.');
    const registered = phone(identity.phone_number);
    if (input.phone && phone(input.phone) !== registered) throw new ApiError(403, 'Withdrawals go only to your verified registered number.');
    return registered;
  }
  return phone(input.phone ?? identity.phone_number);
}
export function reference() { return 'RW-' + crypto.randomUUID().replaceAll('-', ''); }
export function verifyWebhook(header, body, key, url, now = Date.now()) {
  const fields = Object.fromEntries(String(header ?? '').split(',').map(s => s.trim().split('=')));
  if (!/^\d{10}$/.test(fields.t ?? '') || !/^[a-f0-9]{64}$/i.test(fields.v ?? '')) throw new ApiError(401, 'Invalid webhook signature.');
  if (Math.abs(Math.floor(now / 1000) - Number(fields.t)) > 600) throw new ApiError(401, 'Expired webhook signature.');
  for (const name of ['status','customer_reference','internal_reference']) {
    if (typeof body[name] !== 'string' || body[name].length > 100) throw new ApiError(400, 'Invalid webhook fields.');
  }
  const data = url + fields.t + ['customer_reference','internal_reference','status'].map(k => k + body[k]).join('');
  const digest = crypto.createHmac('sha256', key).update(data).digest();
  if (!crypto.timingSafeEqual(digest, Buffer.from(fields.v, 'hex'))) throw new ApiError(401, 'Invalid webhook signature.');
}
export function settlement(row, result) {
  // Provider API HTTP success is not payment success. Match every economic field.
  if (result.success !== true || result.customer_reference !== row.reference ||
      result.internal_reference !== row.internal_reference || result.currency !== 'UGX' ||
      Number(result.amount) !== Number(row.amount) || result.msisdn !== row.phone) {
    throw new ApiError(409, 'Settlement needs manual review.');
  }
  if (result.request_status && result.status !== result.request_status) throw new ApiError(409, 'Conflicting payment status.');
  if (!['pending','success','failed'].includes(result.status)) throw new ApiError(409, 'Unknown payment status.');
  return result.status;
}
export function walletEffect(kind, status, amount) {
  if (!['deposit','withdrawal'].includes(kind) || !['success','failed'].includes(status)) throw new Error('Invalid settlement effect.');
  if (kind === 'deposit') return { available: status === 'success' ? amount : 0, reserved: 0 };
  return { available: status === 'failed' ? amount : 0, reserved: -amount };
}
