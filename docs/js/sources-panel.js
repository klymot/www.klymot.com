/**
 * Phase 6 — Sources & References Panel
 *
 * Public API:
 *   initSourcesPanel()  — wire DOM; call once on startup
 *   toggleSources()     — open or close the panel
 */

import { trackEvent } from './analytics.js?v=20260406';

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
  trackEvent('sources_open');
}

function _close() {
  _panel.hidden = true;
  _btn?.setAttribute('aria-expanded', 'false');
}

export function renderSourcesContent({ includeShell = true } = {}) {
  const body = `
    <div class="sources-body">
      <section class="sources-section">
        <h3 class="sources-section-title">Core Datasets</h3>
        <ul class="sources-list">
          <li class="sources-item">
            <div class="sources-item-name">GHCN-Monthly v4 <span class="sources-cite">Menne et al., 2018</span></div>
            <div class="sources-item-desc">Global Historical Climatology Network Monthly temperature dataset. Meridian uses GHCNm station records as the primary climate observation source for map, table, and station detail views. <a class="sources-link" href="https://doi.org/10.1175/JCLI-D-18-0094.1" target="_blank" rel="noopener">DOI</a></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">GHSL R2023A</div>
            <div class="sources-item-desc">Global Human Settlement Layer products provide the built-up surface and population context used alongside station records in the detail panel. <a class="sources-link" href="https://doi.org/10.2760/098587" target="_blank" rel="noopener">DOI</a></div>
          </li>
        </ul>
      </section>
      <section class="sources-section">
        <h3 class="sources-section-title">Land Use &amp; Population</h3>
        <ul class="sources-list">
          <li class="sources-item">
            <div class="sources-item-name">GHS-BUILT-S R2023A <span class="sources-cite">Pesaresi &amp; Politis, JRC 2023</span></div>
            <div class="sources-item-desc">Global Human Settlement Layer built-up surface grid — 100 m resolution, multitemporal 1975–2030, derived from Sentinel-2 and Landsat composites. Used to compute the Built-Up Surface tiles and scores shown in the station detail panel. <a class="sources-link" href="https://doi.org/10.2905/JRC.939FACR" target="_blank" rel="noopener">DOI</a> · <a class="sources-link" href="https://human-settlement.emergency.copernicus.eu/ghs_buS2023.php" target="_blank" rel="noopener">Dataset page</a> · <a class="sources-link" href="https://data.jrc.ec.europa.eu/dataset/9f06f36f-4b11-47ec-abb0-4f8b7b1d72ea" target="_blank" rel="noopener">JRC catalogue</a></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">GHS-POP R2023A <span class="sources-cite">Schiavina et al., JRC 2023</span></div>
            <div class="sources-item-desc">Global Human Settlement Layer population grid — 100 m resolution, multitemporal 1975–2030, disaggregated from census data using built-up surface as a dasymetric layer. Used to compute the Population density tiles and scores shown in the station detail panel. <a class="sources-link" href="https://doi.org/10.2905/JRC.CXKEDRR" target="_blank" rel="noopener">DOI</a> · <a class="sources-link" href="https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php" target="_blank" rel="noopener">Dataset page</a> · <a class="sources-link" href="https://data.jrc.ec.europa.eu/dataset/2ff68a52-5b5b-4a22-8f40-c41da8332cfe" target="_blank" rel="noopener">JRC catalogue</a></div>
          </li>
        </ul>
      </section>
      <section class="sources-section">
        <h3 class="sources-section-title">Algorithms &amp; Methodology</h3>
        <ul class="sources-list">
          <li class="sources-item">
            <div class="sources-item-name">PHA <span class="sources-cite">Menne &amp; Williams, 2009</span></div>
            <div class="sources-item-desc">Pairwise Homogeneity Algorithm — detects and adjusts for non-climatic shifts in temperature records using neighbour station comparisons. <a class="sources-link" href="https://doi.org/10.1175/2008JCLI2263.1" target="_blank" rel="noopener">DOI</a></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">TOB <span class="sources-cite">Karl et al., 1986</span></div>
            <div class="sources-item-desc">Time-of-Observation Bias correction — adjusts daily max/min temperature readings for the systematic effect of observation time. <a class="sources-link" href="https://doi.org/10.1175/1520-0450%281986%29025%3C0145%3AAMTETT%3E2.0.CO%3B2" target="_blank" rel="noopener">DOI</a></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">USHCNv2.5 <span class="sources-cite">Menne et al., 2009</span></div>
            <div class="sources-item-desc">US Historical Climatology Network version 2.5 — adjustment methodology reference aligned with the GHCNm processing lineage for US monthly station records. <a class="sources-link" href="https://doi.org/10.1175/2008BAMS2613.1" target="_blank" rel="noopener">DOI</a></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">Partial-year annual estimates</div>
            <div class="sources-item-desc">For years with fewer than 12 months of data, each observed month <i>i</i> yields an implied annual estimate E = Ā · t<sub>i</sub> / T<sub>i</sub>, where T<sub>i</sub> is the climatological monthly mean and Ā = mean(T<sub>1</sub>…T<sub>12</sub>). All arithmetic is performed in Kelvin so that T<sub>i</sub> is always large and positive. These estimates are combined via Generalised Least Squares using a 12×12 sample covariance matrix of residuals derived from complete years, giving a weighted mean and 95% confidence interval. <span class="sources-cite">No external DOI; project-specific method note.</span></div>
          </li>
        </ul>
      </section>
    </div>`;

  if (!includeShell) return body;

  return `
    <div class="sources-header">
      <h2 class="sources-title">Data Sources &amp; References</h2>
      <button class="sources-close" aria-label="Close sources panel" title="Close">×</button>
    </div>
    ${body}
  `;
}

function _renderContent() {
  return renderSourcesContent();
}
