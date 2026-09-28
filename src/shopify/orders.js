'use strict';

const Q = require('./queries');

// Fulfillment orders in these states still need picking.
const PICKABLE_FO_STATUSES = new Set(['OPEN', 'IN_PROGRESS']);
const HOLD_FO_STATUSES = new Set(['ON_HOLD', 'SCHEDULED']);

function orderNumberFromName(name) {
  const m = String(name || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function imageFor(foLine) {
  const v = foLine.variant;
  const variantImg = v && v.media && v.media.nodes && v.media.nodes[0] && v.media.nodes[0].preview && v.media.nodes[0].preview.image;
  const productImg = v && v.product && v.product.featuredMedia && v.product.featuredMedia.preview && v.product.featuredMedia.preview.image;
  const lineImg = foLine.lineItem && foLine.lineItem.image;
  return (lineImg && lineImg.url) || (variantImg && variantImg.url) || (productImg && productImg.url) || null;
}

/**
 * Turn a raw Shopify order node into what the warehouse needs:
 * the quantities that are STILL to be picked, derived from open fulfillment
 * orders (so partially fulfilled, refunded/removed and edited lines are
 * handled by Shopify's own accounting, not assumed from the original order).
 */
function normalizeOrder(node) {
  if (!node) return null;
  const items = new Map();
  const foStatuses = [];
  let onHold = false;

  for (const fo of (node.fulfillmentOrders && node.fulfillmentOrders.nodes) || []) {
    foStatuses.push(fo.status);
    if (HOLD_FO_STATUSES.has(fo.status)) onHold = true;
    if (!PICKABLE_FO_STATUSES.has(fo.status)) continue;
    for (const line of (fo.lineItems && fo.lineItems.nodes) || []) {
      const qty = line.remainingQuantity || 0;
      if (qty <= 0) continue;
      const variantId = line.variant ? line.variant.id : null;
      // Group by variant so the same design split over two lines is one row.
      const key = variantId || `line:${line.lineItem ? line.lineItem.id : line.id}`;
      const existing = items.get(key);
      if (existing) {
        existing.qty += qty;
        continue;
      }
      items.set(key, {
        key,
        variantId,
        productId: line.variant && line.variant.product ? line.variant.product.id : null,
        title: (line.lineItem && line.lineItem.title) || (line.variant && line.variant.product && line.variant.product.title) || 'Unknown item',
        variantTitle: (line.lineItem && line.lineItem.variantTitle) || (line.variant && line.variant.title) || null,
        sku: line.sku || null,
        barcode: line.variant && line.variant.barcode ? String(line.variant.barcode).trim() : null,
        imageUrl: imageFor(line),
        qty,
      });
    }
  }

  const list = Array.from(items.values()).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return {
    id: node.id,
    name: node.name,
    number: orderNumberFromName(node.name),
    createdAt: node.createdAt,
    cancelled: Boolean(node.cancelledAt),
    closed: Boolean(node.closed),
    fulfillmentStatus: node.displayFulfillmentStatus,
    onHold,
    foStatuses,
    items: list,
    uniqueSkus: list.length,
    totalQty: list.reduce((s, i) => s + i.qty, 0),
  };
}

/** Why an order can't be picked right now (null if it can). */
function unpickableReason(order) {
  if (!order) return 'ORDER_NOT_FOUND';
  if (order.cancelled) return 'ORDER_CANCELLED';
  if (order.totalQty === 0 && order.onHold) return 'ORDER_ON_HOLD';
  if (order.totalQty === 0) return 'NOTHING_TO_PICK';
  return null;
}

function createOrderService(client) {
  return {
    async listQueue(limit = 100) {
      const out = [];
      let after = null;
      for (let page = 0; page < 20 && out.length < limit; page += 1) {
        const data = await client.graphql(Q.QUEUE_QUERY, { after, query: Q.QUEUE_SEARCH });
        out.push(...data.orders.nodes.map(normalizeOrder));
        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
      }
      return out.filter((o) => !o.cancelled).slice(0, limit);
    },
    async findByNumber(number) {
      const data = await client.graphql(Q.ORDER_BY_NAME_QUERY, { query: `name:#${number}` });
      const exact = data.orders.nodes.find((n) => orderNumberFromName(n.name) === Number(number));
      return exact ? this.getById(exact.id) : null;
    },
    async getById(id) {
      const data = await client.graphql(Q.ORDER_BY_ID_QUERY, { id });
      return normalizeOrder(data.order);
    },
    async addTag(id, tag) {
      const data = await client.graphql(Q.TAGS_ADD_MUTATION, { id, tags: [tag] });
      const errs = data.tagsAdd.userErrors;
      if (errs && errs.length) throw new Error(errs.map((e) => e.message).join('; '));
    },
  };
}

module.exports = { createOrderService, normalizeOrder, unpickableReason, orderNumberFromName };
