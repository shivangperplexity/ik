'use strict';

// Builds everything the app needs (database, Shopify client, Express app).
// Shared by the long-running server (src/index.js) and the Netlify Function
// (netlify/functions/api.js) so both behave identically.

const { createDb, migrate } = require('./db');
const { createShopifyClient } = require('./shopify/client');
const { createOrderService } = require('./shopify/orders');
const { syncVariants } = require('./shopify/products');
const { createApp } = require('./server');
const { createAuth } = require('./services/auth');

async function ensureShop(db, domain) {
  const existing = await db('shops').where({ domain }).first();
  if (existing) return existing.id;
  const [row] = await db('shops')
    .insert({ domain, name: domain, created_at: new Date().toISOString() })
    .onConflict('domain').ignore()
    .returning('id');
  if (row) return typeof row === 'object' ? row.id : row;
  return (await db('shops').where({ domain }).first()).id;
}

async function createRuntime(config, { log = console } = {}) {
  if (!config.shopify.storeDomain) {
    throw new Error('SHOPIFY_STORE_DOMAIN is required (e.g. your-store.myshopify.com)');
  }
  const db = createDb(config);
  await migrate(db);

  const client = createShopifyClient(config.shopify, { log });
  const orders = createOrderService(client);
  const shopId = await ensureShop(db, config.shopify.storeDomain);
  const syncProducts = () => syncVariants(db, client, shopId);

  const app = createApp({ config, db, shopId, orders, syncProducts, log });
  // Ignore stray spaces copied into the Netlify variable.
  const pw = String(config.bootstrapAdmin.password || '').trim();
  const cfg = { ...config, bootstrapAdmin: { ...config.bootstrapAdmin, password: pw } };
  const auth = createAuth(db, cfg);
  try {
    await auth.ensureBootstrapAdmin(shopId, log);
  } catch (e) {
    // Two cold starts racing to create the first admin: the loser can ignore it.
    if (!/already exists|unique/i.test(e.message)) {
      throw new Error(`Could not create the admin login: ${e.message}. The app received an ADMIN_PASSWORD that is ${pw.length} characters long. `
        + 'Set ADMIN_PASSWORD (6+ characters) in Netlify → Environment variables, then Deploys → Trigger deploy.');
    }
  }
  try {
    await auth.ensureSeedPickers(shopId, log);
  } catch (e) {
    // Never block the app because of a default packer account.
    log.warn(`[auth] could not create default packers: ${e.message}`);
  }
  return { config, db, app, client, orders, shopId, syncProducts };
}

module.exports = { createRuntime };
