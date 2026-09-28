'use strict';

// Initial schema. Every business table carries shop_id so the app can later
// serve several Shopify stores (SaaS) without a schema rewrite.

exports.up = async function up(knex) {
  await knex.schema.createTable('shops', (t) => {
    t.increments('id').primary();
    t.string('domain').notNullable().unique();
    t.string('name');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.integer('shop_id').notNullable().references('shops.id');
    t.string('username').notNullable();
    t.string('display_name').notNullable();
    t.string('password_hash').notNullable();
    t.string('role').notNullable(); // 'admin' | 'picker'
    t.boolean('active').notNullable().defaultTo(true);
    t.boolean('sound_muted').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['shop_id', 'username']);
  });

  await knex.schema.createTable('auth_sessions', (t) => {
    t.string('id', 128).primary(); // sha256 of the cookie token
    t.integer('user_id').notNullable().references('users.id');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at').notNullable();
  });

  // Cache of Shopify variants used for barcode lookup, "missing barcode" and
  // "duplicate barcode" reports. Shopify stays the source of truth.
  await knex.schema.createTable('variants', (t) => {
    t.increments('id').primary();
    t.integer('shop_id').notNullable().references('shops.id');
    t.string('shopify_product_id').notNullable();
    t.string('shopify_variant_id').notNullable();
    t.string('product_title').notNullable();
    t.string('variant_title');
    t.string('sku');
    t.string('barcode');
    t.text('image_url');
    t.string('product_status');
    t.timestamp('synced_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['shop_id', 'shopify_variant_id']);
    t.index(['shop_id', 'barcode']);
    t.index(['shop_id', 'sku']);
  });

  await knex.schema.createTable('picking_sessions', (t) => {
    t.increments('id').primary();
    t.integer('shop_id').notNullable().references('shops.id');
    t.string('shopify_order_id').notNullable();
    t.string('order_name').notNullable();
    t.integer('order_number');
    t.integer('picker_id').notNullable().references('users.id');
    // picking -> verified -> packed ; or released (admin) / cancelled
    t.string('status').notNullable();
    // Non-null while the order is claimed (picking/verified/packed). The unique
    // constraint is the lock that stops two pickers working the same order.
    t.string('lock_key').unique();
    t.text('items_json').notNullable(); // snapshot of required lines + scanned counts
    t.integer('expected_qty').notNullable().defaultTo(0);
    t.integer('scanned_qty').notNullable().defaultTo(0);
    t.integer('wrong_scans').notNullable().defaultTo(0);
    t.integer('extra_scans').notNullable().defaultTo(0);
    t.integer('manual_verifications').notNullable().defaultTo(0);
    t.string('flag'); // e.g. ORDER_CHANGED, ORDER_CANCELLED
    t.text('flag_detail');
    t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('verified_at');
    t.timestamp('completed_at');
    t.integer('duration_seconds');
    t.integer('released_by').references('users.id');
    t.timestamp('released_at');
    t.string('release_reason');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['shop_id', 'shopify_order_id']);
    t.index(['shop_id', 'status']);
    t.index(['shop_id', 'started_at']);
  });

  await knex.schema.createTable('scan_events', (t) => {
    t.increments('id').primary();
    t.integer('shop_id').notNullable().references('shops.id');
    t.integer('session_id').references('picking_sessions.id');
    t.integer('picker_id').references('users.id');
    t.string('shopify_order_id');
    t.string('order_name');
    t.string('barcode');
    t.string('shopify_variant_id');
    t.string('sku');
    t.string('product_title');
    // CORRECT, WRONG_PRODUCT, UNKNOWN_BARCODE, EXTRA_ITEM, AMBIGUOUS_BARCODE,
    // DOUBLE_SCAN_IGNORED, ORDER_BARCODE_EARLY, OTHER_ORDER_BARCODE,
    // ORDER_RESCAN_OK, ORDER_RESCAN_MISMATCH, MANUAL_VERIFY, SESSION_STARTED,
    // SESSION_RELEASED, ORDER_CHANGED ...
    t.string('result').notNullable();
    t.string('client_scan_id');
    t.text('detail');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['session_id', 'client_scan_id']);
    t.index(['shop_id', 'created_at']);
    t.index(['session_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('scan_events');
  await knex.schema.dropTableIfExists('picking_sessions');
  await knex.schema.dropTableIfExists('variants');
  await knex.schema.dropTableIfExists('auth_sessions');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('shops');
};
