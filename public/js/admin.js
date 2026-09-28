(function () {
  'use strict';
  const { $, $$, esc, api } = IK;
  const loaders = {};

  function showTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    history.replaceState(null, '', `#${name}`);
    if (loaders[name]) loaders[name]();
  }

  const err = (el, e) => { el.innerHTML = `<tr><td colspan="12" class="empty" style="color:var(--bad)">${esc(e.message)}</td></tr>`; };

  loaders.today = async function () {
    try {
      const s = await api('GET', '/api/admin/stats');
      const tiles = [
        ['Orders picked', s.ordersPicked, 'good'],
        ['Orders pending', s.ordersPending == null ? '—' : s.ordersPending, ''],
        ['Items scanned', s.itemsScanned, ''],
        ['Wrong scans prevented', s.wrongScansPrevented, s.wrongScansPrevented ? 'bad' : ''],
        ['Picking accuracy', s.accuracy == null ? '—' : `${s.accuracy}%`, 'good'],
        ['Avg picking time', IK.fmtDuration(s.avgPickSeconds), ''],
      ];
      $('#tiles').innerHTML = tiles.map(([l, n, c]) => `<div class="tile ${c}"><div class="n">${esc(n)}</div><div class="l">${l}</div></div>`).join('')
        + (s.queueError ? `<div class="banner warn" style="grid-column:1/-1">Shopify: ${esc(s.queueError)}</div>` : '');
      $('#pickerRows').innerHTML = s.pickers.length ? s.pickers.map((p) => `<tr>
        <td><strong>${esc(p.name)}</strong></td><td>${p.ordersPicked}</td><td>${p.itemsPicked}</td>
        <td>${p.wrongScans ? `<span class="res WRONG_PRODUCT">${p.wrongScans}</span>` : 0}</td>
        <td>${p.extraScans ? `<span class="res EXTRA_ITEM">${p.extraScans}</span>` : 0}</td>
        <td>${p.accuracy == null ? '—' : `${p.accuracy}%`}</td><td>${IK.fmtDuration(p.avgPickSeconds)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="empty">No picking activity yet today</td></tr>';
    } catch (e) { $('#tiles').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  };

  loaders.active = async function () {
    try {
      const r = await api('GET', '/api/admin/sessions?status=active');
      $('#activeRows').innerHTML = r.sessions.length ? r.sessions.map((s) => `<tr>
        <td><strong>${esc(s.order_name)}</strong>${s.flag ? `<br><span class="res ORDER_CHANGED">${esc(s.flag)}</span> <span class="muted">${esc(s.flag_detail || '')}</span>` : ''}</td>
        <td>${esc(s.picker_name)}</td>
        <td><span class="res ${s.status}">${s.status.toUpperCase()}</span>${s.stale ? ' <span class="res WRONG_PRODUCT">STUCK?</span>' : ''}</td>
        <td>${s.scanned_qty} / ${s.expected_qty}</td>
        <td>${IK.fmtTime(s.started_at)}</td><td>${IK.fmtAgo(s.updated_at)}</td>
        <td style="text-align:right;white-space:nowrap"><a class="btn small" href="/pick/${s.id}">View</a> <button class="btn small danger" data-release="${s.id}" data-name="${esc(s.order_name)}">Release</button></td></tr>`).join('')
        : '<tr><td colspan="7" class="empty">Nobody is picking right now</td></tr>';
      $$('[data-release]').forEach((b) => b.addEventListener('click', async () => {
        const reason = await IK.modal({
          title: `Release ${b.dataset.name}?`,
          html: '<p>The picker loses their scanned progress and the order returns to the queue. Make sure the items are put back.</p><div class="field"><label>Reason</label><input id="rr" value="Released by admin"></div>',
          actions: [{ label: 'Cancel', value: null }, { label: 'Release', cls: 'danger', value: (bg) => bg.querySelector('#rr').value || 'Released by admin' }],
        });
        if (!reason) return;
        try { await api('POST', `/api/sessions/${b.dataset.release}/release`, { reason }); loaders.active(); } catch (e) { alert(e.message); }
      }));
    } catch (e) { err($('#activeRows'), e); }
  };

  loaders.log = async function () {
    const params = new URLSearchParams({ limit: '300' });
    if ($('#logOrder').value.trim()) params.set('order', $('#logOrder').value.trim().replace(/^#/, ''));
    if ($('#logResult').value) params.set('result', $('#logResult').value);
    try {
      const r = await api('GET', `/api/admin/events?${params}`);
      $('#logRows').innerHTML = r.events.length ? r.events.map((e) => `<tr>
        <td style="white-space:nowrap">${IK.fmtTime(e.created_at)}</td><td>${esc(e.order_name || '')}</td><td>${esc(e.picker_name || '')}</td>
        <td><span class="res ${e.result}">${esc(e.result)}</span></td><td class="mono">${esc(e.barcode || '')}</td><td class="mono">${esc(e.sku || '')}</td>
        <td>${esc(e.product_title || '')}</td><td class="muted">${esc(e.detail || '')}</td></tr>`).join('')
        : '<tr><td colspan="8" class="empty">No scans found</td></tr>';
    } catch (e) { err($('#logRows'), e); }
  };

  loaders.history = async function () {
    const st = $('#histStatus').value;
    try {
      const r = await api('GET', `/api/admin/sessions?limit=200${st ? `&status=${st}` : ''}`);
      $('#histRows').innerHTML = r.sessions.length ? r.sessions.map((s) => `<tr>
        <td><strong>${esc(s.order_name)}</strong></td><td>${esc(s.picker_name)}</td><td><span class="res ${s.status}">${s.status.toUpperCase()}</span>${s.release_reason ? `<div class="muted" style="font-size:13px">${esc(s.release_reason)}</div>` : ''}</td>
        <td>${s.expected_qty}</td><td>${s.scanned_qty}</td><td>${s.wrong_scans || 0}</td><td>${s.extra_scans || 0}</td><td>${s.manual_verifications || 0}</td>
        <td style="white-space:nowrap">${IK.fmtTime(s.started_at)}</td><td style="white-space:nowrap">${IK.fmtTime(s.completed_at)}</td><td>${IK.fmtDuration(s.duration_seconds)}</td></tr>`).join('')
        : '<tr><td colspan="11" class="empty">No sessions yet</td></tr>';
    } catch (e) { err($('#histRows'), e); }
  };

  loaders.barcodes = async function () {
    try {
      const r = await api('GET', '/api/admin/barcodes');
      $('#bcInfo').textContent = `${r.total} variants cached${r.lastSync ? ` · last sync ${IK.fmtAgo(r.lastSync)}` : ''}`;
      $('#bcMissing').innerHTML = `<h3 style="margin:10px 0">PRODUCTS MISSING BARCODES (${r.missing.length})</h3>` + (r.missing.length
        ? `<div class="banner bad">These cannot be verified by scanning. Add a barcode in Shopify (Products → variant → Barcode), then sync.</div>
          <table class="grid compact"><tbody>${r.missing.map((v) => `<tr><td><img class="thumb" src="${esc(v.image_url || '')}" alt=""></td><td><strong>${esc(v.product_title)}</strong> ${esc(v.variant_title || '')}</td><td class="mono">${esc(v.sku || 'no SKU')}</td><td>${esc(v.product_status || '')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="banner ok">✓ Every product has a barcode</div>');
      $('#bcDup').innerHTML = `<h3 style="margin:18px 0 10px">DUPLICATE BARCODES (${r.duplicates.length})</h3>` + (r.duplicates.length
        ? `<div class="banner bad">The same barcode is on more than one product. Scans of these are rejected until fixed.</div>
          <table class="grid compact"><tbody>${r.duplicates.map((d) => `<tr><td class="mono"><strong>${esc(d.barcode)}</strong></td><td>${d.variants.map((v) => `${esc(v.product_title)} (${esc(v.sku || '')})`).join('<br>')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="banner ok">✓ No duplicate barcodes</div>');
    } catch (e) { $('#bcMissing').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  };

  loaders.staff = async function () {
    try {
      const r = await api('GET', '/api/admin/users');
      $('#userRows').innerHTML = r.users.map((u) => `<tr>
        <td><strong>${esc(u.displayName)}</strong></td><td class="mono">${esc(u.username)}</td>
        <td>${u.role === 'admin' ? 'Admin' : 'Picker'}</td>
        <td>${u.active ? '<span class="res CORRECT">ACTIVE</span>' : '<span class="res WRONG_PRODUCT">DISABLED</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn small" data-pw="${u.id}" data-name="${esc(u.displayName)}">Reset password</button>
          ${u.id === IK.me.id ? '' : `<button class="btn small ${u.active ? 'danger' : ''}" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>`}
        </td></tr>`).join('');
      $$('[data-pw]').forEach((b) => b.addEventListener('click', async () => {
        const pw = await IK.modal({
          title: `New password for ${b.dataset.name}`,
          html: '<div class="field"><label>New password (packers min 3, admins min 6)</label><input id="npw" type="password"></div>',
          actions: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', value: (bg) => bg.querySelector('#npw').value }],
        });
        if (!pw) return;
        try { await api('PATCH', `/api/admin/users/${b.dataset.pw}`, { password: pw }); alert('Password updated'); } catch (e) { alert(e.message); }
      }));
      $$('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        try { await api('PATCH', `/api/admin/users/${b.dataset.toggle}`, { active: b.dataset.active !== 'true' }); loaders.staff(); } catch (e) { alert(e.message); }
      }));
    } catch (e) { err($('#userRows'), e); }
  };

  async function init() {
    const me = await IK.loadMe();
    if (me.role !== 'admin') { location.href = '/'; return; }
    IK.renderTopbar('admin');
    $$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#reloadActive').addEventListener('click', () => loaders.active());
    $('#reloadLog').addEventListener('click', () => loaders.log());
    $('#logOrder').addEventListener('keydown', (e) => { if (e.key === 'Enter') loaders.log(); });
    $('#histStatus').addEventListener('change', () => loaders.history());
    $('#syncBtn').addEventListener('click', async () => {
      $('#syncBtn').disabled = true;
      $('#syncBtn').textContent = 'Syncing…';
      try { await api('POST', '/api/admin/sync-products', null, { timeoutMs: 120000 }); await loaders.barcodes(); } catch (e) { alert(e.message); }
      $('#syncBtn').disabled = false;
      $('#syncBtn').textContent = 'Sync products from Shopify';
    });
    $('#newUser').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#userErr').textContent = '';
      const f = e.target;
      try {
        await api('POST', '/api/admin/users', { displayName: f.displayName.value.trim(), username: f.username.value.trim(), password: f.password.value, role: f.role.value });
        f.reset();
        loaders.staff();
      } catch (x) { $('#userErr').textContent = x.message; }
    });
    showTab((location.hash || '#today').slice(1));
    setInterval(() => {
      const active = $('#tabs button.active').dataset.tab;
      if (active === 'today' || active === 'active') loaders[active]();
    }, 30000);
  }
  init();
})();
