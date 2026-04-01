/**
 * Minimal Mapbox GL JS mock.
 * Served by Playwright route interception in place of the real CDN bundle.
 * Exposes window.mapboxgl with enough surface area to satisfy app.js / map.js.
 */
window.mapboxgl = (() => {
  class MockMap {
    constructor(opts) {
      this._zoom       = opts.zoom       ?? 1.5;
      this._center     = opts.center     ?? [0, 0];
      this._projection = opts.projection ?? 'mercator';
      this._style      = opts.style      ?? '';
      this._handlers   = {};

      // Emit 'load' asynchronously so listeners registered synchronously fire.
      setTimeout(() => this._emit('load', {}), 30);
    }

    // ── Event emitter ────────────────────────────────────────────────
    on(event, cb) {
      (this._handlers[event] ??= []).push(cb);
      return this;
    }
    once(event, cb) {
      const wrapper = (...args) => {
        this._handlers[event] = (this._handlers[event] ?? []).filter(f => f !== wrapper);
        cb(...args);
      };
      return this.on(event, wrapper);
    }
    off(event, cb) {
      if (this._handlers[event])
        this._handlers[event] = this._handlers[event].filter(f => f !== cb);
      return this;
    }
    _emit(event, data) {
      (this._handlers[event] ?? []).forEach(cb => cb(data ?? {}));
    }

    // ── Zoom ─────────────────────────────────────────────────────────
    getZoom()  { return this._zoom; }
    zoomIn()   { this._zoom = Math.min(16, this._zoom + 1); this._emit('zoom', {}); }
    zoomOut()  { this._zoom = Math.max(1,  this._zoom - 1); this._emit('zoom', {}); }

    // ── Projection ───────────────────────────────────────────────────
    setProjection(p) { this._projection = p; }
    getProjection()  { return { name: this._projection }; }

    // ── Style ────────────────────────────────────────────────────────
    setStyle(url) {
      this._style = url;
      setTimeout(() => this._emit('style.load', {}), 30);
      return this;
    }
    getStyle() { return { name: this._style }; }

    // ── Layers / paint ───────────────────────────────────────────────
    getLayer()           { return null; }
    setPaintProperty()   {}

    // ── Camera ───────────────────────────────────────────────────────
    getCenter()  { return { lat: this._center[1], lng: this._center[0] }; }
    jumpTo(opts) {
      if (opts.center) this._center = opts.center;
      if (opts.zoom !== undefined) this._zoom = opts.zoom;
      return this;
    }
    easeTo(opts)  { return this.jumpTo(opts); }
    flyTo(opts)   { return this.jumpTo(opts); }
  }

  return {
    accessToken: '',
    Map: MockMap,
    // Prevent "mapboxgl.workerUrl" errors in some builds
    workerUrl: '',
  };
})();
