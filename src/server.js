'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createAuth } = require('./services/auth');
const { createPickingService, PickError, orderBarcodeValue } = require('./services/picking');
const { createQueueService } = require('./services/queue');
const { createStatsService } = require('./services/stats');
const { ShopifyUnavailableError, ShopifyApiError } = require('./shopify/client');
const { unpickableReason } = require('./shopify/orders');

const PUBLIC = path.join(__dirname, '..', 'public');

/**
 * Build the Express app.
 * deps.orders: order service (Shopify or a test double)
 * deps.syncProducts: async () => ({ variants }) refreshes the variant cache
 */
function createApp({ config, db, shopId, orders, syncProducts, log = console }) {
  const app = express();
  const auth = createAuth(db, config);
  const picking = createPickingService({ db, orders, config, log });
  const queue = createQueueService({ db, orders, config });
  const stats = createStatsService({ db, config });
  let lastProductSync = null;

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const { requireUser, requireAdmin } = auth;

  // ---------- health ----------
  app.get('/healthz', wrap(async (req, res) => {
    await db.raw('select 1');
    res.json({ ok: true });
  }));

  // ---------- auth ----------
  // Simple brute-force protection: 10 failed attempts per IP+username per 15 min.
  const failures = new Map();
  const LIMIT = 10;
  const WINDOW = 15 * 60000;
  app.post('/api/login', wrap(async (req, res) => {
    const key = `${req.ip}|${String(req.body.username || '').toLowerCase()}`;
    const f = failures.get(key);
    if (f && f.count >= LIMIT && Date.now() - f.first < WINDOW) {
      return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many failed logins. Wait 15 minutes or ask an admin.' });
    }
    const r = await auth.login(shopId, req.body.username, req.body.password);
    if (!r) {
      const cur = f && Date.now() - f.first < WINDOW ? f : { count: 0, first: Date.now() };
      cur.count += 1;
      failures.set(key, cur);
      return res.status(401).json({ error: 'BAD_LOGIN', message: 'Wrong username or password' });
    }
    failures.delete(key);
    res.cookie(auth.COOKIE, r.token, auth.cookieOptions());
    return res.json({ user: r.user });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    await auth.logout(req.cookies[auth.COOKIE]);
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  app.get('/api/me', requireUser, (req, res) => res.json({ user: auth.publicUser(req.user) }));

  app.put('/api/me/preferences', requireUser, wrap(async (req, res) => {
    const soundMuted = Boolean(req.body.soundMuted);
    await db('users').where({ id: req.user.id }).update({ sound_muted: soundMuted });
    res.json({ ok: true, soundMuted });
  }));

  // ---------- queue & order lookup ----------
  app.get('/api/queue', requireUser, wrap(async (req, res) => {
    res.json(await queue.getQueue(shopId, { force: req.query.refresh === '1' }));
  }));

  app.get('/api/orders/lookup', requireUser, wrap(async (req, res) => {
    const order = await picking.lookupOrder(shopId, req.query.code);
    const active = await picking.findActive(shopId, order.id);
    let lock = null;
    if (active) {
      const u = await db('users').where({ id: active.picker_id }).first('display_name');
      lock = { sessionId: active.id, status: active.status, pickerName: u && u.display_name, mine: active.picker_id === req.user.id };
    }
    res.json({
      order: {
        id: order.id, name: order.name, number: order.number, createdAt: order.createdAt,
        uniqueSkus: order.uniqueSkus, totalQty: order.totalQty, cancelled: order.cancelled,
      },
      unpickable: unpickableReason(order),
      lock,
    });
  }));

  // ---------- picking sessions ----------
  app.post('/api/sessions', requireUser, wrap(async (req, res) => {
    let orderId = req.body.orderId;
    if (!orderId && req.body.code) orderId = (await picking.lookupOrder(shopId, req.body.code)).id;
    if (!orderId) throw new PickError('ORDER_REQUIRED', 'Scan an order barcode', 400);
    const session = await picking.startSession(shopId, req.user, orderId);
    queue.invalidate();
    res.json({ session });
  }));

  app.get('/api/sessions/active', requireUser, wrap(async (req, res) => {
    const rows = await db('picking_sessions')
      .where({ shop_id: shopId, picker_id: req.user.id })
      .whereIn('status', ['picking', 'verified'])
      .orderBy('started_at', 'desc')
      .select('id', 'order_name', 'status', 'scanned_qty', 'expected_qty', 'started_at');
    res.json({ sessions: rows });
  }));

  app.get('/api/sessions/:id', requireUser, wrap(async (req, res) => {
    res.json({ session: await picking.getSession(Number(req.params.id), req.user) });
  }));

  app.post('/api/sessions/:id/scan', requireUser, wrap(async (req, res) => {
    const r = await picking.scan(Number(req.params.id), req.user, req.body.barcode, req.body.clientScanId);
    res.json(r);
  }));

  app.post('/api/sessions/:id/complete', requireUser, wrap(async (req, res) => {
    const session = await picking.complete(Number(req.params.id), req.user, req.body.barcode, {
      skipShopifyCheck: Boolean(req.body.skipShopifyCheck),
    });
    queue.invalidate();
    res.json({ session });
  }));

  app.post('/api/sessions/:id/check', requireUser, wrap(async (req, res) => {
    res.json(await picking.checkOrder(Number(req.params.id), req.user));
  }));

  app.post('/api/sessions/:id/pause', requireUser, wrap(async (req, res) => {
    const session = await picking.pause(Number(req.params.id), req.user);
    queue.invalidate();
    res.json({ session });
  }));

  app.post('/api/sessions/:id/release', requireUser, wrap(async (req, res) => {
    const r = await picking.release(Number(req.params.id), req.user, req.body.reason);
    queue.invalidate();
    res.json(r);
  }));

  app.post('/api/sessions/:id/manual-verify', requireUser, requireAdmin, wrap(async (req, res) => {
    const session = await picking.manualVerify(Number(req.params.id), req.user, req.body.itemKey, req.body.reason);
    res.json({ session });
  }));

  // ---------- printing (no customer data) ----------
  app.get('/api/print/order', requireUser, wrap(async (req, res) => {
    const order = req.query.id ? await orders.getById(req.query.id) : await picking.lookupOrder(shopId, req.query.code);
    if (!order) throw new PickError('ORDER_NOT_FOUND', 'Order not found', 404);
    res.json({
      order: {
        id: order.id, name: order.name, number: order.number, createdAt: order.createdAt,
        barcode: orderBarcodeValue(order.number), cancelled: order.cancelled,
        items: order.items.map((i) => ({ title: i.title, variantTitle: i.variantTitle, sku: i.sku, barcode: i.barcode, qty: i.qty, imageUrl: i.imageUrl })),
        totalQty: order.totalQty,
      },
    });
  }));

  app.get('/api/print/queue', requireUser, wrap(async (req, res) => {
    const q = await queue.getQueue(shopId, { force: true });
    res.json({ orders: q.orders.filter((o) => o.status === 'AWAITING_PICK').map((o) => ({ id: o.orderId, name: o.name })) });
  }));

  // ---------- admin ----------
  app.get('/api/admin/stats', requireUser, requireAdmin, wrap(async (req, res) => {
    let pending = null;
    let queueError = null;
    try {
      const q = await queue.getQueue(shopId);
      pending = q.orders.filter((o) => o.status !== 'PACKED').length;
    } catch (e) {
      queueError = e.message;
    }
    res.json({ ...(await stats.today(shopId, { pendingOrders: pending })), queueError });
  }));

  app.get('/api/admin/sessions', requireUser, requireAdmin, wrap(async (req, res) => {
    const q = db('picking_sessions')
      .leftJoin('users', 'users.id', 'picking_sessions.picker_id')
      .where('picking_sessions.shop_id', shopId)
      .orderBy('picking_sessions.id', 'desc')
      .limit(Math.min(Number(req.query.limit) || 100, 500))
      .select(
        'picking_sessions.id', 'order_name', 'shopify_order_id', 'status', 'expected_qty', 'scanned_qty', 'wrong_scans',
        'extra_scans', 'manual_verifications', 'flag', 'flag_detail', 'started_at', 'verified_at', 'completed_at',
        'duration_seconds', 'release_reason', 'users.display_name as picker_name', 'picking_sessions.updated_at',
      );
    if (req.query.status === 'active') q.whereIn('status', ['picking', 'verified', 'paused']);
    else if (req.query.status) q.where('status', req.query.status);
    const rows = await q;
    const staleMs = config.picking.staleLockMinutes * 60000;
    res.json({
      sessions: rows.map((r) => ({
        ...r,
        stale: ['picking', 'verified'].includes(r.status) && Date.now() - new Date(r.updated_at).getTime() > staleMs,
      })),
    });
  }));

  app.get('/api/admin/events', requireUser, requireAdmin, wrap(async (req, res) => {
    const q = db('scan_events')
      .leftJoin('users', 'users.id', 'scan_events.picker_id')
      .where('scan_events.shop_id', shopId)
      .orderBy('scan_events.id', 'desc')
      .limit(Math.min(Number(req.query.limit) || 200, 1000))
      .select('scan_events.*', 'users.display_name as picker_name');
    if (req.query.sessionId) q.where('scan_events.session_id', Number(req.query.sessionId));
    if (req.query.result) q.where('scan_events.result', req.query.result);
    if (req.query.order) q.where('scan_events.order_name', 'like', `%${req.query.order}%`);
    res.json({ events: await q });
  }));

  app.get('/api/admin/barcodes', requireUser, requireAdmin, wrap(async (req, res) => {
    const variants = await db('variants').where({ shop_id: shopId }).orderBy('product_title');
    const missing = variants.filter((v) => !v.barcode);
    const groups = new Map();
    for (const v of variants) {
      if (!v.barcode) continue;
      const k = v.barcode.toUpperCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    const duplicates = Array.from(groups.entries()).filter(([, list]) => list.length > 1).map(([barcode, list]) => ({ barcode, variants: list }));
    const last = variants.reduce((m, v) => (v.synced_at && (!m || new Date(v.synced_at) > new Date(m)) ? v.synced_at : m), null);
    res.json({ total: variants.length, missing, duplicates, lastSync: last ? new Date(last).toISOString() : lastProductSync });
  }));

  app.post('/api/admin/sync-products', requireUser, requireAdmin, wrap(async (req, res) => {
    const r = await syncProducts();
    lastProductSync = r.syncedAt;
    res.json(r);
  }));

  app.get('/api/admin/products', requireUser, requireAdmin, wrap(async (req, res) => {
    const q = db('variants').where({ shop_id: shopId }).orderBy('product_title').limit(Math.min(Number(req.query.limit) || 1000, 5000));
    const term = String(req.query.q || '').trim();
    if (term) {
      q.where((w) => w.whereRaw('lower(product_title) like ?', [`%${term.toLowerCase()}%`])
        .orWhereRaw('lower(sku) like ?', [`%${term.toLowerCase()}%`])
        .orWhereRaw('lower(barcode) like ?', [`%${term.toLowerCase()}%`]));
    }
    res.json({ products: await q });
  }));

  app.get('/api/admin/users', requireUser, requireAdmin, wrap(async (req, res) => {
    const rows = await db('users').where({ shop_id: shopId }).orderBy('display_name');
    res.json({ users: rows.map(auth.publicUser) });
  }));

  app.post('/api/admin/users', requireUser, requireAdmin, wrap(async (req, res) => {
    const u = await auth.createUser(shopId, {
      username: req.body.username,
      displayName: req.body.displayName,
      password: req.body.password,
      role: req.body.role || 'picker',
    });
    res.json({ user: u });
  }));

  app.patch('/api/admin/users/:id', requireUser, requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const target = await db('users').where({ id, shop_id: shopId }).first();
    if (!target) throw new PickError('USER_NOT_FOUND', 'User not found', 404);
    const update = {};
    if (req.body.displayName) update.display_name = String(req.body.displayName).slice(0, 80);
    if (req.body.role && ['admin', 'picker'].includes(req.body.role)) update.role = req.body.role;
    if (typeof req.body.active === 'boolean') update.active = req.body.active;
    if (req.body.password) {
      const minLen = (update.role || target.role) === 'admin' ? 6 : 3;
      if (String(req.body.password).length < minLen) throw new PickError('WEAK_PASSWORD', `Password must be at least ${minLen} characters`, 400);
      update.password_hash = await auth.hashPassword(String(req.body.password));
    }
    if (id === req.user.id && (update.active === false || update.role === 'picker')) {
      throw new PickError('CANNOT_DEMOTE_SELF', 'You cannot deactivate or demote your own account', 400);
    }
    if (Object.keys(update).length) await db('users').where({ id }).update(update);
    if (update.active === false || update.password_hash) await db('auth_sessions').where({ user_id: id }).del();
    res.json({ user: auth.publicUser(await db('users').where({ id }).first()) });
  }));

  // ---------- pages ----------
  const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
  app.get('/', page('queue.html'));
  app.get('/login', page('login.html'));
  app.get('/pick/:id', page('pick.html'));
  app.get('/admin', page('admin.html'));
  app.get('/print/slip', page('slip.html'));
  app.get('/print/labels', page('labels.html'));
  app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'jsbarcode', 'dist'), { maxAge: '7d' }));
  app.use(express.static(PUBLIC, { maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));

  // ---------- errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof PickError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    }
    if (err instanceof ShopifyUnavailableError) {
      return res.status(503).json({ error: 'SHOPIFY_UNAVAILABLE', message: 'Shopify is not reachable right now. Check the internet connection and try again.' });
    }
    if (err instanceof ShopifyApiError) {
      log.error('[shopify]', err.message);
      return res.status(502).json({ error: 'SHOPIFY_ERROR', message: `Shopify error: ${err.message}` });
    }
    if (err && err.status && err.status < 500) {
      return res.status(err.status).json({ error: 'BAD_REQUEST', message: err.message });
    }
    log.error(err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong on the server' });
  });

  app.locals.markProductSync = (at) => { lastProductSync = at; };
  return app;
}

module.exports = { createApp };
