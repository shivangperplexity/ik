'use strict';

// Stand-in for the Shopify Admin API, used ONLY to test the deployed bundle
// end-to-end without store credentials. Serves the snapshot in demo/*.json
// through the same endpoints the real client calls (token + GraphQL).
//   node demo/mock-shopify.js   (port 4400)

const http = require('http');
const fs = require('fs');
const path = require('path');

const variants = JSON.parse(fs.readFileSync(path.join(__dirname, 'variants.json'), 'utf8'));
const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'orders.json'), 'utf8'));
const tags = [];
const num = (name) => parseInt(String(name).replace(/\D/g, ''), 10);

function graphql({ query, variables }) {
  if (query.includes('PickQueue')) {
    return { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: orders } };
  }
  if (query.includes('OrderByName')) {
    const n = num(variables.query);
    return { orders: { nodes: orders.filter((o) => num(o.name) === n).map((o) => ({ id: o.id, name: o.name })) } };
  }
  if (query.includes('OrderById')) return { order: orders.find((o) => o.id === variables.id) || null };
  if (query.includes('VariantsPage')) return { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variants } };
  if (query.includes('AddTags')) {
    tags.push(variables);
    return { tagsAdd: { userErrors: [] } };
  }
  throw new Error('Unknown operation');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/admin/oauth/access_token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') !== 'client_credentials' || !p.get('client_secret')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_request' }));
      }
      return res.end(JSON.stringify({ access_token: 'mock-token', scope: 'read_orders,read_products', expires_in: 86399 }));
    }
    if (/^\/admin\/api\/[\w-]+\/graphql\.json$/.test(req.url)) {
      if (req.headers['x-shopify-access-token'] !== 'mock-token') {
        res.statusCode = 401;
        return res.end('{"errors":"Invalid API key or access token"}');
      }
      try {
        return res.end(JSON.stringify({ data: graphql(JSON.parse(body)) }));
      } catch (e) {
        return res.end(JSON.stringify({ errors: [{ message: e.message }] }));
      }
    }
    if (req.url === '/_tags') return res.end(JSON.stringify(tags));
    res.statusCode = 404;
    return res.end('{}');
  });
});

server.listen(process.env.MOCK_PORT || 4400, () => console.log(`[mock-shopify] listening on ${process.env.MOCK_PORT || 4400}`));
