'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { load } = require('../src/config');
const { createRuntime } = require('../src/runtime');

const quiet = { info() {}, warn() {}, error() {} };

test('start-up creates admin and the default packers Shivam (123) and Priti (321), once', async () => {
  const config = load({
    SQLITE_FILE: ':memory:',
    DATABASE_URL: process.env.TEST_DATABASE_URL || '',
    SHOPIFY_STORE_DOMAIN: 'ink.myshopify.com',
    SHOPIFY_CLIENT_ID: 'x',
    SHOPIFY_CLIENT_SECRET: 'y',
    ADMIN_PASSWORD: 'admin123',
  });
  const rt = await createRuntime(config, { log: quiet });
  if (config.databaseUrl) {
    // Postgres run: start from a clean slate for this test.
    await rt.db('auth_sessions').del();
  }
  const users = await rt.db('users').orderBy('username').select('username', 'display_name', 'role');
  const byName = Object.fromEntries(users.map((u) => [u.username, u]));
  assert.equal(byName.shivam.role, 'picker');
  assert.equal(byName.shivam.display_name, 'Shivam');
  assert.equal(byName.priti.role, 'picker');
  assert.equal(byName.admin.role, 'admin');

  const agent = request(rt.app);
  assert.equal((await agent.post('/api/login').send({ username: 'shivam', password: '123' })).status, 200);
  assert.equal((await agent.post('/api/login').send({ username: 'Priti', password: '321' })).status, 200);
  assert.equal((await agent.post('/api/login').send({ username: 'priti', password: '123' })).status, 401);

  // A changed password is not reset on the next start-up.
  await rt.db('users').where({ username: 'shivam' }).update({ password_hash: await require('bcryptjs').hash('newpass', 4) });
  const { createAuth } = require('../src/services/auth');
  await createAuth(rt.db, config).ensureSeedPickers(rt.shopId, quiet);
  assert.equal((await agent.post('/api/login').send({ username: 'shivam', password: '123' })).status, 401);
  assert.equal((await agent.post('/api/login').send({ username: 'shivam', password: 'newpass' })).status, 200);
  await rt.db.destroy();
});
