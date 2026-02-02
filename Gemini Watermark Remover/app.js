/**
 * Gemini Watermark Remover (client-side)
 *
 * Beginner-friendly notes:
 * - We NEVER upload your image anywhere. Everything happens in your browser.
 * - We draw images onto a <canvas>, edit pixels, then show the result.
 * - The math is "Reverse Alpha Blending" (from the reference GitHub repo):
 *
 *   watermarked = α * logo + (1 - α) * original
 *   original   = (watermarked - α * logo) / (1 - α)
 *
 * Gemini's visible watermark is basically a semi-transparent white logo.
 */

// ---------------------------
// DOM (page elements)
// ---------------------------
const uploadArea = document.getElementById("uploadArea");
const fileInput = document.getElementById("fileInput");
const fileNameEl = document.getElementById("fileName");
const statusEl = document.getElementById("status");

// Feature 1 (Batch UI)
const batchBar = document.getElementById("batchBar");
const progressText = document.getElementById("progressText");
const thumbGrid = document.getElementById("thumbGrid");
const downloadAllBtn = document.getElementById("downloadAllBtn");
// Feature 2 (Quality)
const qualitySelect = document.getElementById("qualitySelect");
// Feature 3 (Format): output format radios (PNG / JPEG / WebP)
const formatRadios = document.querySelectorAll('input[name="formatSelect"]');
const resetBtn = document.getElementById("resetBtn");

// ---------------------------
// Watermark algorithm helpers
// (adapted from journey-ad/gemini-watermark-remover)
// ---------------------------

// Ignore tiny alpha values (noise)
const ALPHA_THRESHOLD = 0.002;
// Avoid division by near-zero values when alpha is very close to 1
const MAX_ALPHA = 0.99;
// The watermark "logo color" is white (255)
const LOGO_VALUE = 255;

/**
 * Gemini watermark rules (from reference repo):
 * - If both width and height > 1024 => watermark is 96×96, margin 64px
 * - Otherwise => watermark is 48×48, margin 32px
 */
function detectWatermarkConfig(imageWidth, imageHeight) {
  if (imageWidth > 1024 && imageHeight > 1024) {
    return { logoSize: 96, marginRight: 64, marginBottom: 64 };
  }
  return { logoSize: 48, marginRight: 32, marginBottom: 32 };
}

/**
 * Calculate where the watermark sits (bottom-right with margins).
 */
function calculateWatermarkPosition(imageWidth, imageHeight, config) {
  const { logoSize, marginRight, marginBottom } = config;
  return {
    x: imageWidth - marginRight - logoSize,
    y: imageHeight - marginBottom - logoSize,
    width: logoSize,
    height: logoSize,
  };
}

/**
 * Build an alpha map from the pre-captured watermark background image.
 * In the reference project, they ship two PNGs:
 * - assets/bg_48.png
 * - assets/bg_96.png
 *
 * Each pixel's alpha is estimated as: max(R,G,B) / 255
 */
function calculateAlphaMap(bgCaptureImageData) {
  const { width, height, data } = bgCaptureImageData;
  const alphaMap = new Float32Array(width * height);

  for (let i = 0; i < alphaMap.length; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const maxChannel = Math.max(r, g, b);
    alphaMap[i] = maxChannel / 255.0;
  }

  return alphaMap;
}

/**
 * Core reverse alpha blending.
 * Modifies the ImageData *in place* in the watermark rectangle.
 */
function removeWatermark(imageData, alphaMap, position) {
  const { x, y, width, height } = position;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const imgIdx = ((y + row) * imageData.width + (x + col)) * 4;
      const alphaIdx = row * width + col;

      let alpha = alphaMap[alphaIdx];
      if (alpha < ALPHA_THRESHOLD) continue;

      alpha = Math.min(alpha, MAX_ALPHA);
      const oneMinusAlpha = 1.0 - alpha;

      // Apply to R, G, B channels (leave A as-is)
      for (let c = 0; c < 3; c++) {
        const watermarked = imageData.data[imgIdx + c];
        const original = (watermarked - alpha * LOGO_VALUE) / oneMinusAlpha;
        imageData.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
      }
    }
  }
}

// ---------------------------
// Load the two watermark maps once
// ---------------------------
const bg48 = new Image();
const bg96 = new Image();
bg48.src = "./assets/bg_48.png";
bg96.src = "./assets/bg_96.png";

let alpha48 = null;
let alpha96 = null;

async function ensureAlphaMapsReady() {
  await Promise.all([
    new Promise((resolve, reject) => {
      if (bg48.complete && bg48.naturalWidth) return resolve();
      bg48.onload = resolve;
      bg48.onerror = reject;
    }),
    new Promise((resolve, reject) => {
      if (bg96.complete && bg96.naturalWidth) return resolve();
      bg96.onload = resolve;
      bg96.onerror = reject;
    }),
  ]);

  // Compute and cache alpha maps the first time we need them.
  if (!alpha48) alpha48 = buildAlphaMapFromImage(bg48, 48);
  if (!alpha96) alpha96 = buildAlphaMapFromImage(bg96, 96);
}

function buildAlphaMapFromImage(img, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, size, size);
  return calculateAlphaMap(imageData);
}

// ---------------------------
// UI helpers
// ---------------------------
function setStatus(text, type = "info") {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", type === "error");
}

function formatCountText(done, total, phase = "Processing") {
  return `${phase} ${done} of ${total}…`;
}

function safeFileBaseName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").slice(0, 80) || "image";
}

function bytesToHuman(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/**
 * Feature 2: read the selected quality from the dropdown.
 * Value is a number from 0.0 to 1.0 (e.g. 0.95).
 */
function getSelectedQuality() {
  const q = Number(qualitySelect?.value ?? 1);
  if (!Number.isFinite(q)) return 1;
  return Math.max(0.0, Math.min(1.0, q));
}

/**
 * Feature 3: get the selected output format from the radio buttons.
 * Returns "png" | "jpeg" | "webp" (defaults to "png" if none selected).
 */
function getSelectedFormat() {
  const radio = document.querySelector('input[name="formatSelect"]:checked');
  const v = radio?.value;
  if (v === "jpeg" || v === "webp") return v;
  return "png";
}

/**
 * Set the format radio to match a file type (used when uploading: default to same as input).
 */
function setFormatToMatchFileType(fileType) {
  let value = "png";
  if (/image\/jpeg/i.test(fileType)) value = "jpeg";
  else if (/image\/webp/i.test(fileType)) value = "webp";
  const radio = document.querySelector(`input[name="formatSelect"][value="${value}"]`);
  if (radio) radio.checked = true;
}

/**
 * Decide output format and quality from UI (Feature 3: user chooses format regardless of input).
 */
function getOutputSpec() {
  const q = getSelectedQuality();
  const format = getSelectedFormat();

  if (format === "jpeg") return { mime: "image/jpeg", ext: "jpg", quality: q };
  if (format === "webp") return { mime: "image/webp", ext: "webp", quality: q };
  // PNG: quality controls UPNG quantization when q < 1
  return { mime: "image/png", ext: "png", quality: q };
}

/**
 * Feature 2: PNG "compression".
 *
 * Important beginner note:
 * - PNG is lossless. There is no standard "70% quality" slider like JPEG.
 * - To make PNG smaller, we can re-encode it with fewer colors (palette quantization).
 *   That stays PNG, but it can be slightly lossy (usually still looks great).
 */
function getPngColorCountForQuality(q) {
  // You can tweak these later. Fewer colors => smaller file, more loss.
  if (q >= 0.999) return 0; // 0 means "don't quantize" (use lossless export)
  if (q >= 0.85) return 256; // Medium: up to 256 colors
  return 192; // Compressed: up to 192 colors (better quality vs 128)
}

async function exportResultBlob({ canvas, imageData, mime, quality }) {
  // JPEG/WebP: browser supports quality directly.
  // When converting from PNG/WebP (which can have alpha), JPEG has no alpha —
  // so we draw onto a white background first so transparent pixels become white.
  if (mime === "image/jpeg" || mime === "image/webp") {
    const w = canvas.width;
    const h = canvas.height;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d", { willReadFrequently: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);
    return await new Promise((resolve) => off.toBlob(resolve, mime, quality));
  }

  // PNG:
  // - If quality is 100%, export normally (lossless).
  // - If quality < 100%, try UPNG re-encode (smaller PNG).
  if (mime === "image/png") {
    const q = Math.max(0, Math.min(1, Number(quality ?? 1)));
    const colors = getPngColorCountForQuality(q);

    // Lossless PNG
    if (colors === 0) {
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    // Lossy-compressed PNG via UPNG.js
    const UPNG = window.UPNG;
    if (!UPNG || typeof UPNG.encode !== "function") {
      setStatus("PNG compression library failed to load. Exporting lossless PNG instead.", "info");
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    // UPNG.encode needs exactly w*h*4 RGBA bytes. imageData.data.buffer can be
    // shared/larger, so copy the exact bytes into a new buffer to avoid errors.
    const w = canvas.width;
    const h = canvas.height;
    const size = w * h * 4;
    const rgba = new Uint8Array(size);
    rgba.set(imageData.data);

    try {
      const pngArrayBuffer = UPNG.encode([rgba.buffer], w, h, colors);
      if (!pngArrayBuffer) throw new Error("UPNG.encode returned null");
      return new Blob([pngArrayBuffer], { type: "image/png" });
    } catch (e) {
      console.warn("UPNG compression failed, falling back to lossless PNG:", e);
      setStatus("PNG compression failed for this image. Exporting lossless PNG instead.", "info");
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }
  }

  // Should not happen, but keep a safe fallback
  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Feature 1: batch state
let batchItems = [];
let processedCount = 0;
let failedCount = 0;

function resetUI() {
  // Revoke old result URLs (avoid memory leaks)
  batchItems.forEach((item) => {
    if (item.resultUrl && item.resultUrl.startsWith("blob:")) URL.revokeObjectURL(item.resultUrl);
  });

  fileInput.value = "";
  fileNameEl.textContent = "No file selected";
  batchBar.classList.add("hidden");
  thumbGrid.classList.add("hidden");
  thumbGrid.innerHTML = "";
  downloadAllBtn.disabled = true;
  resetBtn.disabled = true;
  setStatus("");

  batchItems = [];
  processedCount = 0;
  failedCount = 0;
}

// ---------------------------
// Image loading + processing
// ---------------------------
function isSupportedImageFile(file) {
  return !!file && /image\/(png|jpeg|webp)/.test(file.type);
}

/**
 * Read a File into a Data URL string.
 * This is very reliable (works well even when opening the page via file://).
 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read the image file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Convert an uploaded File into an <img> we can draw to canvas.
 */
async function fileToImage(file) {
  const dataUrl = await fileToDataUrl(file);
  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  return img;
}

function explainError(err) {
  const msg = (err && typeof err === "object" && "message" in err) ? String(err.message) : String(err);

  // Common: privacy/fingerprint/canvas-protection extensions blocking pixel reads
  if (/getImageData|SecurityError|tainted|origin-clean/i.test(msg)) {
    return (
      "Your browser blocked canvas pixel access (often caused by privacy/canvas protection extensions).\n" +
      "Try disabling extensions like Canvas Fingerprint Defender (or similar), then refresh and try again."
    );
  }

  // Common: watermark map images not found
  if (/bg_48\.png|bg_96\.png|load|image/i.test(msg) && /failed|error/i.test(msg)) {
    return (
      "The watermark map images failed to load.\n" +
      "Make sure the `assets/` folder (with `bg_48.png` and `bg_96.png`) is next to `index.html`."
    );
  }

  return "Processing failed. Open DevTools → Console to see the exact error, then share it here.";
}

async function processFile(file) {
  // Feature 1 replaces single-file processing with batch processing.
  // This function is kept (not used) to keep the history readable.
}

// ---------------------------
// Feature 1: Batch processing
// ---------------------------

function createThumbCard(item) {
  const card = document.createElement("div");
  card.className = "thumbCard";
  card.id = `card-${item.id}`;

  card.innerHTML = `
    <div class="thumbHeader">
      <div class="thumbName" title="${item.name}">${item.name}</div>
      <div class="thumbStatus" id="status-${item.id}">Queued</div>
    </div>

    <div class="thumbBody">
      <div>
        <p class="thumbRowLabel">Original</p>
        <img class="thumbImg" id="orig-${item.id}" alt="Original ${item.name}" />
      </div>
      <div>
        <p class="thumbRowLabel">Result</p>
        <img class="thumbImg" id="res-${item.id}" alt="Result ${item.name}" />
      </div>
      <div class="thumbRowLabel" id="size-${item.id}"></div>
    </div>

    <div class="thumbFooter">
      <button class="btn primary" id="dl-${item.id}" type="button" disabled>Download</button>
    </div>
  `;

  thumbGrid.appendChild(card);
}

function setItemStatus(item, text, type = "info") {
  const el = document.getElementById(`status-${item.id}`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", type === "error");
}

function setProgress(phase = "Processing") {
  const total = batchItems.length;
  const done = processedCount + failedCount;
  progressText.textContent = formatCountText(done, total, phase);
}

function updateDownloadAllEnabled() {
  // Enable ZIP download if at least one image succeeded AND JSZip exists.
  const anyCompleted = batchItems.some((i) => i.status === "completed" && i.resultBlob);
  const hasZip = typeof window.JSZip !== "undefined";
  downloadAllBtn.disabled = !(anyCompleted && hasZip);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Delay revoke to ensure the download starts
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function handleFiles(files) {
  const onlyImages = files.filter(isSupportedImageFile);
  if (onlyImages.length === 0) {
    setStatus("Please upload PNG, JPG, or WebP images.", "error");
    return;
  }

  if (onlyImages.length > 10) {
    setStatus("Please upload 10 images or fewer.", "error");
    return;
  }

  // Reset any previous run
  resetUI();

  // Prepare UI
  batchItems = onlyImages.map((file, idx) => ({
    id: `${Date.now()}_${idx}`,
    file,
    name: file.name,
    status: "queued",
    originalImg: null,
    resultBlob: null,
    resultUrl: null,
  }));

  fileNameEl.textContent = `Selected: ${batchItems.length} image(s)`;
  thumbGrid.classList.remove("hidden");
  batchBar.classList.remove("hidden");
  resetBtn.disabled = false;
  setStatus("");
  processedCount = 0;
  failedCount = 0;
  setProgress("Processing");

  // Feature 3: default output format to same as first uploaded file
  setFormatToMatchFileType(onlyImages[0].type);

  // Create cards first (so user sees the list immediately)
  batchItems.forEach(createThumbCard);

  // Load watermark maps once
  try {
    await ensureAlphaMapsReady();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load watermark maps.\n\n${explainError(err)}`, "error");
    // Mark all as failed since we can't proceed
    batchItems.forEach((item) => setItemStatus(item, "Failed", "error"));
    return;
  }

  // Process with small concurrency (keeps UI responsive)
  const concurrency = 2;
  let cursor = 0;

  async function worker() {
    while (cursor < batchItems.length) {
      const i = cursor++;
      const item = batchItems[i];
      await processOneItem(item, i, batchItems.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  setProgress("Done");
  updateDownloadAllEnabled();
}

async function processOneItem(item) {
  try {
    setItemStatus(item, "Loading…");
    setProgress("Processing");

    // Reuse the already-loaded original image when reprocessing (quality change).
    const img = item.originalImg || (await fileToImage(item.file));
    item.originalImg = img;

    const origEl = document.getElementById(`orig-${item.id}`);
    if (origEl) origEl.src = img.src;

    setItemStatus(item, "Removing watermark…");

    // Draw image onto a canvas to access pixels
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Decide watermark size + location
    const config = detectWatermarkConfig(canvas.width, canvas.height);
    const position = calculateWatermarkPosition(canvas.width, canvas.height, config);
    const alphaMap = config.logoSize === 96 ? alpha96 : alpha48;

    // Apply reverse alpha blending only within the watermark rectangle
    removeWatermark(imageData, alphaMap, position);
    ctx.putImageData(imageData, 0, 0);

    // Feature 2+3: export using selected quality and format (user chooses PNG/JPEG/WebP).
    const { mime, ext, quality } = getOutputSpec();
    const blob = await exportResultBlob({ canvas, imageData, mime, quality });
    if (!blob) throw new Error("Failed to export result image.");

    // Revoke previous result URL before overwriting (important when reprocessing)
    if (item.resultUrl && item.resultUrl.startsWith("blob:")) {
      URL.revokeObjectURL(item.resultUrl);
    }

    item.resultBlob = blob;
    item.resultUrl = URL.createObjectURL(blob);
    item.resultExt = ext;

    const resEl = document.getElementById(`res-${item.id}`);
    if (resEl) resEl.src = item.resultUrl;

    // File size comparison (simple and helpful now; Feature 2 will refine)
    const sizeEl = document.getElementById(`size-${item.id}`);
    if (sizeEl) {
      const originalText = `Original: ${bytesToHuman(item.file.size)}`;
      const resultText = `Result: ${bytesToHuman(blob.size)}`;
      const qualityPct = Math.round((Number(quality ?? 1) || 1) * 100);
      const qualityText =
        mime === "image/png"
          ? qualityPct >= 100
            ? " (PNG lossless)"
            : ` (PNG compressed ~${qualityPct}%)`
          : ` (${qualityPct}%)`;
      sizeEl.textContent = `${originalText} → ${resultText}${qualityText}`;
    }

    item.status = "completed";
    processedCount++;
    setItemStatus(item, "Done");

    const dlBtn = document.getElementById(`dl-${item.id}`);
    if (dlBtn) {
      dlBtn.disabled = false;
      const ext = item.resultExt || "png";
      const formatLabel = ext === "jpg" ? "JPEG" : ext === "webp" ? "WebP" : "PNG";
      dlBtn.textContent = `Download as ${formatLabel}`;
      dlBtn.onclick = () => {
        const base = safeFileBaseName(item.name);
        downloadBlob(blob, `unwatermarked_${base}.${ext}`);
      };
    }
  } catch (err) {
    console.error(err);
    item.status = "error";
    failedCount++;
    setItemStatus(item, "Failed", "error");

    // Show one global hint for common failures (canvas protection, etc.)
    setStatus(`Some images failed.\n\n${explainError(err)}`, "error");
  } finally {
    setProgress("Processing");
    updateDownloadAllEnabled();
  }
}

/**
 * Feature 2 improvement: if the user changes the quality dropdown,
 * automatically re-process the current batch so the new quality is applied.
 */
async function reprocessCurrentBatch() {
  if (batchItems.length === 0) return;

  // If output is PNG and user chose < 100% quality, we need UPNG.js for compression.
  const outFormat = getSelectedFormat();
  const q = getSelectedQuality();
  if (outFormat === "png" && q < 1 && (!window.UPNG || typeof window.UPNG.encode !== "function")) {
    setStatus("PNG compression needs UPNG.js, but it didn't load. Refresh and try again.", "error");
    return;
  }

  downloadAllBtn.disabled = true;
  processedCount = 0;
  failedCount = 0;
  setProgress("Re-processing");

  // Reset per-item results (but keep original images)
  batchItems.forEach((item) => {
    item.status = "queued";
    if (item.resultUrl && item.resultUrl.startsWith("blob:")) URL.revokeObjectURL(item.resultUrl);
    item.resultUrl = null;
    item.resultBlob = null;

    const resEl = document.getElementById(`res-${item.id}`);
    if (resEl) resEl.removeAttribute("src");

    const dlBtn = document.getElementById(`dl-${item.id}`);
    if (dlBtn) dlBtn.disabled = true;

    setItemStatus(item, "Queued");
  });

  // Process with small concurrency
  const concurrency = 2;
  let cursor = 0;
  async function worker() {
    while (cursor < batchItems.length) {
      const item = batchItems[cursor++];
      await processOneItem(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  setProgress("Done");
  updateDownloadAllEnabled();
}

async function downloadAllAsZip() {
  if (typeof window.JSZip === "undefined") {
    setStatus("JSZip failed to load (needed for ZIP downloads). Please refresh and try again.", "error");
    return;
  }

  const completed = batchItems.filter((i) => i.status === "completed" && i.resultBlob);
  if (completed.length === 0) return;

  downloadAllBtn.disabled = true;
  setProgress("Zipping");

  try {
    const zip = new window.JSZip();
    completed.forEach((item) => {
      const base = safeFileBaseName(item.name);
      const ext = item.resultExt || "png";
      zip.file(`unwatermarked_${base}.${ext}`, item.resultBlob);
    });

    const zipBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob(zipBlob, `unwatermarked_${Date.now()}.zip`);
    setStatus("ZIP ready.");
  } catch (err) {
    console.error(err);
    setStatus("Failed to create ZIP. Please try again.", "error");
  } finally {
    updateDownloadAllEnabled();
    setProgress("Done");
  }
}

// ---------------------------
// Drag-and-drop + click upload
// ---------------------------
// Click anywhere on upload area (or the Select Files button) to open file dialog
uploadArea.addEventListener("click", () => fileInput.click());

uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadArea.classList.add("dragover");
});

uploadArea.addEventListener("dragleave", () => {
  uploadArea.classList.remove("dragover");
});

uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("dragover");
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) handleFiles(files);
});

// Keyboard accessibility: Enter/Space triggers file picker
uploadArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  if (files.length) handleFiles(files);
});

resetBtn.addEventListener("click", resetUI);
downloadAllBtn.addEventListener("click", downloadAllAsZip);
qualitySelect?.addEventListener("change", reprocessCurrentBatch);
formatRadios?.forEach((radio) => radio.addEventListener("change", reprocessCurrentBatch));

// Start clean
resetUI();

