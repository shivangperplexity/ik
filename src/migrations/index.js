'use strict';

// Migrations are listed in code (not read from a folder at runtime) so they
// still work when the app is bundled into a serverless function (Netlify).
// Add new migrations to the end of this list.
const MIGRATIONS = [
  ['20260928_001_init', require('./20260928_001_init')],
];

const migrationSource = {
  getMigrations: async () => MIGRATIONS.map(([name]) => name),
  getMigrationName: (name) => name,
  getMigration: async (name) => MIGRATIONS.find(([n]) => n === name)[1],
};

module.exports = { migrationSource };
