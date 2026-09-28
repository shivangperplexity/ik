/* Shared helpers: API calls, sounds, scanner input, top bar. */
(function () {
  'use strict';

  const IK = (window.IK = window.IK || {});

  IK.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  IK.$ = (sel, root) => (root || document).querySelector(sel);
  IK.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  IK.fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  IK.fmtAgo = (iso) => {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  IK.fmtDuration = (sec) => {
    if (sec == null) return '—';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };
  IK.uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.message) || `Request failed (${status})`);
      this.status = status;
      this.code = body && body.error;
      this.body = body || {};
    }
  }
  IK.ApiError = ApiError;

  IK.api = async function api(method, url, body, { timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      IK.setOnline(false);
      const err = new ApiError(0, { error: 'NETWORK', message: 'No connection to the server' });
      err.network = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    IK.setOnline(true);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (res.status === 401 && !url.includes('/api/login')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new ApiError(401, json);
    }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  };

  IK.setOnline = function (online) {
    const el = document.getElementById('conn');
    if (!el) return;
    el.textContent = online ? 'Online' : 'OFFLINE';
    el.classList.toggle('offline', !online);
  };
  window.addEventListener('offline', () => IK.setOnline(false));
  window.addEventListener('online', () => IK.setOnline(true));

  // ---------- sounds (generated locally with Web Audio, no files/APIs) ----------
  let ctx = null;
  IK.muted = false;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, start, dur, type = 'sine', gain = 0.25) {
    const a = audio();
    if (!a) return;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t0 = a.currentTime + start;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
  IK.sound = {
    ok() { if (!IK.muted) tone(1318, 0, 0.12, 'sine', 0.3); },
    error() {
      if (IK.muted) return;
      tone(196, 0, 0.22, 'square', 0.22);
      tone(147, 0.26, 0.34, 'square', 0.22);
    },
    warn() { if (!IK.muted) { tone(440, 0, 0.14, 'triangle', 0.3); tone(440, 0.2, 0.14, 'triangle', 0.3); } },
    complete() {
      if (IK.muted) return;
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.18, 'sine', 0.28));
    },
  };
  // Browsers only allow audio after a user gesture; unlock on first key/click.
  const unlock = () => { audio(); window.removeEventListener('keydown', unlock); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);

  // ---------- device helpers ----------
  IK.isTouch = () => window.matchMedia('(pointer: coarse)').matches;
  IK.pref = (key, value) => {
    try {
      if (value === undefined) return localStorage.getItem(`ik:${key}`);
      localStorage.setItem(`ik:${key}`, value);
    } catch (e) { /* private mode: ignore */ }
    return value;
  };
  IK.hwScanner = () => IK.pref('hwScanner') === '1';

  // ---------- scanner input ----------
  /**
   * Keeps an (invisible) input focused so a HID barcode scanner — which types
   * the code and presses Enter — works without clicking. Focus returns
   * automatically unless the user is typing in another form field or a modal
   * is open.
   */
  IK.createScanner = function ({ zone, onScan, doubleScanMs = 300 }) {
    const input = document.createElement('input');
    input.className = 'scan-input';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'Barcode scanner input');
    // Phones: keep the on-screen keyboard away; the camera is used instead.
    input.setAttribute('inputmode', 'none');
    document.body.appendChild(input);
    let last = { code: null, at: 0 };
    let paused = false;

    const otherFieldFocused = () => {
      const a = document.activeElement;
      return a && a !== input && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    };
    const modalOpen = () => Boolean(document.querySelector('.modal-bg'));

    function focus() {
      if (paused || otherFieldFocused() || modalOpen()) return;
      // On touch phones only grab focus if a hardware scanner is paired.
      if (IK.isTouch() && !IK.hwScanner()) return;
      if (document.activeElement !== input) input.focus({ preventScroll: true });
    }
    function updateZone() {
      if (zone) zone.classList.toggle('focused', document.activeElement === input);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const code = input.value.trim();
        input.value = '';
        if (!code) return;
        const now = Date.now();
        if (code === last.code && now - last.at < doubleScanMs) return; // scanner double-send
        last = { code, at: now };
        onScan(code);
      }
    });
    input.addEventListener('focus', updateZone);
    input.addEventListener('blur', () => { updateZone(); setTimeout(focus, 80); });
    document.addEventListener('click', (e) => {
      if (e.target.closest('input,select,textarea,button,a,.modal-bg')) return;
      setTimeout(focus, 0);
    });
    if (zone) zone.addEventListener('click', () => input.focus());
    setInterval(focus, 1000);
    setTimeout(focus, 50);

    return {
      focus,
      pause() { paused = true; input.blur(); },
      resume() { paused = false; focus(); },
      input,
    };
  };

  // ---------- top bar ----------
  IK.me = null;
  IK.loadMe = async function () {
    const r = await IK.api('GET', '/api/me');
    IK.me = r.user;
    IK.muted = Boolean(r.user.soundMuted);
    return r.user;
  };

  IK.renderTopbar = function (active) {
    const u = IK.me;
    const bar = document.getElementById('topbar');
    if (!bar || !u) return;
    bar.innerHTML = `
      <div class="brand">Ink Kulture <span>Pick &amp; Pack</span></div>
      <a href="/" ${active === 'queue' ? 'style="opacity:1;background:rgba(255,255,255,.12)"' : ''}>Queue</a>
      ${u.role === 'admin' ? `<a href="/admin" ${active === 'admin' ? 'style="opacity:1;background:rgba(255,255,255,.12)"' : ''}>Admin</a>` : ''}
      <div class="spacer"></div>
      <span id="conn" class="conn">Online</span>
      <button class="link" id="muteBtn" title="Mute / unmute sounds">${IK.muted ? '🔇<span class="lbl"> Sound off</span>' : '🔊<span class="lbl"> Sound on</span>'}</button>
      <span class="who">${IK.esc(u.displayName)} · ${u.role === 'admin' ? 'Admin' : 'Picker'}</span>
      <button class="link" id="logoutBtn">Log out</button>`;
    IK.$('#muteBtn').addEventListener('click', async () => {
      IK.muted = !IK.muted;
      IK.$('#muteBtn').innerHTML = IK.muted ? '🔇<span class="lbl"> Sound off</span>' : '🔊<span class="lbl"> Sound on</span>';
      if (!IK.muted) IK.sound.ok();
      try { await IK.api('PUT', '/api/me/preferences', { soundMuted: IK.muted }); } catch (e) { /* keep local */ }
    });
    IK.$('#logoutBtn').addEventListener('click', async () => {
      try { await IK.api('POST', '/api/logout'); } finally { location.href = '/login'; }
    });
  };

  // ---------- simple modal ----------
  IK.modal = function ({ title, html, actions = [], onOpen }) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${IK.esc(title)}</h2><div class="modal-body">${html || ''}</div><div class="actions"></div></div>`;
      const act = bg.querySelector('.actions');
      const close = (v) => { bg.remove(); resolve(v); };
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.className = `btn ${a.cls || ''}`;
        b.textContent = a.label;
        b.addEventListener('click', () => close(a.value === undefined ? a.label : (typeof a.value === 'function' ? a.value(bg) : a.value)));
        act.appendChild(b);
      });
      bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
      document.body.appendChild(bg);
      const first = bg.querySelector('input,select,textarea,button');
      if (first) first.focus();
      if (onOpen) onOpen(bg, close);
    });
  };
})();
