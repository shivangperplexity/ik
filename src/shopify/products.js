'use strict';

const Q = require('./queries');

function variantImage(v) {
  const m = v.media && v.media.nodes && v.media.nodes[0];
  if (m && m.preview && m.preview.image) return m.preview.image.url;
  const p = v.product && v.product.featuredMedia && v.product.featuredMedia.preview && v.product.featuredMedia.preview.image;
  return p ? p.url : null;
}

async function* fetchAllVariants(client) {
  let after = null;
  for (let page = 0; page < 200; page += 1) {
    const data = await client.graphql(Q.VARIANTS_QUERY, { after });
    for (const v of data.productVariants.nodes) yield v;
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }
}

/**
 * Mirror Shopify variants into the local cache (used for barcode lookup and
 * the missing/duplicate barcode reports). Returns counts.
 */
async function syncVariants(db, client, shopId) {
  const seen = new Set();
  const rows = [];
  for await (const v of fetchAllVariants(client)) {
    seen.add(v.id);
    rows.push({
      shop_id: shopId,
      shopify_product_id: v.product.id,
      shopify_variant_id: v.id,
      product_title: v.product.title,
      variant_title: v.title === 'Default Title' ? null : v.title,
      sku: v.sku || null,
      barcode: v.barcode ? String(v.barcode).trim() : null,
      image_url: variantImage(v),
      product_status: v.product.status,
      synced_at: new Date(),
    });
  }
  await db.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 100) {
      await trx('variants')
        .insert(rows.slice(i, i + 100))
        .onConflict(['shop_id', 'shopify_variant_id'])
        .merge();
    }
    if (seen.size) {
      await trx('variants').where({ shop_id: shopId }).whereNotIn('shopify_variant_id', Array.from(seen)).del();
    }
  });
  return { variants: rows.length, syncedAt: new Date().toISOString() };
}

module.exports = { syncVariants };
