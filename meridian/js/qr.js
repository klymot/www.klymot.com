/**
 * QR code generation and display.
 *
 * Depends on the `qrcode-generator` library being loaded as the global `qrcode`
 * function (loaded via <script> in index.html from CDN, or intercepted in tests).
 *
 * Public API:
 *   renderQR(url, containerElement, size)  — render a QR SVG into a container
 *   initMapQR(url)                         — init the map-view QR widget; returns an update fn
 */

/**
 * Render a QR code SVG into containerElement encoding url.
 * Safe to call when qrcode-generator is unavailable (silently no-ops).
 *
 * @param {string}      url
 * @param {HTMLElement} containerElement
 * @param {number}      [size=120]  — rendered width/height in px
 */
export function renderQR(url, containerElement, size = 120) {
  if (!containerElement) return;
  /* global qrcode */
  if (typeof qrcode === 'undefined') return;

  // Type 0 = auto-detect the smallest QR version that fits.
  // 'M' = ~15 % error correction — good balance for short URLs.
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();

  // createSvgTag with scalable:true returns a viewBox-based SVG without fixed
  // width/height attributes, so we control the size ourselves below.
  containerElement.innerHTML = qr.createSvgTag({ scalable: true });

  const svgEl = containerElement.querySelector('svg');
  if (svgEl) {
    svgEl.setAttribute('width',  String(size));
    svgEl.setAttribute('height', String(size));
  }
}

/**
 * Initialise the map-view QR widget (#map-qr-container .qr-code) and render
 * the initial URL into it.
 *
 * @param {string} url  — initial URL to encode
 * @returns {function(string): void}  call with a new URL to refresh the QR
 */
export function initMapQR(url) {
  const container = document.querySelector('#map-qr-container .qr-code');
  renderQR(url, container, 100);

  return function updateMapQR(newUrl) {
    renderQR(newUrl, container, 100);
  };
}
