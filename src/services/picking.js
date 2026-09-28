'use strict';

const { unpickableReason } = require('../shopify/orders');
const { ShopifyUnavailableError } = require('../shopify/client');

const nowIso = () => new Date().toISOString();
const norm = (b) => String(b || '').trim().toUpperCase();

class PickError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const REASON_TEXT = {
  ORDER_NOT_FOUND: 'Order not found in Shopify',
  ORDER_CANCELLED: 'This order is CANCELLED — do not pack it',
  ORDER_ON_HOLD: 'This order is on hold in Shopify',
  NOTHING_TO_PICK: 'Nothing left to pick — this order is already fulfilled',
};

/**
 * Order barcodes are printed as ORD<number> (e.g. ORD1050). "#1050" is also
 * accepted. A bare number is only treated as an order if it is not a product
 * barcode (so numeric EAN/UPC product barcodes keep working).
 */
function parseOrderCode(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^ORD[-\s]?(\d{1,12})$/i) || s.match(/^#(\d{1,12})$/);
  if (m) return { number: parseInt(m[1], 10), explicit: true };
  m = s.match(/^(\d{1,9})$/);
  if (m) return { number: parseInt(m[1], 10), explicit: false };
  return null;
}

function orderBarcodeValue(number) {
  return `ORD${number}`;
}

function parseItems(session) {
  return typeof session.items_json === 'string' ? JSON.parse(session.items_json) : session.items_json;
}

function progress(items) {
  const expected = items.reduce((s, i) => s + i.qty, 0);
  const scanned = items.reduce((s, i) => s + Math.min(i.scanned, i.qty), 0);
  return { expected, scanned, complete: expected > 0 && scanned === expected };
}

function toDate(v) {
  return v ? new Date(v).toISOString() : null;
}

function sessionView(session, pickerName) {
  const items = parseItems(session);
  const p = progress(items);
  return {
    id: session.id,
    orderId: session.shopify_order_id,
    orderName: session.order_name,
    orderNumber: session.order_number,
    orderBarcode: session.order_number ? orderBarcodeValue(session.order_number) : null,
    status: session.status,
    pickerId: session.picker_id,
    pickerName: pickerName || session.picker_name || null,
    flag: session.flag || null,
    flagDetail: session.flag_detail || null,
    items: items.map((i) => ({
      key: i.key,
      title: i.title,
      variantTitle: i.variantTitle,
      sku: i.sku,
      barcode: i.barcode,
      imageUrl: i.imageUrl,
      qty: i.qty,
      scanned: i.scanned,
      manual: i.manual || 0,
      issue: i.issue || null,
    })),
    expectedQty: p.expected,
    scannedQty: p.scanned,
    allVerified: p.complete,
    wrongScans: session.wrong_scans,
    extraScans: session.extra_scans,
    startedAt: toDate(session.started_at),
    verifiedAt: toDate(session.verified_at),
    completedAt: toDate(session.completed_at),
    durationSeconds: session.duration_seconds,
  };
}

function itemSummary(i) {
  return { key: i.key, title: i.title, variantTitle: i.variantTitle, sku: i.sku, barcode: i.barcode, imageUrl: i.imageUrl, qty: i.qty, scanned: i.scanned };
}

function sameRequirements(snapshotItems, order) {
  const a = new Map(snapshotItems.map((i) => [i.key, i.qty]));
  const b = new Map(order.items.map((i) => [i.key, i.qty]));
  if (a.size !== b.size) return false;
  for (const [k, q] of a) if (b.get(k) !== q) return false;
  return true;
}

function describeChange(snapshotItems, order) {
  const before = new Map(snapshotItems.map((i) => [i.key, i]));
  const after = new Map(order.items.map((i) => [i.key, i]));
  const lines = [];
  for (const [k, i] of before) {
    const n = after.get(k);
    if (!n) lines.push(`${i.title} (${i.sku || 'no SKU'}) removed`);
    else if (n.qty !== i.qty) lines.push(`${i.title} (${i.sku || 'no SKU'}) quantity ${i.qty} → ${n.qty}`);
  }
  for (const [k, n] of after) if (!before.has(k)) lines.push(`${n.title} (${n.sku || 'no SKU'}) ×${n.qty} added`);
  return lines.join('; ');
}

function createPickingService({ db, orders, config, log = console }) {
  const lockKey = (shopId, orderId) => `${shopId}:${orderId}`;

  async function logEvent(trx, e) {
    await trx('scan_events').insert({ created_at: nowIso(), ...e });
  }

  async function pickerName(id, conn = db) {
    const u = await conn('users').where({ id }).first('display_name');
    return u ? u.display_name : null;
  }

  async function barcodeIndex(shopId, barcodes) {
    if (!barcodes.length) return new Map();
    const rows = await db('variants')
      .where({ shop_id: shopId })
      .whereIn(db.raw('upper(barcode)'), barcodes.map(norm))
      .select('barcode', 'shopify_variant_id');
    const idx = new Map();
    for (const r of rows) {
      const k = norm(r.barcode);
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(r.shopify_variant_id);
    }
    return idx;
  }

  async function buildSnapshot(shopId, order) {
    const idx = await barcodeIndex(shopId, order.items.map((i) => i.barcode).filter(Boolean));
    const inOrder = new Map();
    for (const i of order.items) {
      if (!i.barcode) continue;
      const k = norm(i.barcode);
      inOrder.set(k, (inOrder.get(k) || 0) + 1);
    }
    return order.items.map((i) => {
      let issue = null;
      if (!i.barcode) issue = 'MISSING_BARCODE';
      else {
        const k = norm(i.barcode);
        const others = idx.get(k) ? Array.from(idx.get(k)).filter((v) => v !== i.variantId) : [];
        if (inOrder.get(k) > 1 || others.length > 0) issue = 'DUPLICATE_BARCODE';
      }
      return { ...i, scanned: 0, manual: 0, issue };
    });
  }

  async function findActive(shopId, orderId) {
    return db('picking_sessions').where({ lock_key: lockKey(shopId, orderId) }).first();
  }

  /** Resolve a scanned/typed order code to a live Shopify order. */
  async function lookupOrder(shopId, code) {
    const parsed = parseOrderCode(code);
    if (!parsed) {
      const product = await db('variants').where({ shop_id: shopId }).whereRaw('upper(barcode) = ?', [norm(code)]).first();
      if (product) throw new PickError('PRODUCT_NOT_ORDER', `That is a PRODUCT barcode (${product.product_title}). Scan the ORDER barcode on the pick slip first.`, 400);
      throw new PickError('NOT_AN_ORDER_BARCODE', 'That is not an order barcode. Scan the barcode on the pick slip.', 400);
    }
    if (!parsed.explicit) {
      const isProduct = await db('variants').where({ shop_id: shopId }).whereRaw('upper(barcode) = ?', [norm(code)]).first();
      if (isProduct) throw new PickError('PRODUCT_NOT_ORDER', 'That is a PRODUCT barcode. Scan the ORDER barcode on the pick slip first.', 400);
    }
    const order = await orders.findByNumber(parsed.number);
    if (!order) throw new PickError('ORDER_NOT_FOUND', `Order #${parsed.number} was not found in Shopify`, 404);
    return order;
  }

  async function startSession(shopId, user, orderId) {
    const existing = await findActive(shopId, orderId);
    if (existing) {
      if (existing.status === 'packed') {
        throw new PickError('ALREADY_PACKED', `${existing.order_name} was already packed by ${await pickerName(existing.picker_id)}`, 409, { sessionId: existing.id });
      }
      if (existing.status === 'paused') return resumeSession(existing, user);
      if (existing.picker_id === user.id) return sessionView(existing, user.display_name);
      throw new PickError('LOCKED', `Currently being picked by ${await pickerName(existing.picker_id)}`, 423, {
        sessionId: existing.id,
        pickerName: await pickerName(existing.picker_id),
      });
    }

    const order = await orders.getById(orderId);
    const reason = unpickableReason(order);
    if (reason) throw new PickError(reason, REASON_TEXT[reason], reason === 'ORDER_NOT_FOUND' ? 404 : 409);

    const items = await buildSnapshot(shopId, order);
    const expected = items.reduce((s, i) => s + i.qty, 0);
    const now = nowIso();
    try {
      const id = await db.transaction(async (trx) => {
        const [row] = await trx('picking_sessions')
          .insert({
            shop_id: shopId,
            shopify_order_id: order.id,
            order_name: order.name,
            order_number: order.number,
            picker_id: user.id,
            status: 'picking',
            lock_key: lockKey(shopId, order.id),
            items_json: JSON.stringify(items),
            expected_qty: expected,
            scanned_qty: 0,
            started_at: now,
            updated_at: now,
          })
          .returning('id');
        const sid = typeof row === 'object' ? row.id : row;
        await logEvent(trx, {
          shop_id: shopId,
          session_id: sid,
          picker_id: user.id,
          shopify_order_id: order.id,
          order_name: order.name,
          result: 'SESSION_STARTED',
          detail: `${items.length} lines, ${expected} items`,
        });
        return sid;
      });
      const s = await db('picking_sessions').where({ id }).first();
      return sessionView(s, user.display_name);
    } catch (e) {
      // Unique lock_key violation => another picker claimed it a moment ago.
      const again = await findActive(shopId, order.id);
      if (again && again.picker_id !== user.id) {
        throw new PickError('LOCKED', `Currently being picked by ${await pickerName(again.picker_id)}`, 423, { sessionId: again.id });
      }
      if (again) return sessionView(again, user.display_name);
      throw e;
    }
  }

  /** Continue a paused pick (any picker may take it over). Progress is kept. */
  async function resumeSession(existing, user) {
    const items = parseItems(existing);
    const status = progress(items).complete ? 'verified' : 'picking';
    const n = await db.transaction(async (trx) => {
      const updated = await trx('picking_sessions')
        .where({ id: existing.id, status: 'paused' })
        .update({ status, picker_id: user.id, updated_at: nowIso() });
      if (updated) {
        await logEvent(trx, {
          shop_id: existing.shop_id, session_id: existing.id, picker_id: user.id,
          shopify_order_id: existing.shopify_order_id, order_name: existing.order_name,
          result: 'SESSION_RESUMED', detail: `${existing.scanned_qty}/${existing.expected_qty} already verified`,
        });
      }
      return updated;
    });
    const fresh = await db('picking_sessions').where({ id: existing.id }).first();
    if (!n && fresh.picker_id !== user.id) {
      throw new PickError('LOCKED', `Currently being picked by ${await pickerName(fresh.picker_id)}`, 423, { sessionId: fresh.id });
    }
    return sessionView(fresh, await pickerName(fresh.picker_id));
  }

  /** Pause: keep every scan, free the order so anyone can continue it later. */
  async function pause(sessionId, user) {
    return db.transaction(async (trx) => {
      const s = await loadOwned(trx, sessionId, user, { allowAdmin: true });
      if (s.status === 'paused') return sessionView(s, await pickerName(s.picker_id, trx));
      if (!['picking', 'verified'].includes(s.status)) throw new PickError('SESSION_CLOSED', `This picking session is ${s.status}`, 409);
      await trx('picking_sessions').where({ id: s.id }).update({ status: 'paused', updated_at: nowIso() });
      await logEvent(trx, {
        shop_id: s.shop_id, session_id: s.id, picker_id: user.id, shopify_order_id: s.shopify_order_id,
        order_name: s.order_name, result: 'SESSION_PAUSED', detail: `${s.scanned_qty}/${s.expected_qty} verified`,
      });
      const fresh = await trx('picking_sessions').where({ id: s.id }).first();
      return sessionView(fresh, await pickerName(fresh.picker_id, trx));
    });
  }

  async function loadOwned(trx, sessionId, user, { allowAdmin = false } = {}) {
    const q = trx('picking_sessions').where({ id: sessionId });
    if (trx.client.config.client === 'pg') q.forUpdate();
    const s = await q.first();
    if (!s || s.shop_id !== user.shop_id) throw new PickError('SESSION_NOT_FOUND', 'Picking session not found', 404);
    if (s.picker_id !== user.id && !(allowAdmin && user.role === 'admin')) {
      throw new PickError('NOT_YOUR_SESSION', `This order is being picked by ${await pickerName(s.picker_id, trx)}`, 403);
    }
    return s;
  }

  async function getSession(sessionId, user) {
    const s = await db('picking_sessions').where({ id: sessionId }).first();
    if (!s || s.shop_id !== user.shop_id) throw new PickError('SESSION_NOT_FOUND', 'Picking session not found', 404);
    if (s.picker_id !== user.id && user.role !== 'admin') {
      throw new PickError('NOT_YOUR_SESSION', `This order is being picked by ${await pickerName(s.picker_id)}`, 403);
    }
    return sessionView(s, await pickerName(s.picker_id));
  }

  /**
   * Validate one product scan. All decisions are made server-side inside a
   * transaction so counts can never exceed the required quantity.
   */
  async function scan(sessionId, user, rawBarcode, clientScanId) {
    const barcode = String(rawBarcode || '').trim();
    if (!barcode) throw new PickError('EMPTY_SCAN', 'Empty scan', 400);

    return db.transaction(async (trx) => {
      const s = await loadOwned(trx, sessionId, user);
      const base = {
        shop_id: s.shop_id,
        session_id: s.id,
        picker_id: user.id,
        shopify_order_id: s.shopify_order_id,
        order_name: s.order_name,
        barcode,
        client_scan_id: clientScanId || null,
      };

      if (clientScanId) {
        const dup = await trx('scan_events').where({ session_id: s.id, client_scan_id: clientScanId }).first();
        if (dup) {
          return { result: dup.result, duplicateRequest: true, session: sessionView(s, user.display_name) };
        }
      }

      if (!['picking', 'verified'].includes(s.status)) {
        throw new PickError('SESSION_CLOSED', `This picking session is ${s.status}`, 409);
      }

      const items = parseItems(s);
      const key = norm(barcode);

      // Scanner double-send protection.
      const last = await trx('scan_events')
        .where({ session_id: s.id })
        .whereNotIn('result', ['SESSION_STARTED'])
        .orderBy('id', 'desc')
        .first();
      if (last && norm(last.barcode) === key && Date.now() - new Date(last.created_at).getTime() < config.picking.doubleScanMs) {
        await logEvent(trx, { ...base, result: 'DOUBLE_SCAN_IGNORED' });
        return { result: 'DOUBLE_SCAN_IGNORED', session: sessionView(s, user.display_name) };
      }

      // An ORDER slip (ORD1234 / #1234) scanned while picking items. Bare
      // numbers are treated as product barcodes here (numeric EAN/UPC).
      const orderCode = parseOrderCode(barcode);
      const matching = items.filter((i) => i.barcode && norm(i.barcode) === key);
      if (orderCode && orderCode.explicit && !matching.length) {
        const same = orderCode.number === s.order_number;
        const result = same ? 'ORDER_BARCODE_EARLY' : 'OTHER_ORDER_BARCODE';
        await logEvent(trx, { ...base, result });
        return {
          result,
          message: same
            ? (s.status === 'verified' ? 'All items are verified — tap COMPLETE PACKING' : 'That is the order barcode. Scan the product barcodes.')
            : `That barcode is for order #${orderCode.number}, not ${s.order_name}. Keep the orders separate!`,
          session: sessionView(s, user.display_name),
        };
      }

      let result;
      let item = null;
      let scannedProducts = [];
      const counters = {};

      if (matching.length === 1 && matching[0].issue !== 'DUPLICATE_BARCODE') {
        item = matching[0];
        if (item.scanned >= item.qty) {
          result = 'EXTRA_ITEM';
          counters.extra_scans = s.extra_scans + 1;
        } else {
          item.scanned += 1;
          result = 'CORRECT';
        }
      } else if (matching.length >= 1) {
        result = 'AMBIGUOUS_BARCODE';
        counters.wrong_scans = s.wrong_scans + 1;
      } else {
        const known = await trx('variants')
          .where({ shop_id: s.shop_id })
          .whereRaw('upper(barcode) = ?', [key])
          .select('product_title', 'variant_title', 'sku', 'image_url', 'shopify_variant_id');
        scannedProducts = known.map((k) => ({ title: k.product_title, variantTitle: k.variant_title, sku: k.sku, imageUrl: k.image_url }));
        result = known.length ? 'WRONG_PRODUCT' : 'UNKNOWN_BARCODE';
        counters.wrong_scans = s.wrong_scans + 1;
      }

      const p = progress(items);
      const update = {
        ...counters,
        items_json: JSON.stringify(items),
        scanned_qty: p.scanned,
        updated_at: nowIso(),
      };
      const blocked = items.some((i) => i.scanned < i.qty && i.issue);
      if (result === 'CORRECT' && p.complete && s.status === 'picking') {
        update.status = 'verified';
        update.verified_at = nowIso();
      }
      await trx('picking_sessions').where({ id: s.id }).update(update);
      await logEvent(trx, {
        ...base,
        result,
        shopify_variant_id: item ? item.variantId : null,
        sku: item ? item.sku : (scannedProducts[0] && scannedProducts[0].sku) || null,
        product_title: item ? item.title : (scannedProducts[0] && scannedProducts[0].title) || null,
      });

      const fresh = await trx('picking_sessions').where({ id: s.id }).first();
      return {
        result,
        item: item ? itemSummary(item) : null,
        scannedProducts,
        expected: result === 'CORRECT' || result === 'EXTRA_ITEM' ? undefined : items.filter((i) => i.scanned < i.qty).map(itemSummary),
        blockedByDataIssue: blocked,
        session: sessionView(fresh, user.display_name),
      };
    });
  }

  /** Admin-only manual confirmation for troubleshooting (e.g. damaged label). */
  async function manualVerify(sessionId, admin, itemKey, reason) {
    if (admin.role !== 'admin') throw new PickError('ADMIN_ONLY', 'Only admins can manually verify items', 403);
    if (!reason || String(reason).trim().length < 3) throw new PickError('REASON_REQUIRED', 'Enter a reason for the manual verification', 400);
    return db.transaction(async (trx) => {
      const s = await loadOwned(trx, sessionId, admin, { allowAdmin: true });
      if (s.status !== 'picking') throw new PickError('SESSION_CLOSED', `Session is ${s.status}`, 409);
      const items = parseItems(s);
      const item = items.find((i) => i.key === itemKey);
      if (!item) throw new PickError('ITEM_NOT_IN_ORDER', 'Item is not part of this order', 404);
      if (item.scanned >= item.qty) throw new PickError('EXTRA_ITEM', 'Required quantity already verified', 409);
      item.scanned += 1;
      item.manual = (item.manual || 0) + 1;
      const p = progress(items);
      const update = {
        items_json: JSON.stringify(items),
        scanned_qty: p.scanned,
        manual_verifications: (s.manual_verifications || 0) + 1,
        updated_at: nowIso(),
      };
      if (p.complete) {
        update.status = 'verified';
        update.verified_at = nowIso();
      }
      await trx('picking_sessions').where({ id: s.id }).update(update);
      await logEvent(trx, {
        shop_id: s.shop_id,
        session_id: s.id,
        picker_id: admin.id,
        shopify_order_id: s.shopify_order_id,
        order_name: s.order_name,
        barcode: item.barcode,
        shopify_variant_id: item.variantId,
        sku: item.sku,
        product_title: item.title,
        result: 'MANUAL_VERIFY',
        detail: String(reason).slice(0, 500),
      });
      const fresh = await trx('picking_sessions').where({ id: s.id }).first();
      return sessionView(fresh, await pickerName(fresh.picker_id, trx));
    });
  }

  async function setFlag(sessionId, flag, detail) {
    await db('picking_sessions').where({ id: sessionId }).update({ flag, flag_detail: detail || null, updated_at: nowIso() });
  }

  /** Re-check the live Shopify order against the session snapshot. */
  async function checkOrder(sessionId, user) {
    const s = await db('picking_sessions').where({ id: sessionId }).first();
    if (!s || s.shop_id !== user.shop_id) throw new PickError('SESSION_NOT_FOUND', 'Picking session not found', 404);
    if (!['picking', 'verified'].includes(s.status)) return { flag: s.flag || null };
    const order = await orders.getById(s.shopify_order_id);
    let flag = null;
    let detail = null;
    if (!order) {
      flag = 'ORDER_NOT_FOUND';
      detail = 'Order no longer exists in Shopify';
    } else if (order.cancelled) {
      flag = 'ORDER_CANCELLED';
      detail = 'Order was cancelled in Shopify while being picked';
    } else if (!sameRequirements(parseItems(s), order)) {
      flag = 'ORDER_CHANGED';
      detail = describeChange(parseItems(s), order) || 'Order items changed in Shopify';
    }
    if (flag !== (s.flag || null)) {
      await setFlag(s.id, flag, detail);
      if (flag) {
        await logEvent(db, {
          shop_id: s.shop_id, session_id: s.id, picker_id: s.picker_id, shopify_order_id: s.shopify_order_id,
          order_name: s.order_name, result: flag, detail,
        });
      }
    }
    return { flag, flagDetail: detail };
  }

  /**
   * Final step: "Complete packing". Only allowed when every line is fully
   * verified by barcode and Shopify still agrees with the snapshot. No order
   * slip is needed. If a code is sent anyway it must be this order's.
   */
  async function complete(sessionId, user, rawCode, { skipShopifyCheck = false } = {}) {
    const code = String(rawCode || '').trim();
    const s0 = await db('picking_sessions').where({ id: sessionId }).first();
    if (!s0 || s0.shop_id !== user.shop_id) throw new PickError('SESSION_NOT_FOUND', 'Picking session not found', 404);
    if (s0.picker_id !== user.id) throw new PickError('NOT_YOUR_SESSION', 'Only the picker who picked this order can complete it', 403);
    if (s0.status === 'packed') return sessionView(s0, user.display_name);
    if (s0.status === 'paused') throw new PickError('SESSION_PAUSED', 'This pick is paused. Resume it first.', 409);
    const items0 = parseItems(s0);
    if (s0.status !== 'verified' || !progress(items0).complete) {
      throw new PickError('NOT_ALL_VERIFIED', 'All items must be scanned before completing', 409);
    }

    if (code) {
      const parsed = parseOrderCode(code);
      if (parsed && parsed.explicit && parsed.number !== s0.order_number) {
        await logEvent(db, {
          shop_id: s0.shop_id, session_id: s0.id, picker_id: user.id, shopify_order_id: s0.shopify_order_id,
          order_name: s0.order_name, barcode: code, result: 'ORDER_RESCAN_MISMATCH',
        });
        throw new PickError('ORDER_RESCAN_MISMATCH', `That code is for #${parsed.number}, but these items are for ${s0.order_name}. Do NOT pack them together.`, 409);
      }
    }

    if (skipShopifyCheck && user.role !== 'admin') skipShopifyCheck = false;
    if (!skipShopifyCheck) {
      let order;
      try {
        order = await orders.getById(s0.shopify_order_id);
      } catch (e) {
        if (e instanceof ShopifyUnavailableError) {
          throw new PickError('SHOPIFY_UNAVAILABLE', 'Cannot reach Shopify to double-check the order. Wait a moment and tap Complete packing again.', 503);
        }
        throw e;
      }
      if (!order || order.cancelled) {
        await setFlag(s0.id, 'ORDER_CANCELLED', 'Order was cancelled in Shopify');
        throw new PickError('ORDER_CANCELLED', 'STOP — this order was CANCELLED in Shopify. Do not ship it. Ask an admin.', 409);
      }
      if (!sameRequirements(items0, order)) {
        const detail = describeChange(items0, order);
        await setFlag(s0.id, 'ORDER_CHANGED', detail);
        throw new PickError('ORDER_CHANGED', `Order changed in Shopify while picking: ${detail}. Ask an admin to restart this pick.`, 409);
      }
    }

    const completedAt = new Date();
    const duration = Math.max(0, Math.round((completedAt.getTime() - new Date(s0.started_at).getTime()) / 1000));
    await db.transaction(async (trx) => {
      const n = await trx('picking_sessions')
        .where({ id: s0.id, status: 'verified' })
        .update({ status: 'packed', completed_at: completedAt.toISOString(), duration_seconds: duration, flag: null, flag_detail: null, updated_at: nowIso() });
      if (!n) throw new PickError('SESSION_CHANGED', 'Session changed — reload', 409);
      await logEvent(trx, {
        shop_id: s0.shop_id, session_id: s0.id, picker_id: user.id, shopify_order_id: s0.shopify_order_id,
        order_name: s0.order_name, barcode: code || null, result: 'PACKING_COMPLETED',
        detail: skipShopifyCheck ? 'Completed by admin without Shopify re-check' : null,
      });
    });

    // Best effort: tag the order in Shopify so staff can see it is packed.
    // Awaited (with a short cap) because serverless hosts such as Netlify
    // freeze the process as soon as the response is sent.
    if (config.shopify.packedTag) {
      try {
        await Promise.race([
          orders.addTag(s0.shopify_order_id, config.shopify.packedTag),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 4000)),
        ]);
      } catch (e) {
        if (log.warn) log.warn(`[picking] could not tag ${s0.order_name}: ${e.message}`);
      }
    }
    const fresh = await db('picking_sessions').where({ id: s0.id }).first();
    return sessionView(fresh, user.display_name);
  }

  /** Release a claim (admin for any session, picker for their own unfinished one). */
  async function release(sessionId, user, reason) {
    const s = await db('picking_sessions').where({ id: sessionId }).first();
    if (!s || s.shop_id !== user.shop_id) throw new PickError('SESSION_NOT_FOUND', 'Picking session not found', 404);
    const isOwner = s.picker_id === user.id;
    if (user.role !== 'admin' && !(isOwner && s.status !== 'packed')) {
      throw new PickError('ADMIN_ONLY', 'Only an admin can release this session', 403);
    }
    if (s.status === 'released') return { ok: true };
    await db.transaction(async (trx) => {
      await trx('picking_sessions').where({ id: s.id }).update({
        status: 'released',
        lock_key: null,
        released_by: user.id,
        released_at: nowIso(),
        release_reason: reason ? String(reason).slice(0, 250) : null,
        updated_at: nowIso(),
      });
      await logEvent(trx, {
        shop_id: s.shop_id, session_id: s.id, picker_id: user.id, shopify_order_id: s.shopify_order_id,
        order_name: s.order_name, result: 'SESSION_RELEASED', detail: reason ? String(reason).slice(0, 250) : null,
      });
    });
    return { ok: true };
  }

  return {
    lookupOrder,
    startSession,
    getSession,
    scan,
    manualVerify,
    checkOrder,
    complete,
    release,
    pause,
    findActive,
  };
}

module.exports = {
  createPickingService,
  PickError,
  parseOrderCode,
  orderBarcodeValue,
  sessionView,
  progress,
};
