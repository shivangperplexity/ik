(function () {
  'use strict';
  const { $, esc, api } = IK;
  const sessionId = Number(location.pathname.split('/').pop());
  const up = (s) => String(s || '').trim().toUpperCase();

  let confirmed = null;          // last session state from the server
  const pending = [];            // scans sent but not yet answered: { code, predicted }
  let chain = Promise.resolve(); // scans are processed strictly in order
  let feedbackTimer = null;
  let scanner = null;
  let flag = null;
  let camera = null;

  // ---------- local prediction (instant feedback before the server answers) ----------
  function clone(s) { return JSON.parse(JSON.stringify(s)); }
  function isOrderCode(code) { return /^ORD[-\s]?\d+$/i.test(code) || /^#\d+$/.test(code); }

  function predict(state, code) {
    if (isOrderCode(code)) return { result: 'ORDER_SLIP' };
    const matches = state.items.filter((i) => i.barcode && up(i.barcode) === up(code));
    if (matches.length === 1 && matches[0].issue !== 'DUPLICATE_BARCODE') {
      const it = matches[0];
      if (it.scanned >= it.qty) return { result: 'EXTRA_ITEM', item: it };
      return { result: 'CORRECT', item: it };
    }
    if (matches.length) return { result: 'AMBIGUOUS_BARCODE' };
    return { result: 'WRONG_PRODUCT' };
  }

  function applyPrediction(state, code) {
    const p = predict(state, code);
    if (p.result === 'CORRECT') {
      const it = state.items.find((i) => i.key === p.item.key);
      it.scanned += 1;
      state.scannedQty += 1;
      state.allVerified = state.scannedQty === state.expectedQty;
    }
    return p;
  }

  function view() {
    if (!confirmed) return null;
    const s = clone(confirmed);
    for (const p of pending) applyPrediction(s, p.code);
    return s;
  }

  // ---------- rendering ----------
  function statusText(i) {
    if (i.issue === 'MISSING_BARCODE' && i.scanned < i.qty) return 'NO BARCODE — ASK ADMIN';
    if (i.issue === 'DUPLICATE_BARCODE' && i.scanned < i.qty) return 'DUPLICATE BARCODE — ASK ADMIN';
    if (i.scanned >= i.qty) return '✓ VERIFIED';
    const left = i.qty - i.scanned;
    if (i.scanned === 0) return i.qty === 1 ? '⏳ SCAN 1 ITEM' : `⏳ SCAN ${i.qty} ITEMS`;
    return left === 1 ? '⏳ ONE MORE REQUIRED' : `⏳ ${left} MORE REQUIRED`;
  }

  function render(pulseKey) {
    const s = view();
    if (!s) return;
    $('#orderName').innerHTML = `<small>Order</small>${esc(s.orderName)}`;
    document.title = `${s.orderName} · Picking`;
    const pct = s.expectedQty ? Math.round((s.scannedQty / s.expectedQty) * 100) : 0;
    $('#progressText').innerHTML = `${s.scannedQty} / ${s.expectedQty}<span>ITEMS VERIFIED</span>`;
    $('#bar').classList.toggle('done', s.allVerified);
    $('#bar').firstElementChild.style.width = `${pct}%`;

    $('#items').innerHTML = s.items.map((i) => {
      const cls = i.scanned >= i.qty ? 'done' : (i.issue ? 'issue' : (i.scanned > 0 ? 'partial' : ''));
      return `
      <div class="card ${cls} ${pulseKey === i.key ? 'pulse' : ''}" data-key="${esc(i.key)}">
        <div class="img">
          ${i.imageUrl ? `<img src="${esc(i.imageUrl)}${i.imageUrl.includes('?') ? '&' : '?'}width=600" alt="" loading="eager" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'noimg',textContent:'Image unavailable'}))">` : '<span class="noimg">No image</span>'}
          <div class="qtybadge">×${i.qty}</div>
        </div>
        <div class="body">
          <div class="title">${esc(i.title)}</div>
          ${i.variantTitle ? `<div class="variant">${esc(i.variantTitle)}</div>` : ''}
          <div class="codes"><span>SKU <b>${esc(i.sku || '—')}</b></span><span>Barcode <b>${esc(i.barcode || 'missing')}</b></span></div>
          <div class="counts">${i.scanned} / ${i.qty}</div>
          <div class="status">${statusText(i)}</div>
          ${IK.me.role === 'admin' && i.scanned < i.qty && s.status === 'picking' ? `<div class="admin-actions"><button class="btn small" data-manual="${esc(i.key)}">Manual verify (admin)</button></div>` : ''}
        </div>
      </div>`;
    }).join('');
    IK.$$('[data-manual]').forEach((b) => b.addEventListener('click', () => manualVerify(b.dataset.manual)));
    if (pulseKey) setTimeout(() => { const c = document.querySelector(`.card[data-key="${CSS.escape(pulseKey)}"]`); if (c) c.classList.remove('pulse'); }, 250);

    renderFinish(s);
  }

  function renderFinish(s) {
    const el = $('#finish');
    const pauseBtn = $('#pauseBtn');
    const active = ['picking', 'verified'].includes(s.status);
    pauseBtn.classList.toggle('hidden', !active);
    $('#stopBtn').classList.toggle('hidden', !active);
    if (s.status === 'packed') {
      el.className = 'finish ready';
      el.innerHTML = `<div class="grow"><div class="big">✓ PACKING COMPLETE — ${esc(s.orderName)}</div><div class="sub">Packed by ${esc(s.pickerName || '')} in ${IK.fmtDuration(s.durationSeconds)}.</div></div><a class="btn huge" href="/">Next order →</a>`;
      $('#scanState').textContent = 'Done';
      if (camera) { camera.stop(); camera = null; document.body.classList.remove('camera-on'); $('#camdock').innerHTML = ''; }
      return;
    }
    if (s.status === 'paused') {
      el.className = 'finish';
      el.innerHTML = `<div class="grow"><div class="big">⏸ PICKING PAUSED · ${s.scannedQty} / ${s.expectedQty} ITEMS</div>
        <div class="sub muted">Scanned items are saved. Anyone can resume this order from the queue.</div></div>
        <button class="btn huge go" id="resumeBtn">▶ RESUME PICKING</button>`;
      $('#resumeBtn').addEventListener('click', resumePicking);
      document.body.classList.remove('camera-on');
      $('#scanState').textContent = 'Paused';
      return;
    }
    if (s.status === 'released') {
      el.className = 'finish';
      el.innerHTML = '<div class="grow"><div class="big">This pick was cancelled.</div></div><a class="btn huge" href="/">Back to queue</a>';
      return;
    }
    const left = s.expectedQty - s.scannedQty;
    if (s.allVerified) {
      el.className = 'finish ready';
      el.innerHTML = `<div class="grow"><div class="big">✓ ALL ITEMS VERIFIED · ${s.scannedQty} / ${s.expectedQty} ITEMS</div>
        <div class="sub">ORDER READY TO PACK — seal the packet and tap Complete packing.</div></div>
        <button class="btn huge" id="completeBtn">✓ COMPLETE PACKING</button>`;
      $('#completeBtn').addEventListener('click', completePacking);
      $('#scanState').textContent = 'Ready to pack';
      if (camera && document.body.classList.contains('camera-on')) {
        // Nothing left to scan: tuck the camera away so the button is visible.
        document.body.classList.remove('camera-on');
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
      }
    } else {
      el.className = 'finish';
      el.innerHTML = `<div class="grow"><div class="big">${left} item${left === 1 ? '' : 's'} left to scan</div>
        <div class="sub muted">Complete packing unlocks when every item and quantity is verified by barcode.</div></div>
        <button class="btn huge" disabled>COMPLETE PACKING</button>`;
      $('#scanState').textContent = 'Scanner ready';
      if (camera) { camera.setLabel('TAP TO SCAN ITEM'); document.body.classList.add('camera-on'); }
    }
  }

  function showFeedback(kind, { headline, lines = [], count, img, list, action, sticky }) {
    const fb = $('#feedback');
    clearTimeout(feedbackTimer);
    fb.className = `feedback ${kind}${img ? '' : ' nomedia'}`;
    fb.innerHTML = `<div class="panel">
      ${img ? `<img src="${esc(img)}${img.includes('?') ? '&' : '?'}width=440" alt="" onerror="this.remove();document.getElementById('feedback').classList.add('nomedia')">` : ''}
      <div>
        <div class="headline">${headline}</div>
        ${lines.map((l) => `<div class="line ${l.mono ? 'mono' : ''}">${l.html}</div>`).join('')}
        ${count ? `<div class="count">${count}</div>` : ''}
        ${list || ''}
        ${action ? `<div class="action">${action}</div>` : ''}
        ${sticky ? '<div class="dismiss">Scan again to continue · Esc to close</div>' : ''}
      </div></div>`;
    if (kind === 'bad') {
      document.body.classList.remove('screen-flash-bad'); void document.body.offsetWidth; document.body.classList.add('screen-flash-bad');
    } else if (kind === 'ok') {
      document.body.classList.remove('screen-flash-ok'); void document.body.offsetWidth; document.body.classList.add('screen-flash-ok');
    }
    if (!sticky) feedbackTimer = setTimeout(hideFeedback, kind === 'ok' ? 1300 : 3500);
  }
  function hideFeedback() { $('#feedback').className = 'feedback hidden'; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideFeedback(); });
  $('#feedback').addEventListener('click', hideFeedback);

  function expectedList(items) {
    const rows = items.filter((i) => i.scanned < i.qty);
    if (!rows.length) return '';
    return `<div class="list"><div class="cap">Expected products</div>${rows.map((i) => `${esc(i.title)} — <span class="mono">${esc(i.sku || i.barcode || '')}</span>${i.qty - i.scanned > 1 ? ` (×${i.qty - i.scanned})` : ''}`).join('<br>')}</div>`;
  }

  function feedbackFor(result, ctx) {
    const s = view() || confirmed;
    switch (result) {
      case 'CORRECT': {
        const it = ctx.item;
        IK.sound.ok();
        showFeedback('ok', {
          headline: '✓ CORRECT ITEM',
          lines: [{ html: `${esc(it.title)} — <span class="mono">${esc(it.sku || it.barcode)}</span>` }],
          count: `${it.scanned} / ${it.qty} VERIFIED`,
          img: it.imageUrl,
        });
        break;
      }
      case 'EXTRA_ITEM':
        IK.sound.error();
        showFeedback('warn', {
          headline: '✕ EXTRA ITEM',
          lines: [{ html: 'REQUIRED QUANTITY ALREADY VERIFIED' }, { html: `${esc(ctx.item.title)} — <span class="mono">${esc(ctx.item.sku || '')}</span> (${ctx.item.qty} / ${ctx.item.qty})` }],
          img: ctx.item.imageUrl,
          action: 'PUT THIS ITEM BACK',
          sticky: true,
        });
        break;
      case 'WRONG_PRODUCT':
      case 'UNKNOWN_BARCODE': {
        IK.sound.error();
        const sp = (ctx.scannedProducts || [])[0];
        showFeedback('bad', {
          headline: '✕ WRONG PRODUCT',
          lines: [{ html: `<span style="opacity:.85;font-size:16px;letter-spacing:.08em">SCANNED</span><br>${sp ? `${esc(sp.title)} — <span class="mono">${esc(sp.sku || ctx.code)}</span>` : `<span class="mono">${esc(ctx.code)}</span>${result === 'UNKNOWN_BARCODE' ? ' (unknown barcode)' : ''}`}` }],
          img: sp && sp.imageUrl,
          list: expectedList(s.items),
          action: 'PUT THIS ITEM BACK',
          sticky: true,
        });
        break;
      }
      case 'AMBIGUOUS_BARCODE':
        IK.sound.error();
        showFeedback('bad', {
          headline: '✕ DUPLICATE BARCODE',
          lines: [{ html: `Barcode <span class="mono">${esc(ctx.code)}</span> is used by more than one product.` }, { html: 'Ask an admin to fix it in Shopify.' }],
          sticky: true,
        });
        break;
      case 'OTHER_ORDER_BARCODE':
      case 'ORDER_BARCODE_EARLY':
        IK.sound.error();
        showFeedback('bad', {
          headline: result === 'OTHER_ORDER_BARCODE' ? '✕ WRONG ORDER' : 'ORDER BARCODE',
          lines: [{ html: esc(ctx.message || 'Finish scanning all items first') }],
          sticky: true,
        });
        break;
      case 'DOUBLE_SCAN_IGNORED':
        break;
      default:
        IK.sound.error();
        showFeedback('bad', { headline: '✕ SCAN NOT ACCEPTED', lines: [{ html: esc(ctx.message || result) }], sticky: true });
    }
  }

  // ---------- actions ----------
  function onScan(code) {
    hideFeedback();
    const s = view();
    if (!s) return;
    if (s.status === 'packed') {
      showFeedback('ok', { headline: 'ORDER ALREADY PACKED', lines: [{ html: 'Go back to the queue and tap Start picking on the next order.' }] });
      return;
    }
    if (s.status === 'paused') {
      IK.sound.warn();
      showFeedback('warn', { headline: '⏸ PICKING IS PAUSED', lines: [{ html: 'Tap RESUME PICKING first.' }], sticky: true });
      return;
    }
    if (flag) {
      IK.sound.error();
      showFeedback('bad', { headline: '✕ ORDER CHANGED IN SHOPIFY', lines: [{ html: esc(flag.detail || '') }, { html: 'Ask an admin to restart this pick.' }], sticky: true });
      return;
    }
    sendScan(code);
  }

  function sendScan(code) {
    const localBefore = view();
    const predicted = predict(localBefore, code);
    const entry = { code, predicted, id: IK.uid() };
    pending.push(entry);
    // Instant feedback for the cases the browser can judge on its own.
    if (predicted.result === 'CORRECT') {
      const after = view();
      const it = after.items.find((i) => i.key === predicted.item.key);
      feedbackFor('CORRECT', { item: it, code });
      render(it.key);
      if (after.allVerified) IK.sound.complete();
    } else if (predicted.result === 'EXTRA_ITEM') {
      feedbackFor('EXTRA_ITEM', { item: predicted.item, code });
    } else if (predicted.result === 'WRONG_PRODUCT') {
      feedbackFor('WRONG_PRODUCT', { code, scannedProducts: [] }); // refined when the server replies
    }
    $('#scanState').textContent = 'Saving…';

    chain = chain.then(async () => {
      try {
        const r = await api('POST', `/api/sessions/${sessionId}/scan`, { barcode: code, clientScanId: entry.id });
        pending.splice(pending.indexOf(entry), 1);
        confirmed = r.session;
        const serverResult = r.result;
        const shown = predicted.result === 'ORDER_SLIP' ? null : predicted.result;
        if (serverResult === 'WRONG_PRODUCT' || serverResult === 'UNKNOWN_BARCODE') {
          feedbackFor(serverResult, { code, scannedProducts: r.scannedProducts });
        } else if (serverResult !== shown && serverResult !== 'DOUBLE_SCAN_IGNORED') {
          feedbackFor(serverResult, { code, item: r.item, message: r.message, scannedProducts: r.scannedProducts });
        }
        render();
      } catch (e) {
        pending.splice(pending.indexOf(entry), 1);
        render();
        IK.sound.error();
        if (e.network) {
          showFeedback('bad', { headline: '✕ SCAN NOT SAVED', lines: [{ html: 'Connection to the server was lost.' }, { html: 'Check Wi-Fi, then scan this item again.' }], sticky: true });
        } else {
          showFeedback('bad', { headline: '✕ SCAN NOT SAVED', lines: [{ html: esc(e.message) }], sticky: true });
          if (e.code === 'SESSION_CLOSED' || e.code === 'NOT_YOUR_SESSION') loadSession();
        }
      } finally {
        if (!pending.length) renderFinish(view());
      }
    });
  }

  async function completePacking() {
    const btn = $('#completeBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking order…'; }
    await chain; // make sure every scan is saved first
    $('#scanState').textContent = 'Checking order…';
    try {
      const r = await api('POST', `/api/sessions/${sessionId}/complete`, {});
      confirmed = r.session;
      IK.sound.complete();
      showFeedback('done', {
        headline: '✓ PACKING COMPLETE',
        lines: [{ html: `${esc(confirmed.orderName)} · ${confirmed.expectedQty} / ${confirmed.expectedQty} ITEMS` }, { html: 'Seal the packet. Tap Next order to continue.' }],
      });
      render();
    } catch (e) {
      IK.sound.error();
      showFeedback('bad', {
        headline: e.code === 'SHOPIFY_UNAVAILABLE' ? 'SHOPIFY NOT REACHABLE' : '✕ CANNOT COMPLETE',
        lines: [{ html: esc(e.message) }],
        sticky: true,
      });
      if (e.code === 'ORDER_CHANGED' || e.code === 'ORDER_CANCELLED') checkOrder();
      if (e.code === 'NOT_ALL_VERIFIED' || e.code === 'SESSION_PAUSED') await loadSession();
      else renderFinish(view());
    }
  }

  async function pausePicking() {
    const btn = $('#pauseBtn');
    btn.disabled = true;
    btn.textContent = 'Pausing…';
    await chain; // save any scans still on the way
    try {
      const r = await api('POST', `/api/sessions/${sessionId}/pause`, {});
      confirmed = r.session;
      location.href = '/';
    } catch (e) {
      IK.sound.error();
      showFeedback('bad', { headline: '✕ COULD NOT PAUSE', lines: [{ html: esc(e.message) }], sticky: true });
    } finally {
      btn.disabled = false;
      btn.textContent = '⏸ Pause picking';
    }
  }

  async function resumePicking() {
    try {
      const r = await api('POST', '/api/sessions', { orderId: confirmed.orderId });
      if (r.session.id !== sessionId) { location.href = `/pick/${r.session.id}`; return; }
      confirmed = r.session;
      IK.sound.ok();
      if (camera) document.body.classList.add('camera-on');
      render();
      checkOrder();
    } catch (e) {
      IK.sound.error();
      showFeedback('bad', { headline: '✕ CANNOT RESUME', lines: [{ html: esc(e.message) }], sticky: true });
    }
  }

  async function manualVerify(itemKey) {
    const it = confirmed.items.find((i) => i.key === itemKey);
    scanner.pause();
    const reason = await IK.modal({
      title: `Manual verify: ${it.title}`,
      html: `<p>Only use this when the barcode cannot be scanned. It is logged against your name.</p>
        <div class="field"><label>Reason (required)</label><input id="mvReason" placeholder="e.g. label damaged, checked design by eye"></div>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Verify 1 item', cls: 'primary', value: (bg) => bg.querySelector('#mvReason').value.trim() }],
    });
    scanner.resume();
    if (!reason) return;
    try {
      const r = await api('POST', `/api/sessions/${sessionId}/manual-verify`, { itemKey, reason });
      confirmed = r.session;
      IK.sound.ok();
      render(itemKey);
    } catch (e) {
      IK.sound.error();
      showFeedback('bad', { headline: '✕ NOT VERIFIED', lines: [{ html: esc(e.message) }], sticky: true });
    }
  }

  async function searchProduct() {
    scanner.pause();
    await IK.modal({
      title: 'Search product (admin troubleshooting)',
      html: `<div class="field"><label>Name, SKU or barcode</label><input id="psq" placeholder="e.g. Lion or IKA35"></div><div id="psr" style="margin-top:12px"></div>`,
      actions: [{ label: 'Close', value: null }],
      onOpen: (bg) => {
        const q = bg.querySelector('#psq');
        let t = null;
        q.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            if (!q.value.trim()) { bg.querySelector('#psr').innerHTML = ''; return; }
            const r = await api('GET', `/api/admin/products?q=${encodeURIComponent(q.value.trim())}&limit=20`);
            const inOrder = new Set(confirmed.items.map((i) => up(i.barcode)));
            bg.querySelector('#psr').innerHTML = r.products.length ? `<table class="grid compact"><tbody>${r.products.map((p) => `
              <tr><td><img class="thumb" src="${esc(p.image_url || '')}" alt=""></td><td><strong>${esc(p.product_title)}</strong><div class="muted">${esc(p.sku || '')} · ${esc(p.barcode || 'no barcode')}</div></td>
              <td>${inOrder.has(up(p.barcode)) ? '<span class="res CORRECT">IN THIS ORDER</span>' : '<span class="res WRONG_PRODUCT">NOT IN ORDER</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No matches</div>';
          }, 200);
        });
      },
    });
    scanner.resume();
  }

  async function stopPicking() {
    scanner.pause();
    const ok = await IK.modal({
      title: 'Cancel this pick?',
      html: '<p>All scanned progress will be <b>deleted</b> and the order goes back to the queue. Put the items back.</p><p>To take a break and keep your progress, use <b>⏸ Pause picking</b> instead.</p>',
      actions: [{ label: 'Keep picking', value: false }, { label: 'Pause instead', cls: 'primary', value: 'pause' }, { label: 'Delete progress', cls: 'danger', value: true }],
    });
    scanner.resume();
    if (ok === 'pause') { pausePicking(); return; }
    if (ok !== true) return;
    try {
      await api('POST', `/api/sessions/${sessionId}/release`, { reason: 'Cancelled by picker' });
      location.href = '/';
    } catch (e) {
      showFeedback('bad', { headline: '✕ COULD NOT RELEASE', lines: [{ html: esc(e.message) }], sticky: true });
    }
  }

  async function checkOrder() {
    if (!confirmed || !['picking', 'verified'].includes(confirmed.status)) return;
    try {
      const r = await api('POST', `/api/sessions/${sessionId}/check`, {});
      flag = r.flag ? { code: r.flag, detail: r.flagDetail } : null;
      $('#banners').innerHTML = flag ? `<div class="banner bad"><div class="grow">⚠ ${esc(flag.code.replace(/_/g, ' '))}: ${esc(flag.detail || '')}<br><span style="font-weight:600">Stop and ask an admin before packing this order.</span></div></div>` : '';
    } catch (e) { /* network/Shopify hiccup: try again next time */ }
  }

  async function loadSession() {
    try {
      const r = await api('GET', `/api/sessions/${sessionId}`);
      confirmed = r.session;
      if (confirmed.flag) flag = { code: confirmed.flag, detail: confirmed.flagDetail };
      if (confirmed.status === 'released') {
        $('#banners').innerHTML = '<div class="banner warn"><div class="grow">This pick was cancelled and is no longer active.</div><a class="btn" href="/">Back to queue</a></div>';
      }
      render();
    } catch (e) {
      $('#banners').innerHTML = `<div class="banner bad"><div class="grow">${esc(e.message)}</div><a class="btn" href="/">Back to queue</a></div>`;
    }
  }

  function setCamera(on, { startNow = false } = {}) {
    document.body.classList.toggle('camera-on', on);
    IK.pref('camera', on ? '1' : '0');
    $('#camBtn').textContent = on ? '📷 Hide camera' : '📷 Camera';
    if (on && !camera) {
      camera = IK.createCamera({ mount: $('#camdock'), onCode: onScan, label: 'TAP TO SCAN ITEM' });
      $('#camdock').addEventListener('pointerdown', hideFeedback);
      if (startNow) camera.start(); // this tap counts as the permission gesture
      const s = view();
      if (s) renderFinish(s);
    } else if (!on && camera) {
      camera.stop();
      camera = null;
      $('#camdock').innerHTML = '';
    }
  }

  function setupCamera() {
    $('#camBtn').classList.remove('hidden');
    $('#camBtn').addEventListener('click', () => setCamera(!camera, { startNow: true }));
    const pref = IK.pref('camera');
    // Phones show the camera panel by default (with a START CAMERA button).
    const on = pref === null ? IK.isTouch() && !IK.hwScanner() : pref === '1';
    if (on) setCamera(true);
  }

  async function init() {
    await IK.loadMe();
    IK.renderTopbar('pick');
    scanner = IK.createScanner({ zone: $('#scanzone'), onScan });
    if (IK.me.role === 'admin') { $('#searchBtn').classList.remove('hidden'); $('#searchBtn').addEventListener('click', searchProduct); }
    $('#stopBtn').addEventListener('click', stopPicking);
    $('#pauseBtn').addEventListener('click', pausePicking);
    setupCamera();
    await loadSession();
    if (confirmed && ['packed', 'released'].includes(confirmed.status) && camera) {
      camera.stop(); camera = null; $('#camdock').innerHTML = ''; document.body.classList.remove('camera-on');
    }
    checkOrder();
    setInterval(checkOrder, 45000);
    window.addEventListener('beforeunload', (e) => { if (pending.length) { e.preventDefault(); e.returnValue = ''; } });
  }
  init();
})();
