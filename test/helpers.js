'use strict';

const request = require('supertest');
const { load } = require('../src/config');
const { createDb, migrate } = require('../src/db');
const { createApp } = require('../src/server');
const { createAuth } = require('../src/services/auth');
const { normalizeOrder, orderNumberFromName } = require('../src/shopify/orders');
const { ShopifyUnavailableError } = require('../src/shopify/client');

// Build a Shopify-shaped order node so normalizeOrder() is exercised exactly
// as it is with live data.
function shopifyOrderNode({ number, lines, cancelled = false, foStatus = 'OPEN', extraFulfillmentOrders = [] }) {
  return {
    id: `gid://shopify/Order/${number}`,
    name: `#${number}`,
    createdAt: '2026-09-28T10:00:00Z',
    cancelledAt: cancelled ? '2026-09-28T11:00:00Z' : null,
    closed: false,
    displayFulfillmentStatus: 'UNFULFILLED',
    fulfillmentOrders: {
      nodes: [
        {
          id: `gid://shopify/FulfillmentOrder/${number}`,
          status: foStatus,
          lineItems: {
            nodes: lines.map((l, i) => ({
              id: `gid://shopify/FulfillmentOrderLineItem/${number}${i}`,
              remainingQuantity: l.remaining != null ? l.remaining : l.qty,
              sku: l.sku,
              variant: l.noVariant ? null : {
                id: `gid://shopify/ProductVariant/${l.variant}`,
                title: 'Default Title',
                barcode: l.barcode,
                media: { nodes: [] },
                product: { id: `gid://shopify/Product/${l.variant}`, title: l.title, featuredMedia: null },
              },
              lineItem: { id: `gid://shopify/LineItem/${number}${i}`, title: l.title, variantTitle: null, image: { url: `https://cdn.example/${l.sku}.png` } },
            })),
          },
        },
        ...extraFulfillmentOrders,
      ],
    },
  };
}

function createFakeOrders() {
  const nodes = new Map();
  let down = false;
  const tags = [];
  return {
    tags,
    setOrder(node) { nodes.set(node.id, node); },
    setDown(v) { down = v; },
    async listQueue() {
      if (down) throw new ShopifyUnavailableError('down');
      return Array.from(nodes.values()).map(normalizeOrder).filter((o) => !o.cancelled);
    },
    async findByNumber(number) {
      if (down) throw new ShopifyUnavailableError('down');
      const n = Array.from(nodes.values()).find((x) => orderNumberFromName(x.name) === Number(number));
      return n ? normalizeOrder(n) : null;
    },
    async getById(id) {
      if (down) throw new ShopifyUnavailableError('down');
      return normalizeOrder(nodes.get(id) || null);
    },
    async addTag(id, tag) { tags.push({ id, tag }); },
  };
}

const PRODUCTS = [
  { variant: 1, title: 'Dragon Tattoo', sku: 'IK-0042', barcode: '100001' },
  { variant: 2, title: 'Snake Tattoo', sku: 'IK-0117', barcode: '100002' },
  { variant: 3, title: 'Moon Tattoo', sku: 'IK-0200', barcode: '100003' },
  { variant: 4, title: 'Skull Tattoo', sku: 'IK-0088', barcode: '100088' },
  { variant: 5, title: 'Lion Face Tattoo', sku: 'IKA35', barcode: 'IKA35' },
];

async function createTestApp(overrides = {}) {
  // Set TEST_DATABASE_URL=postgres://... to run the same suite on Postgres.
  const config = load({
    SQLITE_FILE: ':memory:',
    DATABASE_URL: process.env.TEST_DATABASE_URL || '',
    SHOPIFY_STORE_DOMAIN: 'test-shop.myshopify.com',
    DOUBLE_SCAN_MS: '0',
    ...overrides,
  });
  const db = createDb(config);
  if (config.databaseUrl) await require('../src/db').rollbackAll(db);
  await migrate(db);
  const [shop] = await db('shops').insert({ domain: 'test-shop.myshopify.com', name: 'Test', created_at: new Date().toISOString() }).returning('id');
  const shopId = typeof shop === 'object' ? shop.id : shop;

  const syncProducts = async () => {
    const rows = PRODUCTS.map((p) => ({
      shop_id: shopId,
      shopify_product_id: `gid://shopify/Product/${p.variant}`,
      shopify_variant_id: `gid://shopify/ProductVariant/${p.variant}`,
      product_title: p.title,
      variant_title: null,
      sku: p.sku,
      barcode: p.barcode,
      image_url: `https://cdn.example/${p.sku}.png`,
      product_status: 'ACTIVE',
      synced_at: new Date().toISOString(),
    }));
    await db('variants').insert(rows).onConflict(['shop_id', 'shopify_variant_id']).merge();
    return { variants: rows.length, syncedAt: new Date().toISOString() };
  };
  await syncProducts();

  const orders = createFakeOrders();
  const quietLog = { info() {}, warn() {}, error() {} };
  const app = createApp({ config, db, shopId, orders, syncProducts, log: quietLog });
  const auth = createAuth(db, config);
  await auth.createUser(shopId, { username: 'admin', displayName: 'Admin', password: 'secret123', role: 'admin' });
  await auth.createUser(shopId, { username: 'ravi', displayName: 'Ravi', password: 'secret123', role: 'picker' });
  await auth.createUser(shopId, { username: 'priya', displayName: 'Priya', password: 'secret123', role: 'picker' });

  async function login(username) {
    const agent = request.agent(app);
    const r = await agent.post('/api/login').send({ username, password: 'secret123' });
    if (r.status !== 200) throw new Error(`login failed ${r.status}`);
    return agent;
  }

  return { app, db, orders, shopId, login, config };
}

function order1050(extra = {}) {
  return shopifyOrderNode({
    number: 1050,
    lines: [
      { variant: 1, title: 'Dragon Tattoo', sku: 'IK-0042', barcode: '100001', qty: 1 },
      { variant: 2, title: 'Snake Tattoo', sku: 'IK-0117', barcode: '100002', qty: 2 },
      { variant: 3, title: 'Moon Tattoo', sku: 'IK-0200', barcode: '100003', qty: 1 },
    ],
    ...extra,
  });
}

module.exports = { createTestApp, shopifyOrderNode, order1050, PRODUCTS };
