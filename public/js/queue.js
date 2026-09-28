(function () {
  'use strict';
  const { $, esc, api } = IK;
  const STATUS_LABEL = { AWAITING_PICK: 'Awaiting Pick', PICKING: 'Picking', VERIFIED: 'Ready to pack', PAUSED: 'Paused', PACKED: 'Packed' };
  const TILE_MATCH = { AWAITING_PICK: ['AWAITING_PICK'], PICKING: ['PICKING', 'VERIFIED'], PAUSED: ['PAUSED'], PACKED: ['PACKED'] };
  let filter = 'ALL';
  let data = null;
  let busy = false;

  function showAlert(kind, html, sticky) {
    const el = $('#alert');
    el.innerHTML = `<div class="banner ${kind}"><div class="grow">${html}</div></div>`;
    if (!sticky) setTimeout(() => { if (el.innerHTML.includes(html)) el.innerHTML = ''; }, 8000);
  }

  /** The button shown at the end of each order row. */
  function actionCell(o) {
    const mine = o.pickerId === IK.me.id;
    const progress = o.sessionId ? `${o.scannedQty} / ${o.totalQty} scanned` : '';
    if (o.status === 'PACKED') return '<span class="pill PACKED">✓ Packed</span>';
    if (o.status === 'AWAITING_PICK') {
      return `<button class="btn go" data-start="${esc(o.orderId)}">▶ Start picking</button>`;
    }
    if (o.status === 'PAUSED') {
      return `<button class="btn go" data-start="${esc(o.orderId)}">▶ Resume picking</button><div class="note">Paused by ${esc(o.pickerName || '')} · ${progress}</div>`;
    }
    if (mine) {
      return `<button class="btn primary" data-start="${esc(o.orderId)}">Continue picking</button><div class="note">${progress}</div>`;
    }
    return `<button class="btn" disabled>Being picked</button><div class="note">by ${esc(o.pickerName || 'someone')} · ${progress}</div>`;
  }

  function render() {
    if (!data) return;
    const counts = data.counts || {};
    const tiles = [['AWAITING_PICK', 'Awaiting pick'], ['PICKING', 'Picking'], ['PAUSED', 'Paused'], ['PACKED', 'Packed']];
    const tileCount = (k) => TILE_MATCH[k].reduce((n, s) => n + (counts[s] || 0), 0);
    $('#counts').innerHTML = tiles.map(([k, l]) => `
      <div class="stat ${filter === k ? 'active' : ''}" data-k="${k}"><div class="n">${tileCount(k)}</div><div class="l">${l}</div></div>`).join('');
    IK.$$('#counts .stat').forEach((el) => el.addEventListener('click', () => {
      filter = filter === el.dataset.k ? 'ALL' : el.dataset.k;
      render();
    }));
    $('#fetched').textContent = `${data.stale ? '⚠ Shopify unreachable — showing last list · ' : ''}updated ${IK.fmtAgo(data.fetchedAt)}${filter !== 'ALL' ? ` · showing ${tiles.find((t) => t[0] === filter)[1]}` : ''}`;
    const list = data.orders.filter((o) => filter === 'ALL' || TILE_MATCH[filter].includes(o.status));
    if (!list.length) {
      $('#rows').innerHTML = `<tr><td colspan="7" class="empty">${filter === 'ALL' ? 'No unfulfilled orders right now 🎉' : 'No orders with this status'}</td></tr>`;
      return;
    }
    $('#rows').innerHTML = list.map((o) => `
      <tr data-id="${esc(o.orderId)}">
        <td><div class="order-no">${esc(o.name)}</div>${o.missingBarcodes ? `<div class="res WRONG_PRODUCT" style="display:inline-block;margin-top:4px">${o.missingBarcodes} item(s) without barcode</div>` : ''}</td>
        <td class="hide-sm"><strong>${o.uniqueSkus}</strong></td>
        <td><strong>${o.totalQty}</strong><span class="qty-unit"> item${o.totalQty === 1 ? '' : 's'}</span></td>
        <td class="hide-sm">${IK.fmtTime(o.createdAt)}<div class="muted" style="font-size:14px">${IK.fmtAgo(o.createdAt)}</div></td>
        <td><span class="pill ${o.status}">${STATUS_LABEL[o.status] || o.status}</span>${o.flag ? ` <span class="pill flag">${esc(o.flag.replace('_', ' '))}</span>` : ''}</td>
        <td class="hide-sm">${o.pickerName ? esc(o.pickerName) : '<span class="muted">—</span>'}</td>
        <td class="rowact">${actionCell(o)}</td>
      </tr>`).join('');
    IK.$$('#rows [data-start]').forEach((b) => b.addEventListener('click', () => start({ orderId: b.dataset.start }, b)));
  }

  async function load(force) {
    try {
      data = await api('GET', `/api/queue${force ? '?refresh=1' : ''}`);
      render();
    } catch (e) {
      if (!data) $('#rows').innerHTML = `<tr><td colspan="7" class="empty" style="color:var(--bad)">${esc(e.message)}</td></tr>`;
      else showAlert('warn', esc(e.message));
    }
  }

  async function loadResume() {
    try {
      const r = await api('GET', '/api/sessions/active');
      $('#resume').innerHTML = r.sessions.map((s) => `
        <div class="banner info"><div class="grow">You have an unfinished pick: <strong>${esc(s.order_name)}</strong> (${s.scanned_qty}/${s.expected_qty} verified)</div>
        <a class="btn primary" href="/pick/${s.id}">Continue</a></div>`).join('');
    } catch (e) { /* ignore */ }
  }

  /** Start (or resume) picking an order. body = { orderId } or { code }. */
  async function start(body, button) {
    if (busy) return;
    busy = true;
    const oldText = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Opening…'; }
    try {
      const r = await api('POST', '/api/sessions', body);
      IK.sound.ok();
      location.href = `/pick/${r.session.id}`;
    } catch (e) {
      IK.sound.error();
      if (button) { button.disabled = false; button.textContent = oldText; }
      const kind = e.code === 'LOCKED' || e.code === 'ORDER_CANCELLED' ? 'bad' : 'warn';
      showAlert(kind, `✕ ${esc(e.message)}${e.code === 'LOCKED' && IK.me.role === 'admin' && e.body.sessionId ? ` — <a href="/admin#active" style="color:#fff">release in Admin</a>` : ''}`, true);
      if (e.code === 'LOCKED' || e.code === 'ALREADY_PACKED') load(true);
    } finally {
      busy = false;
    }
  }

  function setupDevices() {
    if (IK.isTouch()) {
      const hw = $('#hwToggle');
      hw.classList.remove('hidden');
      const paint = () => { hw.textContent = `Bluetooth scanner: ${IK.hwScanner() ? 'ON' : 'OFF'}`; };
      paint();
      hw.addEventListener('click', () => { IK.pref('hwScanner', IK.hwScanner() ? '0' : '1'); paint(); });
    }
  }

  async function init() {
    await IK.loadMe();
    IK.renderTopbar('queue');
    setupDevices();
    $('#refresh').addEventListener('click', () => load(true));
    $('#typeOrder').addEventListener('click', async () => {
      const v = await IK.modal({
        title: 'Find order',
        html: '<div class="field"><label>Order number (e.g. 1074)</label><input id="typedOrder" inputmode="numeric"></div>',
        actions: [{ label: 'Cancel', value: null }, { label: 'Start picking', cls: 'primary', value: (bg) => bg.querySelector('#typedOrder').value.trim() }],
        onOpen: (bg, close) => bg.querySelector('#typedOrder').addEventListener('keydown', (e) => { if (e.key === 'Enter') close(e.target.value.trim()); }),
      });
      if (v) start({ code: `#${v.replace(/^#/, '')}` });
    });
    load(false);
    loadResume();
    setInterval(() => load(false), 30000);
  }
  init();
})();
