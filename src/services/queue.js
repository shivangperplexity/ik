'use strict';

const STATUS = { picking: 'PICKING', verified: 'VERIFIED', paused: 'PAUSED', packed: 'PACKED' };

function createQueueService({ db, orders, config }) {
  let cache = null; // { at, orders }
  let inflight = null;

  async function fetchOrders(force) {
    const maxAge = config.picking.queueCacheSeconds * 1000;
    if (!force && cache && Date.now() - cache.at < maxAge) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const list = await orders.listQueue(config.picking.queueMaxOrders);
        cache = { at: Date.now(), orders: list, error: null };
        return cache;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function invalidate() {
    cache = null;
  }

  async function getQueue(shopId, { force = false } = {}) {
    let snapshot;
    let stale = false;
    let error = null;
    try {
      snapshot = await fetchOrders(force);
    } catch (e) {
      // Shopify unavailable: fall back to the last good list if we have one.
      if (!cache) throw e;
      snapshot = cache;
      stale = true;
      error = e.message;
    }
    const ids = snapshot.orders.map((o) => o.id);
    const sessions = ids.length
      ? await db('picking_sessions')
        .leftJoin('users', 'users.id', 'picking_sessions.picker_id')
        .where('picking_sessions.shop_id', shopId)
        .whereNotNull('picking_sessions.lock_key')
        .whereIn('picking_sessions.shopify_order_id', ids)
        .select('picking_sessions.*', 'users.display_name as picker_name')
      : [];
    const byOrder = new Map(sessions.map((s) => [s.shopify_order_id, s]));

    const rows = snapshot.orders.map((o) => {
      const s = byOrder.get(o.id);
      return {
        orderId: o.id,
        name: o.name,
        number: o.number,
        createdAt: o.createdAt,
        uniqueSkus: o.uniqueSkus,
        totalQty: o.totalQty,
        onHold: o.onHold && o.totalQty === 0,
        missingBarcodes: o.items.filter((i) => !i.barcode).length,
        status: s ? STATUS[s.status] || s.status.toUpperCase() : (o.totalQty === 0 ? 'NOTHING_TO_PICK' : 'AWAITING_PICK'),
        sessionId: s ? s.id : null,
        pickerId: s ? s.picker_id : null,
        pickerName: s ? s.picker_name : null,
        scannedQty: s ? s.scanned_qty : 0,
        startedAt: s ? new Date(s.started_at).toISOString() : null,
        flag: s ? s.flag : null,
      };
    }).filter((r) => r.status !== 'NOTHING_TO_PICK');

    const counts = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    return { orders: rows, counts, fetchedAt: new Date(snapshot.at).toISOString(), stale, error };
  }

  return { getQueue, invalidate };
}

module.exports = { createQueueService };
