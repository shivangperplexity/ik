'use strict';

// Copy browser libraries into public/vendor so pages load them from our own
// site (works on Netlify's static hosting and offline-friendly).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  ['node_modules/jsbarcode/dist/JsBarcode.all.min.js', 'public/vendor/JsBarcode.all.min.js'], // label/slip printing
  ['node_modules/@zxing/library/umd/index.min.js', 'public/vendor/zxing.min.js'], // phone camera scanning
];
for (const [from, to] of files) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) continue; // e.g. during a partial install
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(src, path.join(root, to));
}
console.log('[build] browser libraries copied to public/vendor');
