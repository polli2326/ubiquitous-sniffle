import { importSPKI, jwtVerify } from 'jose';
import { ApiError } from './rules.js';
export async function createAuthenticator(config) {
  const key = await importSPKI(config.publicKey.replaceAll('\\n','\n'), 'RS256');
  return async req => {
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ') || header.length > 8192) throw new ApiError(401, 'Sign in to access payments.');
    try {
      const { payload } = await jwtVerify(header.slice(7),key, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['sub','iat','exp','jti'], maxTokenAge: '5m', clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 200 ||
          typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp-payload.iat > 300 ||
          typeof payload.jti !== 'string' || payload.jti.length > 100 || !payload.jti ||
          payload.scope !== 'wallet:read wallet:pay') throw new Error('Invalid identity');
      return payload;
    } catch { throw new ApiError(401, 'Sign in again to access payments.'); }
  };
}
