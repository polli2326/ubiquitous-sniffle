export function relworxProvider(config, fetcher = fetch) {
  async function call(path, body) {
    const response = await fetcher('https://payments.relworx.com/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + config.apiKey, Accept: 'application/vnd.relworx.v2', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Provider unavailable');
    return response.json();
  }
  return {
    initiate: row => call('/mobile-money/' + (row.kind === 'deposit' ? 'request-payment' : 'send-payment'), {
      account_no: config.account, reference: row.reference, msisdn: row.phone,
      currency: 'UGX', amount: Number(row.amount), description: row.kind === 'deposit' ? 'Wallet deposit' : 'Wallet withdrawal',
    }),
    status: ref => call('/mobile-money/check-request-status?internal_reference=' + encodeURIComponent(ref) + '&account_no=' + encodeURIComponent(config.account)),
  };
}
