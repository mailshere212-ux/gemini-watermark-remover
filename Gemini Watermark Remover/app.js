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

const previewGrid = document.getElementById("previewGrid");
const originalPreview = document.getElementById("originalPreview");
const resultPreview = document.getElementById("resultPreview");
const downloadBtn = document.getElementById("downloadBtn");
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

function resetUI() {
  // Revoke old result URL (avoid memory leaks)
  if (resultPreview.src && resultPreview.src.startsWith("blob:")) {
    URL.revokeObjectURL(resultPreview.src);
  }

  fileInput.value = "";
  fileNameEl.textContent = "No file selected";
  originalPreview.removeAttribute("src");
  resultPreview.removeAttribute("src");
  previewGrid.classList.add("hidden");
  downloadBtn.disabled = true;
  resetBtn.disabled = true;
  downloadBtn.onclick = null;
  setStatus("");
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
  if (!isSupportedImageFile(file)) {
    setStatus("Please upload a PNG, JPG, or WebP image.", "error");
    return;
  }

  fileNameEl.textContent = `Selected: ${file.name}`;
  previewGrid.classList.remove("hidden");
  downloadBtn.disabled = true;
  resetBtn.disabled = true;
  setStatus("Loading image…");

  try {
    const img = await fileToImage(file);
    originalPreview.src = img.src;

    // Load watermark maps after the original preview is visible,
    // so even if map loading fails you still see the uploaded image.
    await ensureAlphaMapsReady();

    setStatus("Removing watermark…");

    // Draw the image onto a canvas so we can access pixels
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

    // Export as PNG so the result is lossless
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Failed to export result image.");

    const resultUrl = URL.createObjectURL(blob);
    resultPreview.src = resultUrl;

    downloadBtn.disabled = false;
    resetBtn.disabled = false;

    downloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = resultUrl;
      const base = file.name.replace(/\.[^.]+$/, "");
      a.download = `unwatermarked_${base}.png`;
      a.click();
    };

    setStatus("Done.");
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong while processing this image.\n\n${explainError(err)}`, "error");
  }
}

// ---------------------------
// Drag-and-drop + click upload
// ---------------------------
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
  const file = e.dataTransfer?.files?.[0];
  if (file) processFile(file);
});

// Keyboard accessibility: Enter/Space triggers file picker
uploadArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) processFile(file);
});

resetBtn.addEventListener("click", resetUI);

// Start clean
resetUI();

