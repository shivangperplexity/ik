/* Phone-camera barcode scanning.
 *
 * Accuracy rule: ONE TAP = ONE SCAN. The camera keeps running, but a barcode
 * is only read after the picker taps "Scan". A phone camera sees the same
 * label many times a second, so continuous reading could count one packet
 * twice — tap-to-scan makes that impossible.
 *
 * The camera is opened from a button tap ("START CAMERA"), which is what makes
 * iPhone Safari and Android Chrome show the "Allow camera?" prompt. The camera
 * stream is requested FIRST, before loading any decoder, so a decoder problem
 * can never stop the permission prompt from appearing.
 *
 * Decoding: the browser's built-in BarcodeDetector when it supports Code 128
 * (Android Chrome), otherwise the ZXing library (iPhone Safari). ZXing is
 * loaded from this site and, if that fails, from a public CDN.
 */
(function () {
  'use strict';
  const IK = (window.IK = window.IK || {});

  const FORMATS_NATIVE = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'qr_code'];
  const ZXING_URLS = [
    '/vendor/zxing.min.js',
    'https://unpkg.com/@zxing/library@0.23.0/umd/index.min.js',
    'https://cdn.jsdelivr.net/npm/@zxing/library@0.23.0/umd/index.min.js',
  ];

  IK.cameraSupported = () => Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  IK.isPhone = () => window.matchMedia('(pointer: coarse)').matches;
  const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inAppBrowser = () => /FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)|Snapchat|Twitter/i.test(navigator.userAgent);

  // ---------- ZXing loader ----------
  let zxingPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => (window.ZXing ? resolve() : reject(new Error('empty')));
      s.onerror = () => { s.remove(); reject(new Error(`could not load ${src}`)); };
      document.head.appendChild(s);
    });
  }
  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxingPromise) {
      zxingPromise = (async () => {
        for (const url of ZXING_URLS) {
          try { await loadScript(url); return window.ZXing; } catch (e) { /* try next */ }
        }
        zxingPromise = null;
        throw new Error('The barcode reader could not be downloaded. Check the internet connection and tap Try again.');
      })();
    }
    return zxingPromise;
  }

  // ---------- decoders: fn(video) -> Promise<string|null> ----------
  async function nativeDecoder() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      const use = FORMATS_NATIVE.filter((f) => formats.includes(f));
      if (!use.includes('code_128')) return null;
      const detector = new window.BarcodeDetector({ formats: use });
      return async (video) => {
        const found = await detector.detect(video);
        return found && found.length ? found[0].rawValue : null;
      };
    } catch (e) {
      return null;
    }
  }

  async function zxingDecoder() {
    const Z = await loadZxing();
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
      Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.QR_CODE,
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    const canvas = document.createElement('canvas');
    const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    return async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      // Scale down big frames: faster and still plenty for a label in the box.
      const scale = Math.min(1, 1280 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
        const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
        return reader.decode(bitmap).getText();
      } catch (e) {
        return null; // no barcode in this frame
      } finally {
        reader.reset();
      }
    };
  }

  function explainError(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return isIOS()
        ? 'Camera is blocked for this site.<br>iPhone: tap <b>aA</b> in the address bar → <b>Website Settings</b> → <b>Camera → Allow</b>. Or Settings → Safari → Camera → Allow. Then tap Try again.'
        : 'Camera is blocked for this site.<br>Android Chrome: tap the <b>🔒 / ⚙</b> icon left of the web address → <b>Permissions</b> → <b>Camera → Allow</b>. Then tap Try again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is being used by another app. Close other camera apps, then tap Try again.';
    return `Camera problem: ${(e && e.message) || e}`;
  }

  function unsupportedReason() {
    if (!window.isSecureContext) return 'The camera only works on the https:// address of this site.';
    if (inAppBrowser()) return 'This link opened inside another app (WhatsApp / Instagram). Open it in <b>Chrome</b> or <b>Safari</b> to use the camera: tap ⋮ or ⋯ → <b>Open in browser</b>.';
    return 'This browser cannot use the camera. Open the site in Chrome (Android) or Safari (iPhone).';
  }

  /**
   * mount: element to render the camera panel into
   * onCode(code): called once per armed scan
   * autoArm: arm immediately after the camera starts (one-shot scanners)
   * autoStart: start without a tap if the camera was already allowed before
   */
  IK.createCamera = function ({ mount, onCode, label = 'TAP TO SCAN', autoArm = false, autoStart = true }) {
    mount.innerHTML = `
      <div class="cam">
        <video class="cam__video" playsinline muted autoplay></video>
        <div class="cam__frame hidden"><span></span></div>
        <div class="cam__msg"></div>
        <button class="cam__torch hidden" type="button" aria-label="Torch">🔦</button>
        <div class="cam__start">
          <button class="cam__startbtn" type="button">📷 START CAMERA</button>
          <div class="cam__help">Tap, then choose <b>Allow</b> when the phone asks for the camera.</div>
        </div>
        <button class="cam__btn hidden" type="button">${label}</button>
      </div>`;
    const root = mount.querySelector('.cam');
    const video = root.querySelector('video');
    const frame = root.querySelector('.cam__frame');
    const msg = root.querySelector('.cam__msg');
    const btn = root.querySelector('.cam__btn');
    const torchBtn = root.querySelector('.cam__torch');
    const startBox = root.querySelector('.cam__start');
    const startBtn = root.querySelector('.cam__startbtn');
    const help = root.querySelector('.cam__help');
    let armed = false;
    let running = false;
    let starting = false;
    let destroyed = false;
    let stream = null;
    let decode = null;
    let timer = null;
    let torchOn = false;
    let armedAt = 0;
    let busy = false;

    function setArmed(v) {
      if (v && !running) return;
      armed = v;
      armedAt = Date.now();
      root.classList.toggle('armed', v);
      btn.textContent = v ? 'SCANNING… hold barcode in the box' : label;
      if (v) msg.textContent = '';
    }

    function deliver(code) {
      if (!armed || !code) return;
      setArmed(false);
      if (navigator.vibrate) navigator.vibrate(60);
      onCode(String(code).trim());
    }

    function showStart(html, buttonText) {
      running = false;
      startBox.classList.remove('hidden');
      frame.classList.add('hidden');
      btn.classList.add('hidden');
      torchBtn.classList.add('hidden');
      startBtn.textContent = buttonText || '📷 START CAMERA';
      startBtn.disabled = false;
      help.innerHTML = html || 'Tap, then choose <b>Allow</b> when the phone asks for the camera.';
    }

    function showRunning() {
      startBox.classList.add('hidden');
      frame.classList.remove('hidden');
      btn.classList.remove('hidden');
      msg.textContent = autoArm ? '' : 'Tap the button below for each packet';
    }

    const armTimeout = setInterval(() => {
      if (armed && Date.now() - armedAt > 12000) {
        setArmed(false);
        msg.textContent = 'No barcode found — tap to try again';
      }
    }, 1000);

    btn.addEventListener('click', () => setArmed(!armed));
    frame.addEventListener('click', () => setArmed(true));
    video.addEventListener('click', () => setArmed(true));
    startBtn.addEventListener('click', () => start());

    torchBtn.addEventListener('click', async () => {
      const track = stream && stream.getVideoTracks()[0];
      if (!track) return;
      torchOn = !torchOn;
      try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
      torchBtn.classList.toggle('on', torchOn);
    });

    function showTorchIfSupported() {
      const track = stream && stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) torchBtn.classList.remove('hidden');
    }

    function loop() {
      if (!running) return;
      const next = () => { timer = setTimeout(loop, 120); };
      if (!armed || busy || video.readyState < 2 || !decode) { next(); return; }
      busy = true;
      decode(video)
        .then((code) => { if (code) deliver(code); })
        .catch(() => {})
        .finally(() => { busy = false; next(); });
    }

    function getStream() {
      // Called directly from the tap handler (no await before it) so the
      // browser treats it as a user gesture and shows the permission prompt.
      const want = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } };
      return navigator.mediaDevices.getUserMedia(want).catch((e) => {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
          return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        }
        throw e;
      });
    }

    async function start() {
      if (running || starting || destroyed) return;
      if (!IK.cameraSupported()) { showStart(unsupportedReason(), '📷 START CAMERA'); startBtn.disabled = true; return; }
      starting = true;
      startBtn.disabled = true;
      startBtn.textContent = 'Opening camera…';
      help.innerHTML = 'If the phone asks, tap <b>Allow</b>.';
      try {
        stream = await getStream();
      } catch (e) {
        starting = false;
        IK.pref('camOk', '0');
        showStart(explainError(e), '↻ TRY AGAIN');
        return;
      }
      if (destroyed) { stream.getTracks().forEach((t) => t.stop()); return; }
      IK.pref('camOk', '1');
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay attr covers it */ }
      running = true;
      starting = false;
      showRunning();
      showTorchIfSupported();
      try {
        decode = (await nativeDecoder()) || (await zxingDecoder());
      } catch (e) {
        stopStream();
        showStart(IK.esc(e.message), '↻ TRY AGAIN');
        return;
      }
      if (autoArm) setArmed(true);
      loop();
    }

    function stopStream() {
      running = false;
      clearTimeout(timer);
      setArmed(false);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    }

    function stop() {
      destroyed = true;
      clearInterval(armTimeout);
      stopStream();
      document.removeEventListener('visibilitychange', onVisibility);
    }

    // Release the camera when the page is hidden (saves battery, frees camera).
    let wasRunning = false;
    function onVisibility() {
      if (document.hidden) {
        wasRunning = running;
        if (running) { stopStream(); showStart('Camera paused. Tap to continue.', '📷 START CAMERA'); }
      } else if (wasRunning && mount.isConnected && !destroyed) {
        start();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    if (!IK.cameraSupported()) {
      showStart(unsupportedReason());
      startBtn.disabled = true;
    } else if (autoStart && IK.pref('camOk') === '1') {
      // Allowed before on this phone: open straight away. If the browser
      // wants a tap anyway, the START CAMERA button is shown again.
      start();
    }

    return {
      start,
      arm: () => setArmed(true),
      disarm: () => setArmed(false),
      setLabel: (t) => { label = t; if (!armed) btn.textContent = t; },
      stop,
      isRunning: () => running,
      root,
    };
  };
})();
