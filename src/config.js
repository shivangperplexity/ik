'use strict';

// Central configuration. Everything comes from environment variables so the
// same build runs locally (SQLite) and in the cloud (Postgres).

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function parseSeed(v) {
  return String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [username, password, displayName] = x.split(':');
    return { username: (username || '').toLowerCase(), password: password || '', displayName: displayName || username };
  }).filter((p) => p.username && p.password);
}

function load(env = process.env) {
  const shopDomain = (env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return {
    port: int(env.PORT, 3000),
    nodeEnv: env.NODE_ENV || 'development',
    // DATABASE_URL (postgres://...) in production; SQLite file otherwise.
    // Netlify Database exposes NETLIFY_DB_URL; older Netlify DB (Neon) used NETLIFY_DATABASE_URL.
    databaseUrl: env.DATABASE_URL || env.NETLIFY_DB_URL || env.NETLIFY_DATABASE_URL || '',
    // Keep the pool small on serverless hosts: each function instance has its own pool.
    pgPoolMax: int(env.PG_POOL_MAX, env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME ? 3 : 10),
    sqliteFile: env.SQLITE_FILE || './data/pickpack.sqlite',
    // Cookies are marked Secure when served over HTTPS in production.
    secureCookies: bool(env.SECURE_COOKIES, (env.NODE_ENV || '') === 'production' || (Boolean(env.AWS_LAMBDA_FUNCTION_NAME) && !env.NETLIFY_DEV)),
    sessionDays: int(env.SESSION_DAYS, 14),
    timezone: env.APP_TIMEZONE || 'Asia/Kolkata',

    shopify: {
      storeDomain: shopDomain, // e.g. ink-kulture.myshopify.com
      apiVersion: env.SHOPIFY_API_VERSION || '2026-04',
      // Testing only: send Shopify calls to a stand-in server instead of the store.
      apiBaseUrl: env.SHOPIFY_API_BASE_URL || '',
      // Option A (recommended, Dev Dashboard app): client credentials grant.
      clientId: env.SHOPIFY_CLIENT_ID || '',
      clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
      // Option B (older admin-created custom app): static Admin API token.
      adminToken: env.SHOPIFY_ADMIN_TOKEN || '',
      // Tag added to an order in Shopify once packing is complete (needs write_orders).
      packedTag: env.PACKED_TAG || 'ik-packed',
    },

    picking: {
      // Identical barcode arriving faster than this is treated as a scanner double-send.
      doubleScanMs: int(env.DOUBLE_SCAN_MS, 300),
      queueCacheSeconds: int(env.QUEUE_CACHE_SECONDS, 20),
      queueMaxOrders: int(env.QUEUE_MAX_ORDERS, 150),
      productSyncMinutes: int(env.PRODUCT_SYNC_MINUTES, 15),
      staleLockMinutes: int(env.STALE_LOCK_MINUTES, 30),
    },

    // Default packers, format "username:password:Display Name,..." (created on
    // first start only; change passwords later in Admin → Staff).
    seedPickers: parseSeed(env.SEED_PICKERS === undefined ? 'shivam:123:Shivam,priti:321:Priti' : env.SEED_PICKERS),

    bootstrapAdmin: {
      username: env.ADMIN_USERNAME || 'admin',
      password: env.ADMIN_PASSWORD || '',
      displayName: env.ADMIN_DISPLAY_NAME || 'Admin',
    },
  };
}

module.exports = { load };
