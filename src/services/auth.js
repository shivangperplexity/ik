'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'ikpp_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: Boolean(u.active),
    soundMuted: Boolean(u.sound_muted),
  };
}

function createAuth(db, config) {
  const days = config.sessionDays;

  async function createUser(shopId, { username, displayName, password, role }) {
    if (!['admin', 'picker'].includes(role)) throw Object.assign(new Error('Role must be admin or picker'), { status: 400 });
    if (!username || !/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
      throw Object.assign(new Error('Username: 2-40 letters, numbers, dot, dash or underscore'), { status: 400 });
    }
    const minLen = role === 'admin' ? 6 : 3;
    if (!password || password.length < minLen) {
      throw Object.assign(new Error(`Password must be at least ${minLen} characters`), { status: 400 });
    }
    const existing = await db('users').where({ shop_id: shopId, username: username.toLowerCase() }).first();
    if (existing) throw Object.assign(new Error('That username already exists'), { status: 409 });
    const [row] = await db('users')
      .insert({
        shop_id: shopId,
        username: username.toLowerCase(),
        display_name: displayName || username,
        password_hash: await bcrypt.hash(password, 10),
        role,
        active: true,
      })
      .returning('id');
    const id = typeof row === 'object' ? row.id : row;
    return publicUser(await db('users').where({ id }).first());
  }

  async function ensureBootstrapAdmin(shopId, log = console) {
    const anyAdmin = await db('users').where({ shop_id: shopId, role: 'admin' }).first();
    if (anyAdmin) return;
    const { username, password, displayName } = config.bootstrapAdmin;
    if (!password) {
      log.warn('[auth] No admin exists yet. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) and restart to create one.');
      return;
    }
    await createUser(shopId, { username, displayName, password, role: 'admin' });
    log.info(`[auth] Created first admin user "${username}".`);
  }

  // Default packer accounts (created once; never overwrites a changed password).
  async function ensureSeedPickers(shopId, log = console) {
    for (const p of config.seedPickers) {
      const exists = await db('users').where({ shop_id: shopId, username: p.username }).first();
      if (exists) continue;
      try {
        await createUser(shopId, { ...p, role: 'picker' });
        log.info(`[auth] Created packer account "${p.username}".`);
      } catch (e) {
        if (!/already exists|unique/i.test(e.message)) throw e;
      }
    }
  }

  async function login(shopId, username, password) {
    const user = await db('users').where({ shop_id: shopId, username: String(username || '').toLowerCase() }).first();
    // Always run bcrypt to keep timing similar for unknown users.
    const ok = await bcrypt.compare(String(password || ''), user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    if (!user || !ok || !user.active) return null;
    const token = crypto.randomBytes(32).toString('hex');
    await db('auth_sessions').insert({
      id: sha256(token),
      user_id: user.id,
      expires_at: new Date(Date.now() + days * 86400000),
    });
    return { token, user: publicUser(user) };
  }

  async function logout(token) {
    if (token) await db('auth_sessions').where({ id: sha256(token) }).del();
  }

  async function userFromToken(token) {
    if (!token) return null;
    const row = await db('auth_sessions')
      .join('users', 'users.id', 'auth_sessions.user_id')
      .where('auth_sessions.id', sha256(token))
      .select('users.*', 'auth_sessions.expires_at')
      .first();
    if (!row || !row.active) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  }

  function cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: days * 86400000,
      path: '/',
    };
  }

  // Express middleware
  const requireUser = async (req, res, next) => {
    try {
      const user = await userFromToken(req.cookies[COOKIE]);
      if (!user) return res.status(401).json({ error: 'NOT_LOGGED_IN', message: 'Please log in' });
      req.user = user;
      return next();
    } catch (e) {
      return next(e);
    }
  };
  const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'ADMIN_ONLY', message: 'Admins only' });
    }
    return next();
  };

  return {
    COOKIE,
    createUser,
    ensureBootstrapAdmin,
    ensureSeedPickers,
    login,
    logout,
    userFromToken,
    cookieOptions,
    requireUser,
    requireAdmin,
    publicUser,
    hashPassword: (p) => bcrypt.hash(p, 10),
  };
}

module.exports = { createAuth, publicUser };
