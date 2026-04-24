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
            <div class="sources-item-desc">Global Historical Climatology Network Monthly temperature dataset. Klymot uses GHCNm station records as the primary climate observation source for map, table, and station detail views. <a class="sources-link" href="https://doi.org/10.1175/JCLI-D-18-0094.1" target="_blank" rel="noopener">DOI</a></div>
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
          <li class="sources-item">
            <div class="sources-item-name">Aggregate graph — full-years-only filter</div>
            <div class="sources-item-desc">When enabled (the default), a station contributes to the aggregate for a given year only if it reported observations for all 12 calendar months of that year. Station-years with any missing month are excluded entirely — they do not affect any monthly slot's count, mean, or standard deviation for that year. This prevents partial-year records from biasing the aggregate: a station that only reported in summer months would otherwise pull the annual and monthly means toward its warm-season values. The filter is applied after the anomaly baseline step, so the baseline itself is derived from all full years in each station's record, but the contribution to the multi-station aggregate is restricted to full years. Disabling the filter restores the default GHCN behaviour of including every observed month individually. <span class="sources-cite">No external DOI; project-specific method note.</span></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">Aggregate graph — anomaly baseline modes</div>
            <div class="sources-item-desc">In anomaly modes (Monthly Anomaly, Annual Anomaly) each station's temperatures are expressed as departures from a per-station, per-calendar-month baseline before aggregation.
            <br><br>
            In aggregate mode the Baseline selector offers five modes that differ in how that reference period is chosen:
            <br><br>
            <b>Station</b> — the default. Each station's baseline is derived from up to 30 "full years" (years where all 12 months are non-missing) selected as close as possible to the centre of that station's own record. The record midpoint is the average of the first and last years with any data; full years are ranked by absolute distance from this midpoint, with ties broken in favour of earlier years, and the nearest 30 are used. This approach removes the effect of stations entering or leaving the network and makes multi-station means comparable across time, but the baselines differ between stations so the resulting anomaly series cannot be directly compared to a fixed-period climatology such as the WMO 1991–2020 normals.
            <br><br>
            <b>Auto Decade</b> — the server scans all decades (1850s, 1860s, …) and selects the one for which the most stations in the current selection have data for at least one full year within that ten-year window. Every station then uses that same decade as its baseline period, computing a per-month mean from whichever full years within the decade it has. Using a shared decade baseline makes anomalies directly comparable across stations and allows the aggregate to track departures from a common reference frame.
            <br><br>
            <b>Auto Year</b> — as above but the server picks a single calendar year rather than a decade, maximising the number of stations with a full year of data. Baselines derived from a single year are noisier than decade-based baselines (a single anomalous year can bias the reference), but they maximise temporal precision when comparing stations across a specific year.
            <br><br>
            <b>Decade ▾ / Year ▾</b> — you choose the reference decade or year explicitly using the chip picker. The server then derives each station's baseline from its data in that period. A coverage gradient on the chips indicates what fraction of the selected stations have data in each period — faded chips mean few stations have a baseline available.
            <br><br>
            <b>Strict vs Nearest match</b> — for all shared-period modes (Auto Decade, Auto Year, Decade, Year) a fallback option controls how stations that lack any data in the chosen period are handled. In <i>Strict</i> mode those stations are excluded entirely — they contribute neither to the baseline nor to the aggregate, and the status line shows "N of M stations". In <i>Nearest match</i> mode, stations without data in the chosen period instead use their closest available full year (or decade) as a substitute baseline, so all stations remain in the aggregate. Nearest match avoids abrupt station-count drops at period boundaries but introduces a small inconsistency: the effective reference year differs across stations.
            <br><br>
            Stations with no full years at all are always excluded from anomaly aggregation regardless of mode. <span class="sources-cite">No external DOI; project-specific method note.</span></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">Aggregate graph — geo-gridded averaging</div>
            <div class="sources-item-desc">When geo-gridded mode is enabled, each station is assigned a weight proportional to cos(φ), where φ is its latitude in degrees. This approximates the surface area of an equal-angle grid cell at that latitude — cells near the equator cover more area than cells near the poles, so equatorial stations receive greater weight. The weighted mean for each month is computed using Welford's online algorithm extended for non-uniform weights; the weighted population standard deviation is derived from the same accumulation. Without geo-gridding all stations receive equal weight regardless of location, which over-represents high-latitude regions where station density is often higher. <span class="sources-cite">No external DOI; project-specific method note.</span></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">Aggregate graph — weighted trend and 95% CI on slope</div>
            <div class="sources-item-desc">Trend lines in the aggregate graph are computed with inverse-variance weighted ordinary least squares (IV-WLS). Each data point is weighted by 1/Var(mean), the reciprocal of the sampling variance of the multi-station mean for that period. In monthly and by-month modes Var(mean) = σ²/n, where σ is the population standard deviation across stations and n is the station count, giving a weight of n/σ². When only one station contributes (σ = 0) the weight falls back to n. In annual mode the annual mean averages 12 monthly means, so its variance combines two components (identical to those used for the CI bands): station-sampling variance (1/144)·Σ(σᵢ²/nᵢ) and within-year month-to-month variance s²/12, where s² is the sample variance of the 12 monthly means; the annual weight is then 1/(station var + month var). Inverse-variance weighting is the minimum-variance linear unbiased estimator under heterogeneous precision: it simultaneously accounts for station density and inter-station agreement, upweighting periods where both are favourable. Weighting by count alone (a common approximation) ignores spread — five tightly-agreeing stations may outweigh a hundred wildly-varying ones.
            <br><br>
            The slope label on each chart shows a 95% confidence interval (±1.96 SE) for the trend. Temperature anomaly series are strongly autocorrelated — annual values typically have lag-1 autocorrelation ρ ≈ 0.4–0.7 — which means naive standard errors underestimate true uncertainty. Klymot applies an effective-sample-size correction: after computing the IV-WLS slope and its nominal standard error SE<sub>raw</sub> = √(Σw/denom), the residuals are used to estimate lag-1 autocorrelation ρ̂ via the Yule-Walker formula. The effective sample size is n<sub>eff</sub> = n·(1−ρ̂)/(1+ρ̂), and the corrected SE is SE<sub>adj</sub> = SE<sub>raw</sub>·√(n/n<sub>eff</sub>). This matches the approach recommended in IPCC AR6 and used in many GHCN/Berkeley Earth trend analyses. The same AR(1) ESS correction is applied to OLS trend lines on individual station charts. <span class="sources-cite">No external DOI; project-specific method note.</span></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">Aggregate graph — 95% confidence interval bands</div>
            <div class="sources-item-desc">The shaded 95% CI bands in the aggregate graph reflect uncertainty in the multi-station mean. In monthly and by-month modes, SE = σ/√n for each month slot, where σ is the population standard deviation across stations and n is the station count; CI = mean ± 1.96 · SE. In annual mode the annual mean averages 12 monthly means, so two variance components are combined in quadrature: (1) station-sampling error — (1/144) · Σ(σ<sub>i</sub>²/n<sub>i</sub>) summed over the 12 months; (2) within-year month-to-month variability — s²/12, where s² is the sample variance of the 12 monthly means around the annual mean. Total SE = √(station var + month var); CI = annual mean ± 1.96 · SE. <span class="sources-cite">No external DOI; project-specific method note.</span></div>
          </li>
          <li class="sources-item">
            <div class="sources-item-name">LOESS smoothing</div>
            <div class="sources-item-desc">The optional LOESS (Locally Estimated Scatterplot Smoothing) curve fits a locally weighted linear regression at each data point. For each point x<sub>i</sub>, the k nearest neighbours are selected, where k = max(3, round(span · n)) and n is the total number of valid points. The neighbourhood half-width h is the maximum x-distance from x<sub>i</sub> to its furthest included neighbour. Each neighbour j is assigned a tricube weight w<sub>j</sub> = (1 − (|x<sub>j</sub> − x<sub>i</sub>| / h)³)³; points at or beyond distance h receive zero weight. A weighted ordinary least squares line is then fitted through the neighbourhood, and its value at x<sub>i</sub> becomes the smoothed output. The span controls the bandwidth as a fraction of all data points and can be adjusted from 0.10 to 0.90 (default 0.30). A smaller span produces a tighter curve that follows local variation more closely; a larger span produces a smoother curve that reflects longer-term trends. At the centre of a time series the LOESS fitted value is algebraically equivalent to a tricube-weighted moving average spanning k = max(3, round(span · n)) data points, where n is the number of valid annual observations. A tricube-weighted moving average of k points suppresses variance by the same amount as a simple (uniform-weight) running mean of k / 1.40 points (eq. 2.44 in Loader 1999); the slider label therefore shows the equivalent simple moving-average window width in years — for example, a span of 0.30 over a 50-year record displays "(11 yr)" because max(3, round(0.30 × 50)) / 1.40 ≈ 11. <span class="sources-cite">Cleveland, W. S. (1979). Robust Locally Weighted Regression and Smoothing Scatterplots. <i>Journal of the American Statistical Association</i>, 74(368), 829–836. <a class="sources-link" href="https://doi.org/10.1080/01621459.1979.10481038" target="_blank" rel="noopener">DOI</a> · Loader, C. (1999). <i>Local Regression and Likelihood</i>. Springer. <a class="sources-link" href="https://doi.org/10.1007/b98858" target="_blank" rel="noopener">DOI</a></span></div>
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
