'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp, order1050 } = require('./helpers');

let n = 0;
const sid = () => `scan-${Date.now()}-${n++}`;

test('ACCEPTANCE: order #1050 end-to-end with wrong, extra, pause/resume and complete button', async () => {
  const t = await createTestApp();
  t.orders.setOrder(order1050());
  const picker = await t.login('ravi');

  // Picker taps "Start picking" on #1050 in the queue (no order slip needed).
  const start = await picker.post('/api/sessions').send({ orderId: 'gid://shopify/Order/1050' });
  assert.equal(start.status, 200);
  const s = start.body.session;
  assert.equal(s.expectedQty, 4);
  assert.equal(s.scannedQty, 0); // "0 / 4 VERIFIED"
  assert.equal(s.allVerified, false);
  const scan = (barcode) => picker.post(`/api/sessions/${s.id}/scan`).send({ barcode, clientScanId: sid() });

  // Scan 100001 -> Dragon, 1/4
  let r = await scan('100001');
  assert.equal(r.body.result, 'CORRECT');
  assert.equal(r.body.item.title, 'Dragon Tattoo');
  assert.equal(r.body.session.scannedQty, 1);

  // Accidentally scan 100099 -> WRONG/UNKNOWN, no increment
  r = await scan('100099');
  assert.ok(['WRONG_PRODUCT', 'UNKNOWN_BARCODE'].includes(r.body.result));
  assert.equal(r.body.session.scannedQty, 1);
  assert.ok(r.body.expected.length > 0, 'shows expected products');

  // Scan 100002 twice -> Snake 2/2, 3/4
  r = await scan('100002');
  assert.equal(r.body.result, 'CORRECT');
  r = await scan('100002');
  assert.equal(r.body.result, 'CORRECT');
  assert.equal(r.body.item.scanned, 2);
  assert.equal(r.body.item.qty, 2);
  assert.equal(r.body.session.scannedQty, 3);

  // Scan 100002 again -> EXTRA ITEM, no increment
  r = await scan('100002');
  assert.equal(r.body.result, 'EXTRA_ITEM');
  assert.equal(r.body.session.scannedQty, 3);

  // Completion must be locked before everything is verified.
  let c = await picker.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(c.status, 409);
  assert.equal(c.body.error, 'NOT_ALL_VERIFIED');

  // Pause keeps progress; scanning is blocked while paused.
  const p = await picker.post(`/api/sessions/${s.id}/pause`).send({});
  assert.equal(p.status, 200);
  assert.equal(p.body.session.status, 'paused');
  assert.equal(p.body.session.scannedQty, 3);
  r = await scan('100003');
  assert.equal(r.status, 409);
  const q = await picker.get('/api/queue');
  assert.equal(q.body.orders.find((o) => o.number === 1050).status, 'PAUSED');

  // "Resume" (same Start button) continues from 3 / 4.
  const resumed = await picker.post('/api/sessions').send({ orderId: 'gid://shopify/Order/1050' });
  assert.equal(resumed.body.session.id, s.id);
  assert.equal(resumed.body.session.status, 'picking');
  assert.equal(resumed.body.session.scannedQty, 3);

  // Scan 100003 -> Phoenix, 4/4 -> ALL VERIFIED
  r = await scan('100003');
  assert.equal(r.body.result, 'CORRECT');
  assert.equal(r.body.session.scannedQty, 4);
  assert.equal(r.body.session.allVerified, true);
  assert.equal(r.body.session.status, 'verified');

  // Not packed until the picker taps COMPLETE PACKING.
  const mid = await picker.get(`/api/sessions/${s.id}`);
  assert.equal(mid.body.session.status, 'verified');

  c = await picker.post(`/api/sessions/${s.id}/complete`).send({});
  assert.equal(c.status, 200);
  assert.equal(c.body.session.status, 'packed');
  assert.ok(c.body.session.durationSeconds >= 0);
  assert.deepEqual(t.orders.tags[0], { id: 'gid://shopify/Order/1050', tag: 'ik-packed' });

  // Audit trail
  const admin = await t.login('admin');
  const ev = await admin.get('/api/admin/events').query({ sessionId: s.id });
  const results = ev.body.events.map((e) => e.result).reverse();
  assert.deepEqual(results, [
    'SESSION_STARTED', 'CORRECT', results[2], 'CORRECT', 'CORRECT', 'EXTRA_ITEM',
    'SESSION_PAUSED', 'SESSION_RESUMED', 'CORRECT', 'PACKING_COMPLETED',
  ]);
  const correctEvent = ev.body.events.find((e) => e.result === 'CORRECT');
  assert.ok(correctEvent.sku && correctEvent.barcode && correctEvent.picker_name === 'Ravi');

  const sessions = await admin.get('/api/admin/sessions');
  const row = sessions.body.sessions.find((x) => x.id === s.id);
  assert.equal(row.expected_qty, 4);
  assert.equal(row.scanned_qty, 4);
  assert.equal(row.wrong_scans, 1);
  assert.equal(row.extra_scans, 1);
  assert.equal(row.picker_name, 'Ravi');

  const stats = await admin.get('/api/admin/stats');
  assert.equal(stats.body.ordersPicked, 1);
  assert.equal(stats.body.itemsScanned, 4);
  assert.equal(stats.body.wrongScansPrevented, 2); // 1 wrong + 1 extra
  const ravi = stats.body.pickers.find((p) => p.name === 'Ravi');
  assert.equal(ravi.ordersPicked, 1);
  assert.equal(ravi.itemsPicked, 4);

  await t.db.destroy();
});
