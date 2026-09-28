'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp, order1050, shopifyOrderNode } = require('./helpers');
const { normalizeOrder } = require('../src/shopify/orders');
const { parseOrderCode } = require('../src/services/picking');

let n = 0;
const sid = () => `s-${n++}`;

async function startPick(t, agent, code = 'ORD1050') {
  const r = await agent.post('/api/sessions').send({ code });
  return r;
}

test('two pickers cannot pick the same order; admin can release', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const priya = await t.login('priya');
  const admin = await t.login('admin');

  const a = await startPick(t, ravi);
  assert.equal(a.status, 200);
  const b = await startPick(t, priya);
  assert.equal(b.status, 423);
  assert.equal(b.body.error, 'LOCKED');
  assert.match(b.body.message, /Currently being picked by Ravi/);

  // Priya cannot scan into Ravi's session either.
  const sc = await priya.post(`/api/sessions/${a.body.session.id}/scan`).send({ barcode: '100001', clientScanId: sid() });
  assert.equal(sc.status, 403);

  // Ravi re-opening resumes the same session (page refresh / other tab).
  const again = await startPick(t, ravi);
  assert.equal(again.body.session.id, a.body.session.id);

  // Picker cannot release someone else's; admin can.
  assert.equal((await priya.post(`/api/sessions/${a.body.session.id}/release`).send({})).status, 403);
  assert.equal((await admin.post(`/api/sessions/${a.body.session.id}/release`).send({ reason: 'stuck' })).status, 200);
  const c = await startPick(t, priya);
  assert.equal(c.status, 200);
  assert.notEqual(c.body.session.id, a.body.session.id);
  await t.db.destroy();
});

test('packed orders cannot be picked again', async () => {
  const t = await createTestApp();
  t.orders.setOrder(shopifyOrderNode({ number: 2001, lines: [{ variant: 5, title: 'Lion Face Tattoo', sku: 'IKA35', barcode: 'IKA35', qty: 1 }] }));
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi, '#2001')).body.session;
  await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: 'ika35', clientScanId: sid() }); // case-insensitive
  const done = await ravi.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(done.body.session.status, 'packed');
  const again = await startPick(t, ravi, 'ORD2001');
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'ALREADY_PACKED');
  await t.db.destroy();
});

test('cancelled orders cannot be picked', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050({ cancelled: true }));
  const ravi = await t.login('ravi');
  const r = await startPick(t, ravi);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'ORDER_CANCELLED');
  await t.db.destroy();
});

test('order changed or cancelled while picking blocks completion', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi)).body.session;
  for (const b of ['100001', '100002', '100002', '100003']) {
    await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: b, clientScanId: sid() });
  }
  // Customer service removes one Snake in Shopify.
  t.orders.setOrder(order1050({
    lines: [
      { variant: 1, title: 'Dragon Tattoo', sku: 'IK-0042', barcode: '100001', qty: 1 },
      { variant: 2, title: 'Snake Tattoo', sku: 'IK-0117', barcode: '100002', qty: 1 },
      { variant: 3, title: 'Moon Tattoo', sku: 'IK-0200', barcode: '100003', qty: 1 },
    ],
  }));
  const chk = await ravi.post(`/api/sessions/${s.id}/check`).send({});
  assert.equal(chk.body.flag, 'ORDER_CHANGED');
  const c = await ravi.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(c.status, 409);
  assert.equal(c.body.error, 'ORDER_CHANGED');
  assert.match(c.body.message, /Snake Tattoo .* quantity 2 → 1/);

  t.orders.setOrder(order1050({ cancelled: true }));
  const c2 = await ravi.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(c2.body.error, 'ORDER_CANCELLED');
  await t.db.destroy();
});

test('Shopify down at completion: picker blocked, admin may override', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi)).body.session;
  for (const b of ['100001', '100002', '100002', '100003']) {
    await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: b, clientScanId: sid() });
  }
  t.orders.setDown(true);
  const c = await ravi.post(`/api/sessions/${s.id}/complete`).send({ skipShopifyCheck: true });
  assert.equal(c.status, 503, 'picker cannot skip the Shopify check');
  // Scanning still works while Shopify is down (session snapshot is local).
  const q = await ravi.get('/api/queue');
  assert.equal(q.status, 503);
  t.orders.setDown(false);
  const ok = await ravi.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(ok.body.session.status, 'packed');
  await t.db.destroy();
});

test('duplicate request and scanner double-send are not counted twice', async () => {
  const t = await createTestApp({ DOUBLE_SCAN_MS: '400' });
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi)).body.session;

  // Same request retried (network lag) -> idempotent.
  const id = sid();
  await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100002', clientScanId: id });
  const retry = await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100002', clientScanId: id });
  assert.equal(retry.body.duplicateRequest, true);
  assert.equal(retry.body.session.scannedQty, 1);

  // Scanner sends the same code twice within milliseconds.
  const dbl = await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100002', clientScanId: sid() });
  assert.equal(dbl.body.result, 'DOUBLE_SCAN_IGNORED');
  assert.equal(dbl.body.session.scannedQty, 1);

  // A genuine second scan a moment later is accepted.
  await new Promise((r) => setTimeout(r, 450));
  const second = await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100002', clientScanId: sid() });
  assert.equal(second.body.result, 'CORRECT');
  assert.equal(second.body.session.scannedQty, 2);
  await t.db.destroy();
});

test('parallel scans never exceed required quantity', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi)).body.session;
  const results = await Promise.all(Array.from({ length: 6 }, () => ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100002', clientScanId: sid() })));
  const correct = results.filter((r) => r.body.result === 'CORRECT').length;
  assert.equal(correct, 2);
  const final = await ravi.get(`/api/sessions/${s.id}`);
  assert.equal(final.body.session.items.find((i) => i.sku === 'IK-0117').scanned, 2);
  await t.db.destroy();
});

test('wrong product shows what was scanned; order slips during picking are caught', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi)).body.session;
  const w = await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100088', clientScanId: sid() });
  assert.equal(w.body.result, 'WRONG_PRODUCT');
  assert.equal(w.body.scannedProducts[0].title, 'Skull Tattoo');
  assert.equal(w.body.expected.length, 3);
  const o = await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: 'ORD1077', clientScanId: sid() });
  assert.equal(o.body.result, 'OTHER_ORDER_BARCODE');
  const e = await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: 'ORD1050', clientScanId: sid() });
  assert.equal(e.body.result, 'ORDER_BARCODE_EARLY');
  assert.equal(e.body.session.scannedQty, 0);
  await t.db.destroy();
});

test('missing / duplicate barcodes need an admin; pickers cannot manually confirm', async () => {
  const t = await createTestApp();
  t.orders.setOrder(shopifyOrderNode({
    number: 3001,
    lines: [
      { variant: 1, title: 'Dragon Tattoo', sku: 'IK-0042', barcode: '100001', qty: 1 },
      { variant: 9, title: 'Mystery Tattoo', sku: 'IK-9999', barcode: null, qty: 1 },
    ],
  }));
  const ravi = await t.login('ravi');
  const admin = await t.login('admin');
  const s = (await startPick(t, ravi, 'ORD3001')).body.session;
  const mystery = s.items.find((i) => i.sku === 'IK-9999');
  assert.equal(mystery.issue, 'MISSING_BARCODE');
  await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100001', clientScanId: sid() });
  const blocked = await ravi.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(blocked.body.error, 'NOT_ALL_VERIFIED');

  const denied = await ravi.post(`/api/sessions/${s.id}/manual-verify`).send({ itemKey: mystery.key, reason: 'label missing' });
  assert.equal(denied.status, 403);
  const noReason = await admin.post(`/api/sessions/${s.id}/manual-verify`).send({ itemKey: mystery.key });
  assert.equal(noReason.status, 400);
  const ok = await admin.post(`/api/sessions/${s.id}/manual-verify`).send({ itemKey: mystery.key, reason: 'checked visually, label missing' });
  assert.equal(ok.body.session.allVerified, true);
  const done = await ravi.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(done.body.session.status, 'packed');

  // Duplicate barcode across variants => ambiguous, rejected.
  await t.db('variants').insert({
    shop_id: t.shopId, shopify_product_id: 'gid://shopify/Product/77', shopify_variant_id: 'gid://shopify/ProductVariant/77',
    product_title: 'Dragon Copy', sku: 'IK-DUP', barcode: '100003', synced_at: new Date().toISOString(),
  });
  t.orders.setOrder(order1050());
  const s2 = (await startPick(t, ravi)).body.session;
  assert.equal(s2.items.find((i) => i.sku === 'IK-0200').issue, 'DUPLICATE_BARCODE');
  const amb = await ravi.post(`/api/sessions/${s2.id}/scan`).send({ barcode: '100003', clientScanId: sid() });
  assert.equal(amb.body.result, 'AMBIGUOUS_BARCODE');
  const report = await admin.get('/api/admin/barcodes');
  assert.equal(report.body.duplicates[0].barcode, '100003');
  await t.db.destroy();
});

test('role checks: pickers are kept out of admin', async () => {
  const t = await createTestApp();
  const ravi = await t.login('ravi');
  for (const url of ['/api/admin/stats', '/api/admin/events', '/api/admin/users', '/api/admin/barcodes']) {
    assert.equal((await ravi.get(url)).status, 403, url);
  }
  const anon = require('supertest')(t.app);
  assert.equal((await anon.get('/api/queue')).status, 401);
  assert.equal((await anon.post('/api/login').send({ username: 'ravi', password: 'nope' })).status, 401);
  await t.db.destroy();
});

test('queue shows statuses and picker names', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  t.orders.setOrder(shopifyOrderNode({ number: 1051, lines: [{ variant: 4, title: 'Skull Tattoo', sku: 'IK-0088', barcode: '100088', qty: 3 }] }));
  const ravi = await t.login('ravi');
  await startPick(t, ravi);
  const q = await ravi.get('/api/queue').query({ refresh: '1' });
  const o1050 = q.body.orders.find((o) => o.name === '#1050');
  const o1051 = q.body.orders.find((o) => o.name === '#1051');
  assert.equal(o1050.status, 'PICKING');
  assert.equal(o1050.pickerName, 'Ravi');
  assert.equal(o1050.uniqueSkus, 3);
  assert.equal(o1050.totalQty, 4);
  assert.equal(o1051.status, 'AWAITING_PICK');
  await t.db.destroy();
});

test('normalizeOrder uses remaining quantities from open fulfillment orders only', () => {
  const node = shopifyOrderNode({
    number: 4001,
    foStatus: 'IN_PROGRESS', // partially fulfilled
    lines: [
      { variant: 1, title: 'Dragon Tattoo', sku: 'IK-0042', barcode: '100001', qty: 3, remaining: 1 },
      { variant: 2, title: 'Snake Tattoo', sku: 'IK-0117', barcode: '100002', qty: 2, remaining: 0 }, // already shipped / removed
    ],
    extraFulfillmentOrders: [
      { id: 'fo-closed', status: 'CLOSED', lineItems: { nodes: [{ id: 'x', remainingQuantity: 5, sku: 'IK-0200', variant: { id: 'gid://shopify/ProductVariant/3', barcode: '100003', product: { id: 'p', title: 'Moon' } }, lineItem: { id: 'l', title: 'Moon Tattoo' } }] } },
    ],
  });
  const o = normalizeOrder(node);
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].sku, 'IK-0042');
  assert.equal(o.items[0].qty, 1);
  assert.equal(o.totalQty, 1);
});

test('order barcode parsing', () => {
  assert.deepEqual(parseOrderCode('ORD1050'), { number: 1050, explicit: true });
  assert.deepEqual(parseOrderCode('ord-1050'), { number: 1050, explicit: true });
  assert.deepEqual(parseOrderCode('#1050'), { number: 1050, explicit: true });
  assert.deepEqual(parseOrderCode('1050'), { number: 1050, explicit: false });
  assert.equal(parseOrderCode('IKA35'), null);
});

test('refresh during a pick keeps progress', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const s = (await startPick(t, ravi)).body.session;
  await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100002', clientScanId: sid() });
  const active = await ravi.get('/api/sessions/active');
  assert.equal(active.body.sessions[0].id, s.id);
  const reload = await ravi.get(`/api/sessions/${s.id}`);
  assert.equal(reload.body.session.scannedQty, 1);
  await t.db.destroy();
});

test('pause frees the order: another picker continues with progress kept', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const ravi = await t.login('ravi');
  const priya = await t.login('priya');
  const s = (await ravi.post('/api/sessions').send({ orderId: 'gid://shopify/Order/1050' })).body.session;
  await ravi.post(`/api/sessions/${s.id}/scan`).send({ barcode: '100001', clientScanId: sid() });
  // Priya can't pause Ravi's pick.
  assert.equal((await priya.post(`/api/sessions/${s.id}/pause`).send({})).status, 403);
  const p = await ravi.post(`/api/sessions/${s.id}/pause`).send({});
  assert.equal(p.body.session.status, 'paused');
  // Ravi can't complete or scan a paused pick.
  assert.equal((await ravi.post(`/api/sessions/${s.id}/complete`).send({})).body.error, 'SESSION_PAUSED');
  // Priya takes it over and sees 1 / 4 already verified.
  const r = await priya.post('/api/sessions').send({ orderId: 'gid://shopify/Order/1050' });
  assert.equal(r.status, 200);
  assert.equal(r.body.session.id, s.id);
  assert.equal(r.body.session.scannedQty, 1);
  assert.equal(r.body.session.pickerName, 'Priya');
  // Now Ravi is locked out.
  const again = await ravi.post('/api/sessions').send({ orderId: 'gid://shopify/Order/1050' });
  assert.equal(again.status, 423);
  for (const b of ['100002', '100002', '100003']) {
    await priya.post(`/api/sessions/${s.id}/scan`).send({ barcode: b, clientScanId: sid() });
  }
  const done = await priya.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(done.body.session.status, 'packed');
  await t.db.destroy();
});
