'use strict';

// Long-running server (local, Render, Docker, VPS). On Netlify the app runs
// as a function instead — see netlify/functions/.

const { load } = require('./config');
const { createRuntime } = require('./runtime');

async function main() {
  const config = load();
  const log = console;
  const rt = await createRuntime(config, { log });

  const runSync = async () => {
    try {
      const r = await rt.syncProducts();
      rt.app.locals.markProductSync(r.syncedAt);
      log.info(`[sync] ${r.variants} variants synced from Shopify`);
    } catch (e) {
      log.warn(`[sync] product sync failed: ${e.message}`);
    }
  };
  runSync();
  setInterval(runSync, config.picking.productSyncMinutes * 60000).unref();

  const server = rt.app.listen(config.port, () => log.info(`[pickpack] listening on :${config.port}`));
  const shutdown = () => server.close(() => rt.db.destroy().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
