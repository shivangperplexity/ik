# Ink Kulture — Pick & Pack Verification

Barcode-verified picking for the Ink Kulture Shopify store. A picker **cannot complete an order** until every design and quantity has been scanned. No order slip is needed.

```
LOGIN → ORDER QUEUE → ▶ START PICKING → SCAN ITEMS (⏸ pause any time) → ALL VERIFIED → ✓ COMPLETE PACKING → PACKED
```

## How it fits with your store

| Question | Answer |
|---|---|
| Existing codebase | The store runs on a Shopify **theme** (Liquid templates) with no backend, so this is a separate web app. The storefront is not touched. |
| Shopify access | GraphQL Admin API (`2026-04`) through a **Dev Dashboard app** using the client-credentials grant; the app requests a fresh 24-hour token automatically. An older `shpat_` admin token also works. |
| Database | Postgres in production (SQLite locally). Tables: `shops`, `users`, `auth_sessions`, `variants` (barcode cache), `picking_sessions`, `scan_events`. Every table has `shop_id` so more stores can be added later. |
| Source of truth | Shopify. Required quantities come from **open fulfillment orders' remaining quantities**, which covers partial fulfilment, removed or refunded lines and order edits. Cancelled orders are blocked. |
| Customer data | None is requested or stored: no names, addresses, emails or phones. |

**Shopify limits found while building:**
- New "custom apps" can no longer be created in Shopify admin; use the Dev Dashboard (steps below).
- Shopify rejects any query whose *requested* cost is over 1,000 points. The queue therefore uses a light query paged 25 orders at a time, and full line details are fetched only when a pick starts. All three queries were tested against the live store.

## Barcodes

- **Products:** every variant's Shopify *Barcode* field is set to its SKU (IKA1…IKI3; 169 in total). Print labels from **Admin → Barcodes → Print barcode labels**, or use the ready-made PDFs (`Ink-Kulture-labels-A4-4x10-48x26mm.pdf`, `…-3x8-64x33mm.pdf`). Print at **100% / Actual size**, not "Fit to page".
- **Orders:** no slip or order barcode is needed. Each order in the queue has its own **▶ Start picking** button.
- A variant without a barcode, or with a barcode shared by another variant, is flagged in **Admin → Barcodes** and cannot be scanned. Only an admin can manually confirm it, with a logged reason.

## Deploy on Netlify

Netlify serves the pages from `public/`. The API runs as a Netlify Function (`netlify/functions/api.js`), and a scheduled function re-syncs product barcodes every 15 minutes. Data is kept in **Postgres**, because Netlify functions can't keep files between requests.

1. **Get a Postgres database.** Either option works:
   - **Neon (free):** sign up at neon.tech and create a project in the *AWS Singapore* region. Under **Connect**, copy the **pooled** connection string; its host contains `-pooler`.
   - **Netlify Database:** only on Netlify's credit-based plans. Its connection string (`NETLIFY_DB_URL`) is picked up automatically.
2. **Create the Shopify app**
   1. In the Dev Dashboard (dev.shopify.com → Apps), click **Create app**. Name it `Ink Kulture Pick & Pack`.
   2. Click **Create version**. Set scopes to `read_orders`, `read_products`, `read_merchant_managed_fulfillment_orders` and `write_orders` (`write_orders` is only used to tag packed orders `ik-packed`). Click **Release**.
   3. Click **Install app** and choose the Ink Kulture store.
   4. Under **Settings**, copy the **Client ID** and **Client secret**.
   5. If orders ever return an access error, enable *Protected customer data* (level 1 only; no name, address, email or phone) in the app's API access settings.
3. **Put this folder in a GitHub repository**, then in Netlify go to **Add new project → Import an existing project** and pick it. Netlify reads `netlify.toml`; the build command and publish folder are already set.
4. In Netlify, go to **Project configuration → Environment variables** and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled connection string |
   | `SHOPIFY_STORE_DOMAIN` | `xxxx.myshopify.com` (Shopify admin → Settings → Domains) |
   | `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | from step 2 |
   | `ADMIN_PASSWORD` | first admin password (username `admin`) |
   | `APP_TIMEZONE` | `Asia/Kolkata` |

   Then choose **Deploys → Trigger deploy**.
5. Open your `*.netlify.app` address and log in as `admin`. The first request sets up the database tables. Go to **Admin → Barcodes** and click **Sync products**; you should see "Every product has a barcode".
6. **Admin → Staff:** add a Picker account for each person.

Notes for Netlify:
- The scheduled sync only runs on the **published** production deploy. The **Sync products** button works anywhere.
- Every Shopify call the app makes takes about 1–2 seconds, well within Netlify's function time limit.
- Failed-login limits are counted per function instance, so on Netlify they are looser than on a single server.

### Other hosts

For Render, use `render.yaml`. For Docker or a VPS, use the `Dockerfile` or `npm start`. Set the same environment variables as in `.env.example`.

## Packers and phone scanning

**Default packer logins**, created automatically on first start:

| Name | Username | Password |
|---|---|---|
| Shivam | `shivam` | `123` |
| Priti | `priti` | `321` |

These passwords are short. Anyone who knows your Netlify link could guess them, so change them in **Admin → Staff → Reset password** once everyone has logged in. To add other packers, use Admin → Staff. Packer passwords need at least 3 characters; admin passwords at least 6. You can change the defaults with the `SEED_PICKERS` variable.

**Scanning with the phone camera**
1. Open your Netlify link in **Chrome (Android)** or **Safari (iPhone)** and log in. When asked, allow camera access.
2. Tip: use the browser menu → **Add to Home screen** so it opens like an app.
3. **Start an order:** in the queue, tap **▶ Start picking** on the order.
4. **Turn on the camera:** tap the green **📷 START CAMERA** button and choose **Allow**. After the first time, the camera opens by itself.
   - If it says the camera is blocked: on iPhone tap **aA** → Website Settings → Camera → Allow; on Android tap the 🔒 icon by the address → Permissions → Camera → Allow. Then tap **Try again**.
   - If the link was opened from WhatsApp or Instagram, open it in Chrome or Safari instead. Apps' built-in browsers can't use the camera.
5. **Scan items:** **tap "TAP TO SCAN ITEM" once for each packet** and hold its label inside the box.
   - One tap counts one packet. The same label can't be counted twice by leaving it in view, so for ×2 you scan two packets with two taps.
6. **Pause:** tap **⏸ Pause picking** at any time. Scans are saved, and the order shows as **Paused** in the queue. Anyone (Shivam or Priti) can tap **▶ Resume picking** and carry on from where it stopped.
   - **Cancel pick** deletes the progress and puts the order back to *Awaiting pick*.
7. **Finish:** once everything is verified, the camera hides and **✓ COMPLETE PACKING** turns green. Tap it. The app re-checks the order with Shopify before marking it packed.
8. In a dim room, use the 🔦 button to turn on the phone's torch, where the phone supports it.
9. If you pair a Bluetooth scanner with a phone, turn on **Bluetooth scanner: ON** on the queue screen.

Print product labels from a computer. Labels scan best at the 4 × 10 size or bigger.

## Test with your real store and a scanner

**Scanner setup (USB or Bluetooth):** use keyboard (HID) mode, with an **Enter** suffix (the factory default on most models) and the US keyboard layout. Check by opening Notepad and scanning a label: the code should appear followed by a new line.

1. Log in as a picker on the packing-station laptop or tablet.
2. Place a test order in your store for 2 × one design + 1 × another, or use an existing unfulfilled order.
3. Click **▶ Start picking** on it. The picking screen opens with large photos and shows `0 / N ITEMS VERIFIED`.
4. Scan a correct design. You should see a green **✓ CORRECT ITEM** and hear a beep.
5. Scan a design that isn't in the order. You should see a red **✕ WRONG PRODUCT** with a buzz, showing what you scanned and what's expected. The count does not change.
6. Scan the same design one more time than required. You should see **✕ EXTRA ITEM** and the count does not change.
7. Press F5 in the middle of the order. Progress is kept.
8. Tap **⏸ Pause picking**. The order shows *Paused* in the queue; tap **▶ Resume picking** and the count continues.
9. Scan everything. **✓ ALL ITEMS VERIFIED** appears and **COMPLETE PACKING** turns on.
10. Tap **COMPLETE PACKING**. You should see **✓ PACKING COMPLETE**, and the order gets the `ik-packed` tag in Shopify.
11. As admin, check **Today**, **Scan log** and **Pick history**. Open the same order as a second picker to see "Being picked by …". **Active picks → Release** frees a stuck order.

## Local development

```bash
npm install
npm test                 # 22 tests on SQLite (includes the #1050 acceptance scenario)
TEST_DATABASE_URL=postgres://… npm test -- --test-concurrency=1   # same suite on Postgres
npm run demo             # http://localhost:3100 with a snapshot of the real catalogue (no Shopify needed)
node demo/mock-shopify.js  # stand-in Shopify API (set SHOPIFY_API_BASE_URL=http://127.0.0.1:4400) for testing deploy bundles
cp .env.example .env && npm start   # against the real store (export the variables first)
```

Demo logins: `admin/admin123`, `shivam/123`, `priti/321`. The demo also includes one clearly marked demo order, `#9001` (3 real designs, 4 items).

## Project layout

```
src/
  index.js              long-running server (local/Render/Docker)
  runtime.js            shared start-up: database, migrations, Shopify client, first admin
netlify/functions/      api.js (the whole API) and sync-products.js (every 15 min)
netlify.toml            Netlify build, routes and schedule
  server.js             Express routes (API + pages)
  config.js, db.js      env config; knex (Postgres or SQLite)
  migrations/           schema
  shopify/              GraphQL client (token refresh, retries), queries, orders, product sync
  services/picking.js   lock/claim, pause/resume, scan validation, quantity limits, completion lock
  services/queue.js     order queue merged with picking status
  services/stats.js     today's dashboard and per-picker stats
  services/auth.js      staff accounts (bcrypt), sessions, roles
public/                 queue, picking screen, admin, labels (plain JS, no build step)
test/                   acceptance + workflow + Shopify client tests
demo/                   local demo on a snapshot of real store data
```

## Designed to extend

Multi-store support uses `shop_id` on every table plus a `shops` table. Batch picking, bin scanning, returns checks and packing stations can be added as new `scan_events.result` types and session types without schema rewrites.
