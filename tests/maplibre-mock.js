/**
 * Minimal MapLibre GL JS mock.
 * Served by Playwright route interception in place of the real CDN bundle.
 * Exposes window.maplibregl with enough surface area to satisfy app.js / map.js / markers.js.
 *
 * Test-inspection surfaces:
 *   window.__mapInstance  — the MockMap instance (call _emitLayer() to simulate layer events)
 *   window.__mapLayers    — array of layer configs added via addLayer() (reset on setStyle)
 *   window.__mapSources   — object of source configs added via addSource() (reset on setStyle)
 */
window.maplibregl = (() => {
  function normaliseProjection(projection) {
    if (typeof projection === 'string') return projection;
    return projection?.type ?? 'mercator';
  }

  class MockMap {
    constructor(opts) {
      this._zoom       = opts.zoom       ?? 1.5;
      this._center     = opts.center     ?? [0, 0];
      this._projection = normaliseProjection(opts.projection);
      this._style      = opts.style      ?? '';
      this._handlers   = {};
      this._layers     = [];
      this._sources    = {};
      this._canvas     = { style: { cursor: '' } };
      this._styleLoaded = false;
      this._lastFlyTo  = null;
      this.dragRotate        = { disable() {} };
      this.touchZoomRotate   = { disableRotation() {}, disable() {} };
      this.touchPitch        = { disable() {} };
      this.scrollZoom        = { disable() {} };
      this.boxZoom           = { disable() {} };
      this.dragPan           = { disable() {} };
      this.keyboard          = { disable() {} };
      this.doubleClickZoom   = { disable() {} };

      // Expose for test access.
      window.__mapInstance = this;
      window.__mapLayers   = this._layers;
      window.__mapSources  = this._sources;

      // Emit style.load then load asynchronously so all synchronous listeners
      // are registered before the events fire.
      setTimeout(() => {
        this._styleLoaded = true;
        this._emit('styledata', {});
        this._emit('style.load', {});
        this._emit('idle', {});
        this._emit('load', {});
      }, 30);
    }

    // ── Event emitter ────────────────────────────────────────────────
    /**
     * Supports both 2-arg form  on(event, cb)
     * and 3-arg layer form       on(event, layerId, cb).
     */
    on(event, layerIdOrCb, cb) {
      if (typeof layerIdOrCb === 'function') {
        (this._handlers[event] ??= []).push(layerIdOrCb);
      } else {
        const key = `${event}::${layerIdOrCb}`;
        (this._handlers[key] ??= []).push(cb);
      }
      return this;
    }

    once(event, cb) {
      const wrapper = (...args) => {
        this._handlers[event] = (this._handlers[event] ?? []).filter(f => f !== wrapper);
        cb(...args);
      };
      // once only supports 2-arg form (sufficient for current usage)
      (this._handlers[event] ??= []).push(wrapper);
      return this;
    }

    off(event, layerIdOrCb, cb) {
      if (typeof layerIdOrCb === 'function') {
        if (this._handlers[event])
          this._handlers[event] = this._handlers[event].filter(f => f !== layerIdOrCb);
      } else {
        const key = `${event}::${layerIdOrCb}`;
        if (this._handlers[key])
          this._handlers[key] = this._handlers[key].filter(f => f !== cb);
      }
      return this;
    }

    _emit(event, data) {
      (this._handlers[event] ?? []).slice().forEach(cb => cb(data ?? {}));
    }

    /**
     * Simulate a click on a layer, passing synthetic features.
     * Used by tests: window.__mapInstance._emitLayer('click', 'location-markers', features)
     */
    _emitLayer(event, layerId, features) {
      const key = `${event}::${layerId}`;
      const e   = { features: features ?? [], point: { x: 0, y: 0 } };
      (this._handlers[key] ?? []).slice().forEach(cb => cb(e));
    }

    // ── Zoom ─────────────────────────────────────────────────────────
    getZoom()  { return this._zoom; }
    zoomIn()   { this._zoom = Math.min(16, this._zoom + 1); this._emit('zoom', {}); }
    zoomOut()  { this._zoom = Math.max(1,  this._zoom - 1); this._emit('zoom', {}); }

    // ── Projection ───────────────────────────────────────────────────
    setProjection(p) { this._projection = normaliseProjection(p); }
    getProjection()  { return { name: this._projection }; }

    // ── Style ────────────────────────────────────────────────────────
    setStyle(url) {
      this._style = url;
      this._styleLoaded = false;
      setTimeout(() => {
        // Reset sources and layers to simulate MapLibre's style-reload behaviour.
        this._layers  = [];
        this._sources = {};
        window.__mapLayers  = this._layers;
        window.__mapSources = this._sources;
        this._styleLoaded = true;
        this._emit('styledata', {});
        this._emit('style.load', {});
        this._emit('idle', {});
      }, 30);
      return this;
    }
    getStyle() { return { name: this._style }; }
    isStyleLoaded() { return this._styleLoaded; }

    // ── Sources ──────────────────────────────────────────────────────
    addSource(id, opts) {
      this._sources[id] = { ...opts };
      window.__mapSources = this._sources;
    }
    getSource(id) {
      const src = this._sources[id];
      if (!src) return null;
      return {
        ...src,
        setData(data) {
          // Mock: store the latest data for test inspection.
          src._data = data;
        },
        getClusterExpansionZoom(clusterId, callback) {
          // Mock: always expand to zoom 8.
          callback(null, 8);
        },
      };
    }

    // ── Layers / paint ───────────────────────────────────────────────
    addLayer(config) {
      this._layers.push(config);
      window.__mapLayers = this._layers;
    }
    getLayer(id) {
      return this._layers.find(l => l.id === id) ?? null;
    }
    setPaintProperty(layerId, prop, value) {
      const layer = this._layers.find(l => l.id === layerId);
      if (layer) {
        layer.paint       = layer.paint ?? {};
        layer.paint[prop] = value;
      }
    }

    // ── Camera ───────────────────────────────────────────────────────
    getCenter()  { return { lat: this._center[1], lng: this._center[0] }; }
    jumpTo(opts) {
      if (opts.center !== undefined) this._center = opts.center;
      if (opts.zoom   !== undefined) {
        this._zoom = opts.zoom;
        this._emit('zoom', {});
      }
      return this;
    }
    easeTo(opts) {
      this.jumpTo(opts);
      setTimeout(() => this._emit('moveend', {}), 20);
      return this;
    }
    flyTo(opts) {
      this._lastFlyTo = opts;
      this.jumpTo(opts);
      setTimeout(() => this._emit('moveend', {}), 20);
      return this;
    }

    // ── Resize ───────────────────────────────────────────────────────
    resize() { /* no-op in mock */ }

    // ── Bounds ───────────────────────────────────────────────────────
    fitBounds(bounds, opts) { /* no-op in mock */ return this; }

    // ── Lifecycle ────────────────────────────────────────────────────
    remove() { /* no-op in mock */ }

    // ── Canvas ───────────────────────────────────────────────────────
    getCanvas() { return this._canvas; }

    // ── Query ────────────────────────────────────────────────────────
    queryRenderedFeatures(point, opts) {
      // Tests can set window.__mockFeatures[layerId] = [...] before triggering events.
      return window.__mockFeatures?.[opts?.layers?.[0]] ?? [];
    }
  }

  return {
    Map: MockMap,
    workerUrl: '',
  };
})();
