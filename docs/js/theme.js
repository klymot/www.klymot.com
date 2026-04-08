const STORAGE_KEY = 'klymot-theme';
const VALID_THEMES = ['dark', 'light'];

let currentTheme = 'dark';
const listeners = [];

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  currentTheme = VALID_THEMES.includes(saved) ? saved : 'dark';
  applyTheme(currentTheme);
}

export function getTheme() {
  return currentTheme;
}

export function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
  localStorage.setItem(STORAGE_KEY, currentTheme);
  listeners.forEach(fn => fn(currentTheme));
}

export function onThemeChange(fn) {
  listeners.push(fn);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
