import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from "react";

const ThemeContext = createContext();
const useTheme = () => useContext(ThemeContext);

// ─── Mock Data ───
const MOCK_INDEX = {
  locations: [
    { id: "reykjavik", name: "Reykjavík", lat: 64.1466, lng: -21.9426, category: "station" },
    { id: "svalbard", name: "Svalbard", lat: 78.2232, lng: 15.6267, category: "station" },
    { id: "mauna-loa", name: "Mauna Loa", lat: 19.4721, lng: -155.5922, category: "observatory" },
    { id: "cape-grim", name: "Cape Grim", lat: -40.6833, lng: 144.6894, category: "station" },
    { id: "south-pole", name: "South Pole", lat: -90.0, lng: 0.0, category: "observatory" },
    { id: "barrow", name: "Utqiaġvik", lat: 71.2906, lng: -156.7886, category: "station" },
    { id: "mace-head", name: "Mace Head", lat: 53.3267, lng: -9.8994, category: "station" },
    { id: "samoa", name: "American Samoa", lat: -14.2475, lng: -170.5644, category: "observatory" },
    { id: "halley", name: "Halley Station", lat: -75.58, lng: -26.66, category: "station" },
    { id: "alert", name: "Alert, Nunavut", lat: 82.5, lng: -62.35, category: "station" },
    { id: "izana", name: "Izaña Observatory", lat: 28.309, lng: -16.499, category: "observatory" },
    { id: "zugspitze", name: "Zugspitze", lat: 47.4211, lng: 10.9856, category: "station" },
    { id: "lauder", name: "Lauder", lat: -45.038, lng: 169.684, category: "station" },
    { id: "tokyo", name: "Tokyo", lat: 35.6762, lng: 139.6503, category: "station" },
    { id: "nyalesund", name: "Ny-Ålesund", lat: 78.9231, lng: 11.9244, category: "station" },
  ],
};

const MOCK_DETAILS = {
  "reykjavik": { name: "Reykjavík", country: "Iceland", elevation: "52m", established: "1949", type: "Surface Monitoring Station", description: "Long-running meteorological station in the North Atlantic, contributing to GISTEMP and ERA5 reanalysis datasets. Key node in the sparse high-latitude observation network.", variables: ["Temperature", "Pressure", "Wind", "Humidity"], network: "WMO / GHCN" },
  "mauna-loa": { name: "Mauna Loa Observatory", country: "USA (Hawaii)", elevation: "3397m", established: "1958", type: "Atmospheric Baseline Observatory", description: "Premier atmospheric research facility operated by NOAA. Home to the Keeling Curve — the longest continuous CO₂ measurement record. Located on the northern slope of Mauna Loa volcano.", variables: ["CO₂", "CH₄", "N₂O", "O₃", "Solar Radiation"], network: "NOAA GML / WMO GAW" },
  "cape-grim": { name: "Cape Grim Baseline", country: "Australia (Tasmania)", elevation: "94m", established: "1976", type: "Baseline Air Pollution Station", description: "Samples some of the cleanest air in the world, arriving across the Southern Ocean. Critical Southern Hemisphere reference for greenhouse gas and aerosol trends.", variables: ["CO₂", "CH₄", "CFCs", "Aerosols"], network: "CSIRO / WMO GAW" },
  "south-pole": { name: "Amundsen–Scott Station", country: "Antarctica", elevation: "2835m", established: "1957", type: "Atmospheric & Geophysical Observatory", description: "Year-round research station at the geographic South Pole. Provides unique vantage for atmospheric composition, cosmic ray, and seismological measurements in the most pristine air on Earth.", variables: ["CO₂", "O₃", "Aerosols", "UV Radiation"], network: "NOAA GML / NSF" },
};

// ─── Projection helpers ───
function latLngToMercator(lat, lng, width, height) {
  const x = ((lng + 180) / 360) * width;
  const latRad = (lat * Math.PI) / 180;
  const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const y = height / 2 - (mercN / Math.PI) * (height / 2);
  return { x, y };
}

function latLngToGlobe(lat, lng, centerLat, centerLng, radius) {
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const cLatRad = (centerLat * Math.PI) / 180;
  const cLngRad = (centerLng * Math.PI) / 180;
  const cosC = Math.sin(cLatRad) * Math.sin(latRad) +
    Math.cos(cLatRad) * Math.cos(latRad) * Math.cos(lngRad - cLngRad);
  if (cosC < 0) return null;
  const x = radius * Math.cos(latRad) * Math.sin(lngRad - cLngRad);
  const y = radius * (Math.cos(cLatRad) * Math.sin(latRad) -
    Math.sin(cLatRad) * Math.cos(latRad) * Math.cos(lngRad - cLngRad));
  return { x, y };
}

function generateGraticule() {
  const lines = [];
  for (let lat = -80; lat <= 80; lat += 20) {
    const pts = [];
    for (let lng = -180; lng <= 180; lng += 5) pts.push({ lat, lng });
    lines.push(pts);
  }
  for (let lng = -180; lng <= 180; lng += 30) {
    const pts = [];
    for (let lat = -80; lat <= 80; lat += 5) pts.push({ lat, lng });
    lines.push(pts);
  }
  return lines;
}
const GRATICULE = generateGraticule();

function checkLand(lat, lng) {
  const regions = [
    { latMin: 15, latMax: 72, lngMin: -168, lngMax: -52 },
    { latMin: -56, latMax: 13, lngMin: -82, lngMax: -34 },
    { latMin: 36, latMax: 71, lngMin: -10, lngMax: 40 },
    { latMin: -35, latMax: 37, lngMin: -18, lngMax: 52 },
    { latMin: 5, latMax: 75, lngMin: 40, lngMax: 180 },
    { latMin: 8, latMax: 35, lngMin: 68, lngMax: 90 },
    { latMin: -44, latMax: -10, lngMin: 113, lngMax: 154 },
    { latMin: -8, latMax: 6, lngMin: 95, lngMax: 141 },
    { latMin: 60, latMax: 84, lngMin: -74, lngMax: -12 },
    { latMin: -90, latMax: -65, lngMin: -180, lngMax: 180 },
    { latMin: 30, latMax: 46, lngMin: 129, lngMax: 146 },
    { latMin: 50, latMax: 59, lngMin: -8, lngMax: 2 },
    { latMin: -47, latMax: -34, lngMin: 166, lngMax: 179 },
    { latMin: 5, latMax: 20, lngMin: 117, lngMax: 127 },
    { latMin: -26, latMax: -12, lngMin: 43, lngMax: 50 },
    { latMin: 55, latMax: 71, lngMin: 5, lngMax: 30 },
    { latMin: 63, latMax: 66, lngMin: -24, lngMax: -13 },
  ];
  const water = [
    { latMin: 52, latMax: 66, lngMin: -96, lngMax: -76 },
    { latMin: 18, latMax: 31, lngMin: -98, lngMax: -80 },
    { latMin: 30, latMax: 42, lngMin: -6, lngMax: 36 },
    { latMin: 54, latMax: 66, lngMin: 10, lngMax: 30 },
    { latMin: 12, latMax: 30, lngMin: 32, lngMax: 44 },
    { latMin: 24, latMax: 30, lngMin: 48, lngMax: 56 },
    { latMin: 5, latMax: 22, lngMin: 80, lngMax: 95 },
    { latMin: 0, latMax: 23, lngMin: 104, lngMax: 121 },
    { latMin: 10, latMax: 22, lngMin: -86, lngMax: -60 },
    { latMin: 37, latMax: 47, lngMin: 47, lngMax: 54 },
  ];
  let isLand = false;
  for (const r of regions) {
    if (lat >= r.latMin && lat <= r.latMax && lng >= r.lngMin && lng <= r.lngMax) { isLand = true; break; }
  }
  if (isLand) {
    for (const w of water) {
      if (lat >= w.latMin && lat <= w.latMax && lng >= w.lngMin && lng <= w.lngMax) return false;
    }
  }
  return isLand;
}

// ─── Theme definitions ───
const themes = {
  dark: {
    name: 'dark',
    bg: '#0a1628', bgGrad1: '#0f2847', bgGrad2: '#0a1628',
    oceanTop: '#0f2847', oceanMid: '#163a5f', oceanBot: '#0a1628',
    landFill: 'rgba(45,107,69,0.5)', landDot: 'rgba(45,107,69,0.6)',
    graticule: 'rgba(255,255,255,0.05)',
    panelBg: 'rgba(10,22,40,0.92)', panelBgSolid: 'rgba(15,30,55,0.98)',
    panelBorder: 'rgba(212,168,85,0.25)',
    amber: '#d4a855', amberGlow: '#e8c477', amberDim: '#a07e3a',
    amberBgHover: 'rgba(212,168,85,0.15)', amberBgTag: 'rgba(212,168,85,0.06)', amberBorderTag: 'rgba(212,168,85,0.2)',
    observatory: '#5ca8c4', station: '#d4a855',
    cream: '#f0e8d8', creamDim: '#c8bfa8',
    textPrimary: '#e8e0d0', textSecondary: '#9a9080', textMuted: '#6a6254',
    overlayBg: 'rgba(6,14,28,0.7)', headerGrad: 'rgba(10,22,40,0.85)', footerGrad: 'rgba(10,22,40,0.92)',
    globeCenter: '#1a3a5f', globeEdge: '#091a30', globeShine: 'rgba(255,255,255,0.08)', globeStroke: 'rgba(212,168,85,0.15)',
    markerLabelFill: '#e8e0d0',
    btnBg: 'rgba(255,255,255,0.05)', btnBorder: 'rgba(255,255,255,0.1)',
    btnHoverBg: 'rgba(255,255,255,0.1)', btnHoverBorder: 'rgba(255,255,255,0.2)',
    divider: 'rgba(255,255,255,0.04)', shadow: '0.5', switchIcon: '☽',
  },
  light: {
    name: 'light',
    bg: '#f4f0e8', bgGrad1: '#e8e2d4', bgGrad2: '#f4f0e8',
    oceanTop: '#bdd8ec', oceanMid: '#a8cce4', oceanBot: '#d0e4f0',
    landFill: 'rgba(80,148,95,0.4)', landDot: 'rgba(70,135,85,0.45)',
    graticule: 'rgba(0,0,0,0.06)',
    panelBg: 'rgba(255,253,248,0.94)', panelBgSolid: 'rgba(255,253,248,0.98)',
    panelBorder: 'rgba(140,110,50,0.2)',
    amber: '#7a5f20', amberGlow: '#5c4818', amberDim: '#9a7e3a',
    amberBgHover: 'rgba(122,95,32,0.08)', amberBgTag: 'rgba(122,95,32,0.05)', amberBorderTag: 'rgba(122,95,32,0.18)',
    observatory: '#1e6e90', station: '#7a5f20',
    cream: '#2a2010', creamDim: '#5a4e38',
    textPrimary: '#2a2010', textSecondary: '#5a4e38', textMuted: '#8a8070',
    overlayBg: 'rgba(244,240,232,0.65)', headerGrad: 'rgba(244,240,232,0.92)', footerGrad: 'rgba(244,240,232,0.94)',
    globeCenter: '#a8cce4', globeEdge: '#88b8d8', globeShine: 'rgba(255,255,255,0.3)', globeStroke: 'rgba(100,80,40,0.15)',
    markerLabelFill: '#2a2010',
    btnBg: 'rgba(0,0,0,0.04)', btnBorder: 'rgba(0,0,0,0.1)',
    btnHoverBg: 'rgba(0,0,0,0.08)', btnHoverBorder: 'rgba(0,0,0,0.18)',
    divider: 'rgba(0,0,0,0.05)', shadow: '0.1', switchIcon: '☀',
  },
};

function buildCSS(t) {
  return `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Source+Sans+3:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
* { margin:0; padding:0; box-sizing:border-box; }
body { background:${t.bg}; color:${t.textPrimary}; font-family:'Source Sans 3',sans-serif; overflow:hidden; height:100vh; }
.app { display:flex; flex-direction:column; height:100vh; position:relative; background:radial-gradient(ellipse at 50% 40%,${t.bgGrad1} 0%,${t.bgGrad2} 70%); transition:background 0.5s ease; }
.header { position:absolute; top:0; left:0; right:0; z-index:20; display:flex; align-items:center; justify-content:space-between; padding:16px 28px; background:linear-gradient(180deg,${t.headerGrad} 0%,transparent 100%); pointer-events:none; }
.header>* { pointer-events:auto; }
.logo { display:flex; align-items:baseline; gap:10px; }
.logo-icon { width:28px; height:28px; border-radius:50%; border:2px solid ${t.amber}; display:flex; align-items:center; justify-content:center; align-self:center; }
.logo-icon::after { content:''; width:12px; height:12px; border-radius:50%; background:radial-gradient(circle at 40% 35%,${t.landFill},${t.amberDim}); border:1px solid ${t.amberDim}; }
.logo h1 { font-family:'Playfair Display',serif; font-size:20px; font-weight:600; color:${t.cream}; letter-spacing:1.5px; }
.logo span { font-size:12px; font-weight:300; color:${t.amber}; letter-spacing:3px; text-transform:uppercase; }
.controls { display:flex; align-items:center; gap:8px; }
.projection-toggle { display:flex; background:${t.panelBg}; border:1px solid ${t.panelBorder}; border-radius:8px; overflow:hidden; }
.projection-btn { padding:8px 16px; border:none; background:transparent; color:${t.textSecondary}; font-family:'Source Sans 3',sans-serif; font-size:13px; font-weight:500; cursor:pointer; transition:all 0.3s; letter-spacing:0.5px; }
.projection-btn.active { background:${t.amberBgHover}; color:${t.amber}; }
.projection-btn:hover:not(.active) { color:${t.creamDim}; }
.theme-btn { width:38px; height:38px; border-radius:8px; border:1px solid ${t.panelBorder}; background:${t.panelBg}; color:${t.amber}; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; }
.theme-btn:hover { background:${t.amberBgHover}; }
.map-container { flex:1; position:relative; cursor:grab; overflow:hidden; }
.map-container:active { cursor:grabbing; }
.map-svg { width:100%; height:100%; display:block; }
.zoom-controls { position:absolute; bottom:80px; right:24px; z-index:15; display:flex; flex-direction:column; gap:2px; }
.zoom-btn { width:40px; height:40px; border:1px solid ${t.panelBorder}; background:${t.panelBg}; color:${t.amber}; font-size:20px; font-weight:300; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; font-family:'Source Sans 3',sans-serif; }
.zoom-btn:first-child { border-radius:8px 8px 0 0; }
.zoom-btn:last-child { border-radius:0 0 8px 8px; }
.zoom-btn:hover { background:${t.amberBgHover}; color:${t.amberGlow}; }
.zoom-btn:disabled { opacity:0.3; cursor:not-allowed; }
.zoom-level { width:40px; height:32px; border-left:1px solid ${t.panelBorder}; border-right:1px solid ${t.panelBorder}; background:${t.panelBg}; color:${t.textMuted}; font-size:10px; font-family:'JetBrains Mono',monospace; display:flex; align-items:center; justify-content:center; }
.marker { cursor:pointer; }
.marker:hover .marker-ring { stroke-width:2.5; }
.marker-label { font-family:'Source Sans 3',sans-serif; font-size:11px; font-weight:500; fill:${t.markerLabelFill}; pointer-events:none; opacity:0; transition:opacity 0.3s; }
.marker-label.visible { opacity:1; }
.overlay-backdrop { position:fixed; inset:0; background:${t.overlayBg}; backdrop-filter:blur(8px); z-index:50; display:flex; align-items:center; justify-content:center; animation:fadeIn 0.25s ease; }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
@keyframes slideUp { from{opacity:0;transform:translateY(30px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
.detail-panel { background:linear-gradient(165deg,${t.panelBgSolid},${t.panelBg}); border:1px solid ${t.panelBorder}; border-radius:16px; width:480px; max-width:92vw; max-height:80vh; overflow-y:auto; animation:slideUp 0.35s cubic-bezier(0.16,1,0.3,1); box-shadow:0 24px 80px rgba(0,0,0,${t.shadow}),0 0 1px ${t.panelBorder}; }
.detail-header { padding:28px 28px 0; display:flex; justify-content:space-between; align-items:flex-start; }
.detail-category { font-size:11px; font-weight:600; letter-spacing:2.5px; text-transform:uppercase; color:${t.amber}; margin-bottom:6px; }
.detail-name { font-family:'Playfair Display',serif; font-size:26px; font-weight:700; color:${t.cream}; line-height:1.2; }
.close-btn { width:36px; height:36px; border-radius:50%; border:1px solid ${t.btnBorder}; background:${t.btnBg}; color:${t.textSecondary}; font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.2s; flex-shrink:0; margin-left:16px; }
.close-btn:hover { background:${t.btnHoverBg}; color:${t.cream}; border-color:${t.btnHoverBorder}; }
.detail-meta { padding:20px 28px; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.meta-item { display:flex; flex-direction:column; gap:2px; }
.meta-label { font-size:10px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:${t.textMuted}; }
.meta-value { font-size:14px; font-weight:400; color:${t.textPrimary}; font-family:'JetBrains Mono',monospace; }
.detail-divider { height:1px; background:linear-gradient(90deg,transparent,${t.panelBorder},transparent); margin:0 28px; }
.detail-description { padding:20px 28px; font-size:14px; line-height:1.7; color:${t.textSecondary}; }
.detail-variables { padding:0 28px 24px; display:flex; flex-wrap:wrap; gap:8px; }
.variable-tag { padding:5px 12px; border-radius:20px; border:1px solid ${t.amberBorderTag}; background:${t.amberBgTag}; font-size:12px; font-weight:500; color:${t.amber}; letter-spacing:0.3px; }
.footer { position:absolute; bottom:0; left:0; right:0; z-index:15; background:linear-gradient(0deg,${t.footerGrad} 0%,transparent 100%); padding:30px 28px 14px; }
.footer-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.footer-left { display:flex; align-items:center; gap:20px; }
.footer-stat { font-size:12px; color:${t.textMuted}; }
.footer-stat strong { color:${t.amber}; font-weight:600; font-family:'JetBrains Mono',monospace; }
.sources-trigger { padding:7px 14px; border-radius:6px; border:1px solid ${t.panelBorder}; background:${t.panelBg}; color:${t.textSecondary}; font-family:'Source Sans 3',sans-serif; font-size:12px; font-weight:500; cursor:pointer; transition:all 0.2s; letter-spacing:0.5px; }
.sources-trigger:hover { color:${t.amber}; border-color:${t.amberDim}; }
.sources-panel { position:absolute; bottom:54px; right:28px; z-index:25; width:520px; max-width:calc(100vw - 56px); max-height:65vh; overflow-y:auto; background:linear-gradient(165deg,${t.panelBgSolid},${t.panelBg}); border:1px solid ${t.panelBorder}; border-radius:12px; padding:24px; box-shadow:0 16px 60px rgba(0,0,0,${t.shadow}); animation:slideUp 0.25s cubic-bezier(0.16,1,0.3,1); }
.sources-title { font-family:'Playfair Display',serif; font-size:16px; font-weight:600; color:${t.cream}; margin-bottom:16px; }
.sources-section { margin-bottom:18px; }
.sources-section-title { font-size:10px; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:${t.amber}; margin-bottom:10px; }
.source-item { padding:8px 0; border-bottom:1px solid ${t.divider}; }
.source-item:last-child { border-bottom:none; }
.source-name { font-size:13px; color:${t.textPrimary}; font-weight:500; margin-bottom:2px; }
.source-detail { font-size:11.5px; color:${t.textMuted}; line-height:1.5; }
.source-url { font-family:'JetBrains Mono',monospace; font-size:10.5px; color:${t.observatory}; word-break:break-all; }
@keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
.loading-bar { height:14px; border-radius:4px; background:linear-gradient(90deg,${t.divider},${t.btnBg},${t.divider}); background-size:200% 100%; animation:shimmer 1.5s infinite; margin-bottom:10px; }
.loading-bar.short { width:60%; } .loading-bar.medium { width:80%; } .loading-bar.long { width:100%; }
.coord-display { position:absolute; bottom:80px; left:24px; z-index:15; font-family:'JetBrains Mono',monospace; font-size:11px; color:${t.textMuted}; background:${t.panelBg}; border:1px solid ${t.panelBorder}; border-radius:6px; padding:6px 12px; }
`;
}

// ─── Globe View ───
function GlobeView({ locations, zoom, pan, onLocationClick, showLabels }) {
  const t = useTheme();
  const cx = 250, cy = 200, radius = 160 * zoom;
  const centerLat = pan.y * 0.5;
  const centerLng = -pan.x * 0.5;

  const graticulePaths = useMemo(() =>
    GRATICULE.map(line => {
      const pts = line.map(p => latLngToGlobe(p.lat, p.lng, centerLat, centerLng, radius)).filter(Boolean);
      if (pts.length < 2) return null;
      return "M " + pts.map(p => `${cx + p.x} ${cy - p.y}`).join(" L ");
    }).filter(Boolean),
  [centerLat, centerLng, radius]);

  const continentDots = useMemo(() => {
    const dots = [];
    for (let lat = -70; lat <= 75; lat += 3)
      for (let lng = -170; lng <= 180; lng += 3)
        if (checkLand(lat, lng)) {
          const p = latLngToGlobe(lat, lng, centerLat, centerLng, radius);
          if (p) dots.push({ x: cx + p.x, y: cy - p.y });
        }
    return dots;
  }, [centerLat, centerLng, radius]);

  const markers = useMemo(() =>
    locations.map(loc => {
      const p = latLngToGlobe(loc.lat, loc.lng, centerLat, centerLng, radius);
      if (!p) return null;
      return { ...loc, x: cx + p.x, y: cy - p.y };
    }).filter(Boolean),
  [locations, centerLat, centerLng, radius]);

  return (
    <svg className="map-svg" viewBox="0 0 500 400" preserveAspectRatio="xMidYMid meet">
      <defs>
        <radialGradient id="gg" cx="40%" cy="35%"><stop offset="0%" stopColor={t.globeCenter} /><stop offset="100%" stopColor={t.globeEdge} /></radialGradient>
        <radialGradient id="gs" cx="35%" cy="30%"><stop offset="0%" stopColor={t.globeShine} /><stop offset="100%" stopColor="transparent" /></radialGradient>
        <clipPath id="gc"><circle cx={cx} cy={cy} r={radius} /></clipPath>
      </defs>
      <circle cx={cx} cy={cy} r={radius} fill="url(#gg)" stroke={t.globeStroke} strokeWidth="1" />
      <g clipPath="url(#gc)">
        {graticulePaths.map((d, i) => <path key={i} d={d} fill="none" stroke={t.graticule} strokeWidth="0.5" />)}
        {continentDots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={1.2} fill={t.landDot} />)}
        {markers.map(loc => (
          <g key={loc.id} className="marker" onClick={() => onLocationClick(loc.id)} transform={`translate(${loc.x},${loc.y})`}>
            <circle r="8" fill="transparent" />
            <circle r="4" fill={loc.category === 'observatory' ? t.observatory : t.station} opacity="0.3" />
            <circle className="marker-ring" r="4" fill="none" stroke={loc.category === 'observatory' ? t.observatory : t.station} strokeWidth="1.5" />
            <circle r="1.5" fill={loc.category === 'observatory' ? t.observatory : t.station} />
            {showLabels && <text className="marker-label visible" x="8" y="4" fontSize="9">{loc.name}</text>}
          </g>
        ))}
      </g>
      <circle cx={cx} cy={cy} r={radius} fill="url(#gs)" pointerEvents="none" />
    </svg>
  );
}

// ─── Flat Map (Mercator with X-wrapping) ───
function FlatMapView({ locations, zoom, pan, onLocationClick, showLabels }) {
  const t = useTheme();
  const baseW = 500, baseH = 320;
  const vbW = baseW / zoom, vbH = baseH / zoom;
  // FIXED: drag right → view pans right → viewBox X decreases
  const vbX = (baseW - vbW) / 2 - pan.x * (1 / zoom);
  const vbY = (baseH - vbH) / 2 - pan.y * (1 / zoom);

  const markers = useMemo(() =>
    locations.map(loc => ({ ...loc, ...latLngToMercator(loc.lat, loc.lng, baseW, baseH) })),
  [locations]);

  const graticulePaths = useMemo(() =>
    GRATICULE.map(line => "M " + line.map(p => { const m = latLngToMercator(p.lat, p.lng, baseW, baseH); return `${m.x} ${m.y}`; }).join(" L ")),
  []);

  const continentDots = useMemo(() => {
    const dots = [];
    for (let lat = -65; lat <= 75; lat += 2)
      for (let lng = -170; lng <= 180; lng += 2)
        if (checkLand(lat, lng)) {
          const p = latLngToMercator(lat, lng, baseW, baseH);
          dots.push(p);
        }
    return dots;
  }, []);

  const ms = Math.max(2, 4 / Math.sqrt(zoom));
  const offsets = [-baseW, 0, baseW]; // 3 copies for seamless wrap

  return (
    <svg className="map-svg" viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="og" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={t.oceanTop} /><stop offset="50%" stopColor={t.oceanMid} /><stop offset="100%" stopColor={t.oceanBot} />
        </linearGradient>
      </defs>
      <rect x={-baseW * 2} y={-200} width={baseW * 5} height={baseH + 400} fill="url(#og)" />
      {offsets.map(ox => (
        <g key={ox} transform={`translate(${ox},0)`}>
          {graticulePaths.map((d, i) => <path key={i} d={d} fill="none" stroke={t.graticule} strokeWidth="0.4" />)}
          {continentDots.map((d, i) => <rect key={i} x={d.x - 1} y={d.y - 1} width={2} height={2} fill={t.landFill} rx="0.3" />)}
          {markers.map(loc => (
            <g key={loc.id} className="marker" onClick={() => onLocationClick(loc.id)} transform={`translate(${loc.x},${loc.y})`}>
              <circle r={ms * 2.5} fill="transparent" />
              <circle r={ms * 1.5} fill={loc.category === 'observatory' ? t.observatory : t.station} opacity="0.2" />
              <circle className="marker-ring" r={ms * 1.5} fill="none" stroke={loc.category === 'observatory' ? t.observatory : t.station} strokeWidth={Math.max(0.5, 1 / Math.sqrt(zoom))} />
              <circle r={ms * 0.6} fill={loc.category === 'observatory' ? t.observatory : t.station} />
              {showLabels && <text className="marker-label visible" x={ms * 2} y={ms * 0.5} fontSize={Math.max(6, 9 / Math.sqrt(zoom))}>{loc.name}</text>}
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

// ─── Detail Panel ───
function DetailPanel({ locationId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      setData(MOCK_DETAILS[locationId] || {
        name: locationId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        country: "—", elevation: "—", established: "—", type: "Monitoring Station",
        description: "Station data would load from /data/locations/" + locationId + ".json",
        variables: ["Temperature", "Humidity"], network: "WMO"
      });
      setLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [locationId]);
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        {loading ? (
          <div style={{ padding: 28 }}>
            <div className="loading-bar short" /><div className="loading-bar long" style={{ height: 28, marginBottom: 20 }} />
            <div className="loading-bar medium" /><div className="loading-bar long" /><div className="loading-bar short" />
          </div>
        ) : (<>
          <div className="detail-header">
            <div><div className="detail-category">{data.type}</div><div className="detail-name">{data.name}</div></div>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
          <div className="detail-meta">
            <div className="meta-item"><span className="meta-label">Country</span><span className="meta-value">{data.country}</span></div>
            <div className="meta-item"><span className="meta-label">Elevation</span><span className="meta-value">{data.elevation}</span></div>
            <div className="meta-item"><span className="meta-label">Established</span><span className="meta-value">{data.established}</span></div>
            <div className="meta-item"><span className="meta-label">Network</span><span className="meta-value" style={{ fontSize: 12 }}>{data.network}</span></div>
          </div>
          <div className="detail-divider" />
          <div className="detail-description">{data.description}</div>
          {data.variables && <div className="detail-variables">{data.variables.map(v => <span key={v} className="variable-tag">{v}</span>)}</div>}
        </>)}
      </div>
    </div>
  );
}

// ─── Sources Panel ───
function SourcesPanel({ onClose }) {
  const t = useTheme();
  return (
    <div className="sources-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div className="sources-title">Data Sources & References</div>
        <button className="close-btn" onClick={onClose} style={{ width: 28, height: 28, fontSize: 14 }}>×</button>
      </div>
      <div className="sources-section">
        <div className="sources-section-title">Observational Networks</div>
        <div className="source-item"><div className="source-name">NOAA Global Monitoring Laboratory (GML)</div><div className="source-detail">Baseline atmospheric composition measurements. CO₂, CH₄, N₂O, SF₆, halocarbons.</div><div className="source-url">https://gml.noaa.gov/</div></div>
        <div className="source-item"><div className="source-name">WMO Global Atmosphere Watch (GAW)</div><div className="source-detail">Coordinating network of ~400 stations: atmospheric composition, UV radiation, aerosols.</div><div className="source-url">https://community.wmo.int/en/activity-areas/gaw</div></div>
        <div className="source-item"><div className="source-name">GHCN v4</div><div className="source-detail">Quality-controlled monthly mean temperature data from thousands of surface stations.</div><div className="source-url">https://www.ncei.noaa.gov/products/land-based-station/ghcn</div></div>
      </div>
      <div className="sources-section">
        <div className="sources-section-title">Reanalysis & Gridded Products</div>
        <div className="source-item"><div className="source-name">ERA5 (ECMWF Reanalysis v5)</div><div className="source-detail">Hourly global reanalysis 1940–present, 0.25° grid.</div><div className="source-url">https://cds.climate.copernicus.eu/</div></div>
        <div className="source-item"><div className="source-name">GISTEMP v4</div><div className="source-detail">NASA Goddard surface temperature analysis, 2°×2° grid anomalies.</div><div className="source-url">https://data.giss.nasa.gov/gistemp/</div></div>
      </div>
      <div className="sources-section">
        <div className="sources-section-title">Algorithms & Methodology</div>
        <div className="source-item"><div className="source-name">Pairwise Homogenization Algorithm (PHA)</div><div className="source-detail">Menne & Williams (2009). Homogenization of temperature series via pairwise comparisons. J. Climate 22(7), 1700–1717.</div></div>
        <div className="source-item"><div className="source-name">Time of Observation Bias (TOB)</div><div className="source-detail">Karl et al. (1986). A model to estimate the time of observation bias. J. Climate & Appl. Meteor. 25(2), 145–160.</div></div>
        <div className="source-item"><div className="source-name">USHCNv2.5 Pipeline</div><div className="source-detail">Menne et al. (2009). The U.S. Historical Climatology Network monthly temperature data, v2.5. Bull. Amer. Meteor. Soc. 90(7), 993–1007.</div></div>
      </div>
    </div>
  );
}

// ─── Main App ───
export default function App() {
  const [mode, setMode] = useState('dark');
  const t = themes[mode];
  const [projection, setProjection] = useState("flat");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [showSources, setShowSources] = useState(false);
  const containerRef = useRef(null);
  const MIN_ZOOM = 1, MAX_ZOOM = 8;
  const showLabels = zoom >= 2;

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta * z)));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.addEventListener('wheel', handleWheel, { passive: false });
    return () => { if (el) el.removeEventListener('wheel', handleWheel); };
  }, [handleWheel]);

  const handlePointerDown = (e) => {
    if (e.button !== 0) return;
    setDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setPanStart({ ...pan });
  };
  const handlePointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const speed = projection === 'globe' ? 0.3 : 0.5;
    setPan({ x: panStart.x + dx * speed, y: panStart.y + dy * speed });
  };
  const handlePointerUp = () => setDragging(false);
  useEffect(() => { setPan({ x: 0, y: 0 }); }, [projection]);

  return (
    <ThemeContext.Provider value={t}>
      <style>{buildCSS(t)}</style>
      <div className="app">
        <div className="header">
          <div className="logo">
            <div className="logo-icon" />
            <div><h1>Meridian</h1><span>Global Observatory Network</span></div>
          </div>
          <div className="controls">
            <div className="projection-toggle">
              <button className={`projection-btn ${projection === 'flat' ? 'active' : ''}`} onClick={() => setProjection('flat')}>Mercator</button>
              <button className={`projection-btn ${projection === 'globe' ? 'active' : ''}`} onClick={() => setProjection('globe')}>Globe</button>
            </div>
            <button className="theme-btn" onClick={() => setMode(m => m === 'dark' ? 'light' : 'dark')} title="Toggle theme">{t.switchIcon}</button>
          </div>
        </div>

        <div className="map-container" ref={containerRef}
          onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp}>
          {projection === 'globe'
            ? <GlobeView locations={MOCK_INDEX.locations} zoom={zoom} pan={pan} onLocationClick={setSelectedLocation} showLabels={showLabels} />
            : <FlatMapView locations={MOCK_INDEX.locations} zoom={zoom} pan={pan} onLocationClick={setSelectedLocation} showLabels={showLabels} />
          }
        </div>

        <div className="zoom-controls">
          <button className="zoom-btn" onClick={() => setZoom(z => Math.min(MAX_ZOOM, z * 1.4))} disabled={zoom >= MAX_ZOOM}>+</button>
          <div className="zoom-level">{zoom.toFixed(1)}×</div>
          <button className="zoom-btn" onClick={() => setZoom(z => Math.max(MIN_ZOOM, z / 1.4))} disabled={zoom <= MIN_ZOOM}>−</button>
        </div>

        <div className="coord-display">{MOCK_INDEX.locations.length} stations · {zoom.toFixed(1)}×{showLabels ? ' · labels on' : ''}</div>

        <div className="footer">
          <div className="footer-bar">
            <div className="footer-left">
              <div className="footer-stat"><strong>{MOCK_INDEX.locations.length}</strong> locations indexed</div>
              <div className="footer-stat" style={{ opacity: 0.6 }}>Zoom to <strong>2×</strong> for labels</div>
            </div>
            <div className="footer-right">
              <button className="sources-trigger" onClick={() => setShowSources(s => !s)}>
                {showSources ? 'Close Sources' : 'Data Sources & References'}
              </button>
            </div>
          </div>
        </div>

        {showSources && <SourcesPanel onClose={() => setShowSources(false)} />}
        {selectedLocation && <DetailPanel locationId={selectedLocation} onClose={() => setSelectedLocation(null)} />}
      </div>
    </ThemeContext.Provider>
  );
}
