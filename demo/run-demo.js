'use strict';

// Local demo / UI testing WITHOUT Shopify credentials.
// Uses a snapshot of the real Ink Kulture catalogue + open orders
// (demo/variants.json, demo/orders.json) and an in-memory "Shopify".
// Never used in production: `npm start` always talks to the real store.

const path = require('path');
const fs = require('fs');
const { load } = require('../src/config');
const { createDb, migrate } = require('../src/db');
const { createApp } = require('../src/server');
const { createAuth } = require('../src/services/auth');
const { normalizeOrder, orderNumberFromName } = require('../src/shopify/orders');

async function main() {
  const file = path.join(__dirname, '..', 'data', 'demo.sqlite');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const config = load({ ...process.env, SQLITE_FILE: file, SHOPIFY_STORE_DOMAIN: 'demo.myshopify.com', PORT: process.env.PORT || '3100' });
  const db = createDb(config);
  await migrate(db);
  const [shop] = await db('shops').insert({ domain: 'demo.myshopify.com', name: 'Ink Kulture (demo)', created_at: new Date().toISOString() }).returning('id');
  const shopId = typeof shop === 'object' ? shop.id : shop;

  const variants = JSON.parse(fs.readFileSync(path.join(__dirname, 'variants.json'), 'utf8'));
  const orderNodes = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, 'orders.json'), 'utf8')).map((o) => [o.id, o]));

  const syncProducts = async () => {
    const rows = variants.map((v) => ({
      shop_id: shopId,
      shopify_product_id: v.product.id,
      shopify_variant_id: v.id,
      product_title: v.product.title,
      variant_title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      image_url: v.product.featuredMedia && v.product.featuredMedia.preview && v.product.featuredMedia.preview.image ? v.product.featuredMedia.preview.image.url : null,
      product_status: v.product.status,
      synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      await db('variants').insert(rows.slice(i, i + 100)).onConflict(['shop_id', 'shopify_variant_id']).merge();
    }
    return { variants: rows.length, syncedAt: new Date().toISOString() };
  };

  const orders = {
    async listQueue() { return Array.from(orderNodes.values()).map(normalizeOrder).filter((o) => !o.cancelled); },
    async findByNumber(n) {
      const node = Array.from(orderNodes.values()).find((o) => orderNumberFromName(o.name) === Number(n));
      return node ? normalizeOrder(node) : null;
    },
    async getById(id) { return normalizeOrder(orderNodes.get(id) || null); },
    async addTag() {},
  };

  const app = createApp({ config, db, shopId, orders, syncProducts });
  const r = await syncProducts();
  app.locals.markProductSync(r.syncedAt);
  const auth = createAuth(db, config);
  await auth.createUser(shopId, { username: 'admin', displayName: 'Owner', password: 'admin123', role: 'admin' });
  await auth.ensureSeedPickers(shopId, { info() {} }); // shivam/123, priti/321
  app.listen(config.port, () => console.log(`[demo] http://localhost:${config.port}  (admin/admin123, shivam/123, priti/321)`));
}

main().catch((e) => { console.error(e); process.exit(1); });
