'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createShopifyClient, ShopifyUnavailableError } = require('../src/shopify/client');
const { createOrderService } = require('../src/shopify/orders');
const { syncVariants } = require('../src/shopify/products');
const { load } = require('../src/config');
const { createDb, migrate } = require('../src/db');

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const cfg = { storeDomain: 'ink.myshopify.com', apiVersion: '2026-04', clientId: 'cid', clientSecret: 'secret', adminToken: '' };

test('client credentials grant: token fetched once, sent on requests, refreshed on 401', async () => {
  const calls = [];
  let tokenN = 0;
  let first = true;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/admin/oauth/access_token')) {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get('grant_type'), 'client_credentials');
      assert.equal(body.get('client_id'), 'cid');
      assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
      tokenN += 1;
      return res(200, { access_token: `tok${tokenN}`, scope: 'read_orders', expires_in: 86399 });
    }
    assert.match(url, /\/admin\/api\/2026-04\/graphql\.json$/);
    if (first) { first = false; return res(401, { errors: 'expired' }); }
    return res(200, { data: { shop: { name: 'Ink', token: opts.headers['X-Shopify-Access-Token'] } } });
  };
  const c = createShopifyClient(cfg, { fetchImpl, log: {} });
  const d = await c.graphql('{ shop { name } }');
  assert.equal(d.shop.token, 'tok2'); // re-fetched after the 401
  await c.graphql('{ shop { name } }');
  assert.equal(calls.filter((x) => x.url.endsWith('access_token')).length, 2, 'token cached between calls');
});

test('static admin token (older custom apps) skips the token exchange', async () => {
  const fetchImpl = async (url, opts) => {
    assert.ok(!url.includes('oauth'));
    return res(200, { data: { ok: opts.headers['X-Shopify-Access-Token'] } });
  };
  const c = createShopifyClient({ ...cfg, adminToken: 'shpat_x' }, { fetchImpl, log: {} });
  assert.equal((await c.graphql('{x}')).ok, 'shpat_x');
});

test('throttled / 5xx responses are retried; network failure becomes ShopifyUnavailableError', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (url.includes('oauth')) return res(200, { access_token: 't', expires_in: 86399 });
    n += 1;
    if (n === 1) return res(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
    if (n === 2) return res(503, 'busy');
    return res(200, { data: { ok: true } });
  };
  const c = createShopifyClient(cfg, { fetchImpl, log: {} });
  assert.deepEqual(await c.graphql('{x}'), { ok: true });

  const down = createShopifyClient(cfg, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, log: { warn() {} } });
  await assert.rejects(() => down.graphql('{x}', {}, { retries: 1 }), ShopifyUnavailableError);
});

test('order service pages through the queue and resolves order numbers exactly', async () => {
  const pages = [
    { hasNextPage: true, endCursor: 'c1', nodes: [{ id: 'o1', name: '#1001', cancelledAt: null, fulfillmentOrders: { nodes: [] } }] },
    { hasNextPage: false, endCursor: 'c2', nodes: [{ id: 'o2', name: '#1002', cancelledAt: '2026-01-01', fulfillmentOrders: { nodes: [] } }] },
  ];
  const seen = [];
  const client = {
    async graphql(q, vars) {
      seen.push(vars);
      if (q.includes('PickQueue')) {
        const p = vars.after ? pages[1] : pages[0];
        return { orders: { pageInfo: { hasNextPage: p.hasNextPage, endCursor: p.endCursor }, nodes: p.nodes } };
      }
      if (q.includes('OrderByName')) return { orders: { nodes: [{ id: 'x', name: '#10500' }, { id: 'y', name: '#1050' }] } };
      if (q.includes('OrderById')) return { order: { id: vars.id, name: '#1050', fulfillmentOrders: { nodes: [] } } };
      throw new Error('unexpected');
    },
  };
  const svc = createOrderService(client);
  const q = await svc.listQueue(100);
  assert.deepEqual(q.map((o) => o.name), ['#1001'], 'cancelled order filtered, second page fetched');
  assert.equal(seen[1].after, 'c1');
  const o = await svc.findByNumber(1050);
  assert.equal(o.id, 'y', 'exact match, not #10500');
});

test('syncVariants mirrors Shopify variants and removes deleted ones', async () => {
  const config = load({ SQLITE_FILE: ':memory:', SHOPIFY_STORE_DOMAIN: 'x.myshopify.com' });
  const db = createDb(config);
  await migrate(db);
  const [s] = await db('shops').insert({ domain: 'x', created_at: new Date().toISOString() }).returning('id');
  const shopId = typeof s === 'object' ? s.id : s;
  const variant = (id, sku, barcode) => ({
    id: `gid://shopify/ProductVariant/${id}`, title: 'Default Title', sku, barcode,
    media: { nodes: [] }, product: { id: `gid://shopify/Product/${id}`, title: `P${id}`, status: 'ACTIVE', featuredMedia: { preview: { image: { url: `https://cdn/${id}.png` } } } },
  });
  let nodes = [variant(1, 'IKA1', 'IKA1'), variant(2, 'IKA2', null)];
  const client = { async graphql() { return { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }; } };
  let r = await syncVariants(db, client, shopId);
  assert.equal(r.variants, 2);
  let rows = await db('variants').orderBy('sku');
  assert.equal(rows[0].barcode, 'IKA1');
  assert.equal(rows[0].variant_title, null, '"Default Title" is hidden');
  assert.equal(rows[0].image_url, 'https://cdn/1.png');
  assert.equal(rows[1].barcode, null);

  nodes = [variant(1, 'IKA1', 'IKA1-NEW')];
  r = await syncVariants(db, client, shopId);
  rows = await db('variants');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].barcode, 'IKA1-NEW');
  await db.destroy();
});
