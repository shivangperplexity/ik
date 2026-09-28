'use strict';

// Netlify Scheduled Function: refreshes the product/barcode cache from
// Shopify every 15 minutes (schedule set in netlify.toml).

const { load } = require('../../src/config');
const { createRuntime } = require('../../src/runtime');

let rtPromise = null;

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const config = load();
  if (!config.databaseUrl) {
    console.error('[sync] DATABASE_URL is not set');
    return { statusCode: 500, body: 'no database' };
  }
  try {
    if (!rtPromise) rtPromise = createRuntime(config);
    const rt = await rtPromise;
    const r = await rt.syncProducts();
    console.log(`[sync] ${r.variants} variants synced from Shopify`);
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    rtPromise = null;
    console.error('[sync] failed:', e.message);
    return { statusCode: 500, body: e.message };
  }
};
