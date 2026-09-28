'use strict';

// Netlify Function that serves the whole JSON API (/api/*, /healthz).
// Static pages come straight from /public via the redirects in netlify.toml.

const serverless = require('serverless-http');
const { load } = require('../../src/config');
const { createRuntime } = require('../../src/runtime');

let ready = null;

function getHandler() {
  if (!ready) {
    ready = (async () => {
      const config = load();
      if (!config.databaseUrl) {
        throw new Error('No database configured. Set DATABASE_URL (e.g. a Neon Postgres connection string) in Netlify → Site configuration → Environment variables.');
      }
      const rt = await createRuntime(config);
      return serverless(rt.app);
    })().catch((e) => {
      ready = null; // retry on the next request
      throw e;
    });
  }
  return ready;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  // Requests arrive either as /api/... or as /.netlify/functions/api/api/...
  event.path = (event.path || '/').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  try {
    const handler = await getHandler();
    return await handler(event, context);
  } catch (e) {
    console.error('[api] startup failed:', e);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'STARTUP_FAILED', message: e.message }),
    };
  }
};
