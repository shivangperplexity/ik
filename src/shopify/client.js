'use strict';

// Minimal GraphQL Admin API client.
// - Supports the client credentials grant (Dev Dashboard apps, token refreshed
//   every ~24h) and a static Admin API token (older admin-created custom apps).
// - Retries on throttling / transient network errors.
// - Throws ShopifyUnavailableError so callers can show a clear message.

class ShopifyUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ShopifyUnavailableError';
    this.cause = cause;
  }
}

class ShopifyApiError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'ShopifyApiError';
    this.errors = errors;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createShopifyClient(cfg, { fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!cfg.storeDomain) throw new Error('SHOPIFY_STORE_DOMAIN is not set');
  const base = (cfg.apiBaseUrl || `https://${cfg.storeDomain}`).replace(/\/$/, '');
  let cachedToken = cfg.adminToken || null;
  let tokenExpiresAt = cfg.adminToken ? Infinity : 0;
  let tokenPromise = null;

  async function fetchWithTimeout(url, opts, ms = 20000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetchImpl(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken(force = false) {
    if (cfg.adminToken) return cfg.adminToken;
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new ShopifyApiError('App is not connected to Shopify yet: set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN)');
    }
    if (!force && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      let res;
      try {
        res = await fetchWithTimeout(`${base}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
          }).toString(),
        });
      } catch (e) {
        throw new ShopifyUnavailableError('Could not reach Shopify to get an access token', e);
      }
      const text = await res.text();
      if (!res.ok) {
        throw new ShopifyApiError(`Shopify token request failed (${res.status}): ${text.slice(0, 300)}`);
      }
      const json = JSON.parse(text);
      cachedToken = json.access_token;
      // Refresh 10 minutes before the 24h expiry.
      tokenExpiresAt = Date.now() + Math.max(60, (json.expires_in || 86399) - 600) * 1000;
      return cachedToken;
    })();
    try {
      return await tokenPromise;
    } finally {
      tokenPromise = null;
    }
  }

  async function graphql(query, variables = {}, { retries = 4 } = {}) {
    const url = `${base}/admin/api/${cfg.apiVersion}/graphql.json`;
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      attempt += 1;
      let res;
      try {
        const token = await getToken();
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        if (e instanceof ShopifyApiError) throw e;
        lastErr = e instanceof ShopifyUnavailableError ? e : new ShopifyUnavailableError('Shopify is unreachable', e);
        await sleep(300 * attempt);
        continue;
      }

      if (res.status === 401 && !cfg.adminToken && attempt <= retries) {
        await getToken(true); // token expired or rotated
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ShopifyUnavailableError(`Shopify returned HTTP ${res.status}`);
        const retryAfter = parseFloat(res.headers.get('retry-after') || '0');
        await sleep(Math.max(retryAfter * 1000, 500 * attempt));
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new ShopifyApiError(`Shopify HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = JSON.parse(text);
      if (json.errors && json.errors.length) {
        const throttled = json.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
        if (throttled) {
          lastErr = new ShopifyUnavailableError('Shopify API rate limit reached');
          await sleep(1000 * attempt);
          continue;
        }
        throw new ShopifyApiError(json.errors.map((e) => e.message).join('; '), json.errors);
      }
      return json.data;
    }
    log.warn && log.warn('[shopify] giving up after retries:', lastErr && lastErr.message);
    throw lastErr || new ShopifyUnavailableError('Shopify is unavailable');
  }

  return { graphql, getToken, storeDomain: cfg.storeDomain };
}

module.exports = { createShopifyClient, ShopifyUnavailableError, ShopifyApiError };
