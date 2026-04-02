/**
 * Phase 6 — Sources & References Panel
 *
 * Public API:
 *   initSourcesPanel()  — wire DOM; call once on startup
 *   toggleSources()     — open or close the panel
 */

let _panel = null;
let _btn   = null;

export function initSourcesPanel() {
  _panel = document.getElementById('sources-panel');
  _btn   = document.getElementById('sources-btn');

  if (!_panel) return;

  _panel.innerHTML = _renderContent();
  _panel.querySelector('.sources-close')
    ?.addEventListener('click', _close);

  // Outside click dismisses the panel.
  document.addEventListener('click', (e) => {
    if (!_panel.hidden && !_panel.contains(e.target) && e.target !== _btn) {
      _close();
    }
  });

  // Escape key dismisses the panel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel && !_panel.hidden) {
      _close();
      _btn?.focus();
    }
  });
}

export function toggleSources() {
  if (!_panel) return;
  if (_panel.hidden) {
    _open();
  } else {
    _close();
  }
}

function _open() {
  _panel.hidden = false;
  _btn?.setAttribute('aria-expanded', 'true');
}

function _close() {
  _panel.hidden = true;
  _btn?.setAttribute('aria-expanded', 'false');
}

function _renderContent() {
  return `
    <div class="sources-header">
      <h2 class="sources-title">Data Sources &amp; References</h2>
      <button class="sources-close" aria-label="Close sources panel" title="Close">×</button>
    </div>
    <div class="sources-body">
      <section class="sources-section">
        <h3 class="sources-section-title">Observational Networks</h3>
        <ul class="sources-list">
          <li class="sources-item">
            <div class="sources-item-name">NOAA GML</div>
            <div class="sources-item-desc">NOAA Global Monitoring Laboratory — baseline atmospheric observations including CO₂, CH₄, N₂O, and ozone at remote sites worldwide.</div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">WMO GAW</div>
            <div class="sources-item-desc">World Meteorological Organization Global Atmosphere Watch — international network of stations monitoring atmospheric composition.</div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">GHCN v4</div>
            <div class="sources-item-desc">Global Historical Climatology Network version 4 — daily surface temperature and precipitation records from ~100,000 stations.</div>
          </li>
        </ul>
      </section>
      <section class="sources-section">
        <h3 class="sources-section-title">Reanalysis &amp; Gridded Products</h3>
        <ul class="sources-list">
          <li class="sources-item">
            <div class="sources-item-name">ERA5</div>
            <div class="sources-item-desc">ECMWF Reanalysis v5 — global atmospheric reanalysis from 1940 to present at 31 km horizontal resolution.</div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">GISTEMP v4</div>
            <div class="sources-item-desc">NASA Goddard Institute for Space Studies Surface Temperature Analysis version 4 — global surface temperature change since 1880.</div>
          </li>
        </ul>
      </section>
      <section class="sources-section">
        <h3 class="sources-section-title">Algorithms &amp; Methodology</h3>
        <ul class="sources-list">
          <li class="sources-item">
            <div class="sources-item-name">PHA <span class="sources-cite">Menne &amp; Williams, 2009</span></div>
            <div class="sources-item-desc">Pairwise Homogeneity Algorithm — detects and adjusts for non-climatic shifts in temperature records using neighbour station comparisons.</div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">TOB <span class="sources-cite">Karl et al., 1986</span></div>
            <div class="sources-item-desc">Time-of-Observation Bias correction — adjusts daily max/min temperature readings for the systematic effect of observation time.</div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">USHCNv2.5 <span class="sources-cite">Menne et al., 2009</span></div>
            <div class="sources-item-desc">US Historical Climatology Network version 2.5 — adjusted monthly temperature dataset for ~1,200 US stations.</div>
          </li>
        </ul>
      </section>
    </div>
  `;
}
