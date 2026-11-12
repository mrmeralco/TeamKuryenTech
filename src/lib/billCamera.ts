/**
 * Bill camera + crop editor (ported from jrmph/MERALCO-SCANNER: CameraCapture, CropEditor,
 * liveQuality, autocrop). Plain DOM, no framework, everything stays on the device.
 *
 *  openBillCamera(): full-screen live camera with a quality guide (light, glare, size,
 *    focus, steadiness, text), torch, zoom and camera picker. Every shot opens the crop
 *    editor. Resolves with the captured files (up to `room`), or [] when closed.
 *  openCropEditor(): drag the corners/box, auto-detect the bill, rotate, or keep the
 *    whole photo. Resolves with the cropped File, the original (no crop), or null (cancel).
 */

// ------------------------------------------------------------------ live quality
const THRESH = { darkBelow: 80, brightAbove: 228, glareFrac: 0.05, minCoverage: 0.45, minSharp: 45, maxMotion: 5, minEdges: 0.02 };
const CHECK_LABELS: Record<string, string> = { light: "Light", glare: "Glare", size: "Size", sharp: "Focus", steady: "Steady", text: "Text" };
const MESSAGES: Record<string, string> = {
  dark: "Too dark — add light or turn on the flash",
  bright: "Too bright — avoid direct light",
  glare: "Glare on the bill — tilt the phone a little",
  size: "Move a little closer to the bill",
  steady: "Hold steady…",
  sharp: "A bit blurry — wait for focus or move slightly",
  text: "No text yet — point at the bill",
  ready: "Looks good! Hold still and take the photo",
};

interface LiveResult { checks: Record<string, boolean>; message: string; ready: boolean; tone: "good" | "warn" | "bad"; dark: boolean }

function otsu(hist: Uint32Array, n: number): number {
  let tot = 0;
  for (let i = 0; i < 256; i++) tot += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (tot - sumB) / wF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function createAnalyzer() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let prev: Float32Array | null = null;
  function analyze(video: HTMLVideoElement): LiveResult | null {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = 480, h = Math.max(8, Math.round((vh / vw) * w));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const n = w * h;
    const g = new Float32Array(n);
    const hist = new Uint32Array(256);
    let sum = 0, glare = 0;
    for (let i = 0; i < n; i++) {
      const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      g[i] = v; sum += v; hist[v | 0]++;
      if (v >= 250) glare++;
    }
    const mean = sum / n;
    const thr = otsu(hist, n);
    const rows = new Uint16Array(h), cols = new Uint16Array(w);
    let bright = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] > thr) { rows[y]++; cols[x]++; bright++; }
    let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
    for (let y = 0; y < h; y++) if (rows[y] > w * 0.25) { if (y0 < 0) y0 = y; y1 = y; }
    for (let x = 0; x < w; x++) if (cols[x] > h * 0.25) { if (x0 < 0) x0 = x; x1 = x; }
    const found = y0 >= 0 && x0 >= 0 && bright / n > 0.08;
    const coverage = found ? ((y1 - y0 + 1) * (x1 - x0 + 1)) / n : 0;
    const ax = found ? Math.max(1, x0) : Math.round(w * 0.15), bx = found ? Math.min(w - 2, x1) : Math.round(w * 0.85);
    const ay = found ? Math.max(1, y0) : Math.round(h * 0.15), by = found ? Math.min(h - 2, y1) : Math.round(h * 0.85);
    let s = 0, sq = 0, cnt = 0, edges = 0;
    for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) {
      const i = y * w + x;
      const lap = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      s += lap; sq += lap * lap; cnt++;
      if (Math.abs(g[i + 1] - g[i]) + Math.abs(g[i + w] - g[i]) > 50) edges++;
    }
    const sharp = cnt ? sq / cnt - (s / cnt) ** 2 : 0;
    let motion: number | null = null;
    if (prev && prev.length === n) {
      let d = 0, m = 0;
      for (let i = 0; i < n; i += 5) { d += Math.abs(g[i] - prev[i]); m++; }
      motion = d / m;
    }
    prev = g;
    const checks: Record<string, boolean> = {
      light: mean >= THRESH.darkBelow && mean <= THRESH.brightAbove,
      glare: glare / n <= THRESH.glareFrac,
      size: coverage >= THRESH.minCoverage,
      sharp: sharp >= THRESH.minSharp,
      steady: motion != null && motion <= THRESH.maxMotion,
      text: (cnt ? edges / cnt : 0) >= THRESH.minEdges,
    };
    const order = ["light", "glare", "size", "steady", "sharp", "text"];
    const first = order.find((k) => !checks[k]);
    const failed = order.filter((k) => !checks[k]).length;
    return {
      checks,
      message: !first ? MESSAGES.ready : first === "light" ? (mean < THRESH.darkBelow ? MESSAGES.dark : MESSAGES.bright) : MESSAGES[first],
      ready: failed === 0,
      tone: failed === 0 ? "good" : failed <= 2 ? "warn" : "bad",
      dark: mean < THRESH.darkBelow,
    };
  }
  return { analyze, reset: () => { prev = null; } };
}

// ------------------------------------------------------------------ auto-crop
type Box = { x: number; y: number; w: number; h: number };
const FALLBACK: Box = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };

/** Find the bright paper (the bill) in a photo; returns a box as fractions of width/height. */
export function detectBounds(img: HTMLImageElement): Box {
  try {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    if (!W || !H) return FALLBACK;
    const w = 400, h = Math.max(8, Math.round((H / W) * w));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const n = w * h;
    const g = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0; g[i] = v; hist[v]++; }
    const thr = otsu(hist, n);
    const rows = new Uint16Array(h), cols = new Uint16Array(w);
    let bright = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] > thr) { rows[y]++; cols[x]++; bright++; }
    if (bright / n < 0.1) return FALLBACK;
    let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
    for (let y = 0; y < h; y++) if (rows[y] > w * 0.25) { if (y0 < 0) y0 = y; y1 = y; }
    for (let x = 0; x < w; x++) if (cols[x] > h * 0.25) { if (x0 < 0) x0 = x; x1 = x; }
    if (y0 < 0 || x0 < 0) return FALLBACK;
    const pad = 0.01;
    const bx = Math.max(0, x0 / w - pad), by = Math.max(0, y0 / h - pad);
    const box = { x: bx, y: by, w: Math.min(1 - bx, (x1 + 1) / w + pad - bx), h: Math.min(1 - by, (y1 + 1) / h + pad - by) };
    return box.w < 0.25 || box.h < 0.25 ? FALLBACK : box;
  } catch {
    return FALLBACK;
  }
}

// ------------------------------------------------------------------ helpers
const h = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const toBlob = (c: HTMLCanvasElement, q: number) => new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", q));

function lockScroll(): () => void {
  const prev = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => { document.body.style.overflow = prev; };
}

// ------------------------------------------------------------------ crop editor
export function openCropEditor(file: File, opts: { title?: string; allowSkip?: boolean } = {}): Promise<File | null> {
  return new Promise((resolve) => {
    let url = URL.createObjectURL(file);
    const urls = [url];
    let box: Box = { ...FALLBACK };
    const unlock = lockScroll();
    const el = h(`<div class="bc-crop" role="dialog" aria-modal="true" aria-label="${esc(opts.title ?? "Crop the bill")}">
      <div class="bc-top">
        <button type="button" class="bc-btn" data-x="cancel" aria-label="Cancel">✕</button>
        <div class="bc-title"><strong>${esc(opts.title ?? "Crop the bill")}</strong><small>Drag the corners to keep only the bill</small></div>
        <span class="bc-btn ghost"></span>
      </div>
      <div class="bc-crop-stage">
        <div class="bc-crop-wrap">
          <img alt="Bill to crop" draggable="false">
          <div class="bc-crop-box"><span class="bc-crop-grid"></span>
            <i class="bc-h tl" data-h="tl"></i><i class="bc-h tr" data-h="tr"></i><i class="bc-h bl" data-h="bl"></i><i class="bc-h br" data-h="br"></i>
          </div>
        </div>
      </div>
      <div class="bc-crop-bottom">
        <div class="bc-tools">
          <button type="button" class="bc-chip" data-x="auto">✨ Auto</button>
          <button type="button" class="bc-chip" data-x="rotate">⟳ Rotate</button>
          <button type="button" class="bc-chip" data-x="full">↺ Whole photo</button>
        </div>
        <div class="bc-actions">
          ${opts.allowSkip === false ? "<span></span>" : `<button type="button" class="bc-text" data-x="skip">No crop</button>`}
          <button type="button" class="bc-primary" data-x="apply">Use crop ✓</button>
        </div>
      </div>
    </div>`);
    document.body.appendChild(el);
    const img = el.querySelector("img")!;
    const wrap = el.querySelector<HTMLElement>(".bc-crop-wrap")!;
    const boxEl = el.querySelector<HTMLElement>(".bc-crop-box")!;
    const draw = () => Object.assign(boxEl.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
    img.onload = () => { box = detectBounds(img); draw(); };
    img.src = url;
    draw();

    let drag: { type: string; x: number; y: number; box: Box } | null = null;
    const start = (type: string, e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      drag = { type, x: e.clientX, y: e.clientY, box: { ...box } };
    };
    boxEl.addEventListener("pointerdown", (e) => start("move", e));
    el.querySelectorAll<HTMLElement>("[data-h]").forEach((handle) => handle.addEventListener("pointerdown", (e) => start(handle.dataset.h!, e)));
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const r = wrap.getBoundingClientRect();
      const dx = (e.clientX - drag.x) / r.width, dy = (e.clientY - drag.y) / r.height;
      let { x, y, w, h: hh } = drag.box;
      if (drag.type === "move") { x = clamp(x + dx, 0, 1 - w); y = clamp(y + dy, 0, 1 - hh); }
      else {
        let x0 = x, y0 = y, x1 = x + w, y1 = y + hh;
        if (drag.type.includes("l")) x0 = clamp(x0 + dx, 0, x1 - 0.1);
        if (drag.type.includes("r")) x1 = clamp(x1 + dx, x0 + 0.1, 1);
        if (drag.type.includes("t")) y0 = clamp(y0 + dy, 0, y1 - 0.1);
        if (drag.type.includes("b")) y1 = clamp(y1 + dy, y0 + 0.1, 1);
        x = x0; y = y0; w = x1 - x0; hh = y1 - y0;
      }
      box = { x, y, w, h: hh };
      draw();
    };
    const end = () => { drag = null; };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);

    const close = (result: File | null) => {
      document.removeEventListener("keydown", onKey);
      unlock();
      el.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);

    el.addEventListener("click", async (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("[data-x]")?.dataset.x;
      if (!action) return;
      if (action === "cancel") return close(null);
      if (action === "skip") return close(file);
      if (action === "auto") { box = detectBounds(img); draw(); }
      if (action === "full") { box = { x: 0, y: 0, w: 1, h: 1 }; draw(); }
      if (action === "rotate") {
        const c = document.createElement("canvas");
        c.width = img.naturalHeight; c.height = img.naturalWidth;
        const ctx = c.getContext("2d")!;
        ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0);
        const blob = await toBlob(c, 0.95);
        if (blob) { url = URL.createObjectURL(blob); urls.push(url); img.src = url; }
      }
      if (action === "apply") {
        const btn = e.target as HTMLButtonElement;
        btn.disabled = true; btn.textContent = "One moment…";
        const sx = Math.round(box.x * img.naturalWidth), sy = Math.round(box.y * img.naturalHeight);
        const sw = Math.max(1, Math.round(box.w * img.naturalWidth)), sh = Math.max(1, Math.round(box.h * img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = sw; c.height = sh;
        c.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await toBlob(c, 0.93);
        close(blob ? new File([blob], file.name.replace(/\.\w+$/, "") + "-crop.jpg", { type: "image/jpeg" }) : file);
      }
    });
  });
}

// ------------------------------------------------------------------ live camera
export function openBillCamera(opts: {
  title: string; hint?: string; room: number; nextLabel?: string; onSkip?: () => void;
  /** "lens": Google Lens-style look for small labels (only light/glare/focus/steady checks). */
  variant?: "bill" | "lens";
}): Promise<File[]> {
  return new Promise((resolve) => {
    const room = Math.max(1, opts.room);
    const tray: { file: File; url: string }[] = [];
    let stream: MediaStream | null = null;
    let deviceId: string | null = null;
    let timer: number | undefined;
    let torch = false;
    let busy = false;
    let closed = false;
    const analyzer = createAnalyzer();
    const unlock = lockScroll();

    const lens = opts.variant === "lens";
    // Labels are small and often metallic, so paper-size/text-density checks don't apply.
    const activeChecks = lens ? ["light", "glare", "steady", "sharp"] : ["light", "glare", "size", "steady", "sharp", "text"];
    const el = h(`<div class="bc-cam${lens ? " bc-lens" : ""}" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="bc-top">
        <button type="button" class="bc-btn" data-x="close" aria-label="Close">✕</button>
        <div class="bc-title"><strong data-title></strong>${opts.hint ? `<small>${esc(opts.hint)}</small>` : ""}</div>
        <select class="bc-select" data-select aria-label="Choose camera" hidden></select>
        <button type="button" class="bc-btn" data-x="torch" aria-label="Flash" hidden>🔦</button>
      </div>
      <div class="bc-stage">
        <video playsinline muted></video>
        <div class="bc-guide" data-guide hidden><i></i><i></i><i></i><i></i><span class="bc-line"></span></div>
        <div class="bc-hud" data-hud hidden><div class="bc-status" data-status role="status" aria-live="polite"></div><ul class="bc-checks" data-checks></ul></div>
        <div class="bc-zoom" data-zoom hidden>
          <button type="button" data-x="zoom-out" aria-label="Zoom out">−</button>
          <input type="range" data-zoom-range aria-label="Zoom">
          <button type="button" data-x="zoom-in" aria-label="Zoom in">＋</button>
        </div>
        <div class="bc-msg" data-msg>Opening the camera…</div>
      </div>
      <div class="bc-bottom">
        <div class="bc-tray" data-tray aria-label="Photos taken"></div>
        <button type="button" class="bc-shutter" data-x="snap" aria-label="Take photo" disabled><i></i></button>
        <div class="bc-next">
          <button type="button" class="bc-primary" data-x="done" disabled>${esc(opts.nextLabel ?? "Done ✓")}</button>
          ${opts.onSkip ? `<button type="button" class="bc-text" data-x="skip">Skip</button>` : ""}
        </div>
      </div>
    </div>`);
    document.body.appendChild(el);
    const video = el.querySelector("video")!;
    const $ = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    const shutter = $<HTMLButtonElement>('[data-x="snap"]');
    const doneBtn = $<HTMLButtonElement>('[data-x="done"]');

    const left = () => room - tray.length;
    const renderTray = () => {
      $("[data-title]").textContent = `${opts.title} · Photo ${Math.min(tray.length + 1, room)}/${room}`;
      $("[data-tray]").innerHTML = Array.from({ length: room }, (_, i) => tray[i]
        ? `<div class="bc-tray-i"><img src="${tray[i].url}" alt="Photo ${i + 1}"><button type="button" data-x="untray" data-i="${i}" aria-label="Remove photo ${i + 1}">✕</button></div>`
        : `<div class="bc-tray-i empty">${i + 1}</div>`).join("");
      doneBtn.disabled = !tray.length;
      shutter.disabled = busy || !stream || left() <= 0;
    };

    const stop = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; window.clearInterval(timer); };
    const close = (files: File[]) => {
      if (closed) return;
      closed = true;
      stop();
      document.removeEventListener("keydown", onKey);
      unlock();
      el.remove();
      tray.forEach((t) => URL.revokeObjectURL(t.url));
      resolve(files);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".bc-crop")) close([]); };
    document.addEventListener("keydown", onKey);

    const showFallback = (denied: boolean) => {
      const msg = $("[data-msg]");
      msg.hidden = false;
      msg.innerHTML = `<p>${denied
        ? "Camera access was blocked. Allow it in your browser settings, or use your phone’s camera app:"
        : "The live camera isn’t available here (phones need https). You can still use your phone’s camera app:"}</p>
        <label class="bc-primary">📷 Open phone camera<input type="file" accept="image/*" capture="environment" hidden data-native></label>`;
      msg.querySelector<HTMLInputElement>("[data-native]")!.addEventListener("change", async (e) => {
        const input = e.target as HTMLInputElement;
        const f = input.files?.[0];
        input.value = "";
        if (f) await addShot(f);
      });
    };

    async function addShot(file: File) {
      busy = true; renderTray();
      window.clearInterval(timer);
      el.hidden = true;
      const cropped = await openCropEditor(file, { title: `Photo ${tray.length + 1} of ${room}` });
      el.hidden = false;
      busy = false;
      if (cropped) {
        tray.push({ file: cropped, url: URL.createObjectURL(cropped) });
        if (tray.length >= room) return close(tray.map((t) => t.file));
      }
      renderTray();
      startAnalysis();
    }

    function startAnalysis() {
      window.clearInterval(timer);
      if (!stream) return;
      timer = window.setInterval(() => {
        const r = analyzer.analyze(video);
        if (!r) return;
        const failing = activeChecks.filter((k) => !r.checks[k]);
        const tone = failing.length === 0 ? "good" : failing.length <= 2 ? "warn" : "bad";
        const message = !failing.length
          ? (lens ? "Looks good! Tap to scan the label" : MESSAGES.ready)
          : failing[0] === "light" ? (r.dark ? MESSAGES.dark : MESSAGES.bright) : MESSAGES[failing[0]];
        $("[data-hud]").hidden = false;
        const guide = $("[data-guide]");
        guide.hidden = false;
        guide.className = `bc-guide ${tone}`;
        const status = $("[data-status]");
        status.className = `bc-status ${tone}`;
        status.textContent = message;
        $("[data-checks]").innerHTML = failing.map((k) => `<li>✗ ${CHECK_LABELS[k]}</li>`).join("");
        shutter.classList.toggle("ready", !failing.length);
      }, 300);
    }

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) return showFallback(false);
      stop();
      analyzer.reset();
      $("[data-msg]").hidden = false;
      $("[data-msg]").textContent = "Opening the camera…";
      try {
        const v: MediaTrackConstraints = { width: { ideal: 2560 }, height: { ideal: 1920 } };
        if (deviceId) v.deviceId = { exact: deviceId }; else v.facingMode = { ideal: "environment" };
        stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
        if (closed) return stop();
        const track = stream.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step?: number } };
        $("[data-x=torch]").hidden = !caps.torch;
        const zoomBox = $("[data-zoom]");
        const range = $<HTMLInputElement>("[data-zoom-range]");
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          zoomBox.hidden = false;
          Object.assign(range, { min: String(caps.zoom.min), max: String(caps.zoom.max), step: String(caps.zoom.step || 0.1) });
          range.value = String((track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom ?? caps.zoom.min);
        } else zoomBox.hidden = true;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        $("[data-msg]").hidden = true;
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        const select = $<HTMLSelectElement>("[data-select]");
        select.hidden = cams.length < 2;
        const current = deviceId || track.getSettings().deviceId || "";
        select.innerHTML = cams.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === current ? " selected" : ""}>${esc(d.label || `Camera ${i + 1}`)}</option>`).join("");
        renderTray();
        startAnalysis();
      } catch (e) {
        if (deviceId) { deviceId = null; return startCamera(); }
        showFallback((e as { name?: string })?.name === "NotAllowedError");
      }
    }

    const applyZoom = async (value: number) => {
      const range = $<HTMLInputElement>("[data-zoom-range]");
      const z = clamp(value, Number(range.min), Number(range.max));
      range.value = String(z);
      try { await stream?.getVideoTracks()[0]?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }); } catch { /* not supported */ }
    };
    $<HTMLInputElement>("[data-zoom-range]").addEventListener("input", (e) => applyZoom(Number((e.target as HTMLInputElement).value)));
    $<HTMLSelectElement>("[data-select]").addEventListener("change", (e) => { deviceId = (e.target as HTMLSelectElement).value; startCamera(); });

    el.addEventListener("click", async (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-x]");
      if (!target) return;
      const action = target.dataset.x;
      if (action === "close") close([]);
      if (action === "skip") { close([]); opts.onSkip?.(); }
      if (action === "done" && tray.length) close(tray.map((t) => t.file));
      if (action === "untray") { const [t] = tray.splice(Number(target.dataset.i), 1); if (t) URL.revokeObjectURL(t.url); renderTray(); }
      if (action === "torch") {
        try { await stream?.getVideoTracks()[0]?.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); torch = !torch; target.classList.toggle("on", torch); } catch { /* no flash */ }
      }
      if (action === "zoom-in" || action === "zoom-out") {
        const range = $<HTMLInputElement>("[data-zoom-range]");
        const span = (Number(range.max) - Number(range.min)) / 10;
        applyZoom(Number(range.value) + (action === "zoom-in" ? span : -span));
      }
      if (action === "snap") {
        if (!video.videoWidth || left() <= 0 || busy) return;
        const c = document.createElement("canvas");
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext("2d")!.drawImage(video, 0, 0);
        const blob = await toBlob(c, 0.92);
        if (!blob) return;
        navigator.vibrate?.(30);
        await addShot(new File([blob], `bill-${Date.now()}.jpg`, { type: "image/jpeg" }));
      }
    });

    renderTray();
    startCamera();
  });
}
