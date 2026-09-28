'use strict';

const path = require('path');
const fs = require('fs');
const knexFactory = require('knex');
const { migrationSource } = require('./migrations');

function createDb(config) {
  if (config.databaseUrl) {
    const url = config.databaseUrl;
    const local = /localhost|127\.0\.0\.1/.test(url);
    const ssl = /sslmode=disable/.test(url) || local ? false : { rejectUnauthorized: false };
    return knexFactory({
      client: 'pg',
      connection: { connectionString: url, ssl },
      pool: { min: 0, max: config.pgPoolMax, idleTimeoutMillis: 10000 },
      acquireConnectionTimeout: 15000,
    });
  }
  // SQLite is loaded lazily so serverless bundles never need the native module.
  const file = config.sqliteFile === ':memory:' ? ':memory:' : path.resolve(config.sqliteFile);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    // A single connection keeps SQLite writes strictly serialised.
    pool: { min: 1, max: 1 },
  });
}

async function migrate(db) {
  await db.migrate.latest({ migrationSource });
}

async function rollbackAll(db) {
  await db.migrate.rollback({ migrationSource }, true);
}

module.exports = { createDb, migrate, rollbackAll };
