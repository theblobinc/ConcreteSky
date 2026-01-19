const STORAGE_KEY = 'bsky.theme.v1';

export const THEME_PREF_DEFAULTS = {
  // 'system' = follow OS/browser prefers-reduced-motion.
  motion: 'system', // 'system' | 'reduce' | 'full'
  density: 'compact', // 'compact' | 'comfortable'
  fontSize: 'md', // 'sm' | 'md' | 'lg'
};

export const THEME_PRESETS = {
  dark: {
    '--bsky-fg': '#ffffff',
    '--bsky-muted-fg': 'rgba(255,255,255,.75)',
    '--bsky-bg': '#070707',
    '--bsky-surface': '#0b0b0b',
    '--bsky-surface-2': '#060606',
    '--bsky-border': '#333333',
    '--bsky-border-soft': '#222222',
    '--bsky-border-subtle': '#111111',
    '--bsky-btn-bg': '#111111',
    '--bsky-input-bg': '#000000',
    '--bsky-danger-bg': '#2a0c0c',
    '--bsky-danger-border': '#5a1c1c',
    '--bsky-success-bg': '#0c2a14',
    '--bsky-success-border': '#1c5a2c',
  },
  light: {
    '--bsky-fg': '#111111',
    '--bsky-muted-fg': 'rgba(0,0,0,.65)',
    '--bsky-bg': '#f7f7f7',
    '--bsky-surface': '#ffffff',
    '--bsky-surface-2': '#f3f3f3',
    '--bsky-border': '#d0d0d0',
    '--bsky-border-soft': '#e4e4e4',
    '--bsky-border-subtle': '#efefef',
    '--bsky-btn-bg': '#ffffff',
    '--bsky-input-bg': '#ffffff',
    '--bsky-danger-bg': '#ffecec',
    '--bsky-danger-border': '#ffb4b4',
    '--bsky-success-bg': '#e9fff1',
    '--bsky-success-border': '#88d1a2',
  },
};

export const THEME_LAYOUT_DEFAULTS = {
  '--bsky-radius': '0px',
  '--bsky-grid-gutter': '0px',
  '--bsky-panel-pad': '0px',
  '--bsky-panel-gap': '0px',
  '--bsky-panel-control-gap': '8px',
  '--bsky-panel-pad-dense': '0px',
  '--bsky-panel-gap-dense': '0px',
  '--bsky-panel-control-gap-dense': '6px',
};

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
}

function normalizeTheme(raw) {
  const base = (raw && typeof raw === 'object') ? raw : {};
  const preset = (base.preset === 'light' || base.preset === 'dark') ? base.preset : 'dark';
  const varsRaw = (base.vars && typeof base.vars === 'object') ? base.vars : {};

  const prefsRaw = (base.prefs && typeof base.prefs === 'object') ? base.prefs : {};
  const prefs = {
    ...THEME_PREF_DEFAULTS,
  };

  {
    const motion = String(prefsRaw.motion || '').trim();
    if (motion === 'system' || motion === 'reduce' || motion === 'full') prefs.motion = motion;
  }
  {
    const density = String(prefsRaw.density || '').trim();
    if (density === 'compact' || density === 'comfortable') prefs.density = density;
  }
  {
    const fontSize = String(prefsRaw.fontSize || '').trim();
    if (fontSize === 'sm' || fontSize === 'md' || fontSize === 'lg') prefs.fontSize = fontSize;
  }

  const vars = {};
  for (const [k, v] of Object.entries(varsRaw)) {
    const key = String(k || '').trim();
    if (!key.startsWith('--')) continue;
    const val = String(v ?? '').trim();
    if (!val) continue;
    vars[key] = val;
  }

  return { preset, vars, prefs };
}

export function loadThemeFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeTheme(safeJsonParse(raw));
  } catch {
    return null;
  }
}

export function loadThemeFromInjected() {
  try {
    const injected = window.BSKY?.siteTheme;
    if (!injected || typeof injected !== 'object') return null;
    return normalizeTheme(injected);
  } catch {
    return null;
  }
}

export function saveThemeToStorage(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    return true;
  } catch {
    return false;
  }
}

export function clearThemeStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function applyThemeVars(vars, { target } = {}) {
  const el = target || document.documentElement;
  if (!el || !el.style) return;

  const obj = (vars && typeof vars === 'object') ? vars : {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || '').trim();
    if (!key.startsWith('--')) continue;
    const val = String(v ?? '').trim();
    if (!val) {
      try { el.style.removeProperty(key); } catch {}
      continue;
    }
    try { el.style.setProperty(key, val); } catch {}
  }
}

export function removeThemeVars(keys, { target } = {}) {
  const el = target || document.documentElement;
  if (!el || !el.style) return;
  for (const k of (Array.isArray(keys) ? keys : [])) {
    const key = String(k || '').trim();
    if (!key.startsWith('--')) continue;
    try { el.style.removeProperty(key); } catch {}
  }
}

export function getPresetVars(preset) {
  const p = (preset === 'light' || preset === 'dark') ? preset : 'dark';
  return { ...THEME_PRESETS[p], ...THEME_LAYOUT_DEFAULTS };
}

function applyThemePrefs(prefs) {
  const p = (prefs && typeof prefs === 'object') ? prefs : THEME_PREF_DEFAULTS;

  // Motion
  // - system: don't force; let CSS/JS fallbacks decide.
  // - reduce: force no smooth scrolling and treat motion as disabled.
  // - full: force smooth scrolling even if the OS requests reduced motion.
  if (p.motion === 'reduce') {
    applyThemeVars({ '--bsky-scroll-behavior': 'auto', '--bsky-motion': '0', '--bsky-spinner-animation': 'none' });
  } else if (p.motion === 'full') {
    applyThemeVars({ '--bsky-scroll-behavior': 'smooth', '--bsky-motion': '1' });
    removeThemeVars(['--bsky-spinner-animation']);
  } else {
    removeThemeVars(['--bsky-scroll-behavior', '--bsky-motion', '--bsky-spinner-animation']);
  }

  // Density (panels are generally rendered with <bsky-panel-shell dense>).
  // Keep current layout as default (compact), and only opt into roomier spacing.
  if (p.density === 'comfortable') {
    applyThemeVars({
      '--bsky-panel-pad-dense': '10px',
      '--bsky-panel-gap-dense': '10px',
      '--bsky-panel-control-gap-dense': '8px',
    });
  } else {
    removeThemeVars(['--bsky-panel-pad-dense', '--bsky-panel-gap-dense', '--bsky-panel-control-gap-dense']);
  }

  // Font size
  if (p.fontSize === 'sm') {
    applyThemeVars({ '--bsky-font-size': '14px' });
  } else if (p.fontSize === 'lg') {
    applyThemeVars({ '--bsky-font-size': '18px' });
  } else {
    removeThemeVars(['--bsky-font-size']);
  }
}

export function applyTheme(theme) {
  const t = normalizeTheme(theme);
  // Apply preset baseline first, then any overrides.
  applyThemeVars(getPresetVars(t.preset));
  applyThemePrefs(t.prefs);
  applyThemeVars(t.vars);
}

export function setThemeAndPersist(theme) {
  const t = normalizeTheme(theme);
  applyTheme(t);
  saveThemeToStorage(t);
  return t;
}

export function resetThemeToDefaults(preset = 'dark') {
  const p = (preset === 'light' || preset === 'dark') ? preset : 'dark';
  clearThemeStorage();
  applyThemeVars(getPresetVars(p));
  // Also clear any forced prefs.
  try {
    removeThemeVars(['--bsky-scroll-behavior', '--bsky-motion', '--bsky-font-size', '--bsky-panel-pad-dense', '--bsky-panel-gap-dense', '--bsky-panel-control-gap-dense']);
  } catch {
    // ignore
  }
  return { preset: p, vars: {}, prefs: { ...THEME_PREF_DEFAULTS } };
}

// Bootstrap: apply saved theme as early as possible.
try {
  // 1) Apply site-wide theme injected by PHP (server-side defaults).
  const injected = loadThemeFromInjected();
  if (injected) applyTheme(injected);

  // 2) Apply per-browser overrides (localStorage) unless this page opts out.
  const disableLocal = !!window.BSKY?.themeAdmin?.disableLocalStorage;
  if (!disableLocal) {
    const saved = loadThemeFromStorage();
    if (saved) applyTheme(saved);
  }
} catch {
  // ignore
}
