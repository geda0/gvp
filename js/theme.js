// theme.js - Theme system (space | garden | studio) + auto pref following system color-scheme
const STORAGE_KEY = 'gvp-theme';
const THEMES = ['space', 'garden', 'studio'];
const PREFS = ['space', 'garden', 'studio', 'auto'];

// Garden theme gradient (matches styles.css --bg-primary)
const GARDEN_GRADIENT = 'linear-gradient(180deg, #7eb0c8 0%, #a8cfae 48%, #4d7a58 100%)';

// Keep in sync with --bg-space-gradient in styles.css (mirrored + toned down)
const SPACE_SCENE_GRADIENT =
  'radial-gradient(ellipse 100% 75% at 82% 6%, rgba(170, 92, 110, 0.075) 0%, transparent 50%), ' +
  'radial-gradient(ellipse 95% 70% at 18% 90%, rgba(78, 110, 175, 0.09) 0%, transparent 52%), ' +
  'radial-gradient(ellipse 120% 85% at 50% -5%, #1a2238 0%, #131a2b 40%, #0e1422 65%, #0c111c 100%)';

// Keep in sync with --bg-studio-gradient in styles.css
const STUDIO_SCENE_GRADIENT =
  'radial-gradient(ellipse 80% 60% at 14% 12%, rgba(212, 188, 156, 0.32) 0%, transparent 55%), ' +
  'radial-gradient(ellipse 70% 55% at 88% 86%, rgba(170, 158, 188, 0.22) 0%, transparent 60%), ' +
  'linear-gradient(180deg, #f4ede0 0%, #ece3d2 60%, #e2d6bf 100%)';

// Softer cross-fade: lower peak opacity + longer ease (sync #sceneTransitionOverlay in styles.css)
const SCENE_OVERLAY_TRANSITION = 'opacity 0.78s cubic-bezier(0.33, 0, 0.18, 1)';
const SCENE_OVERLAY_MAX_OPACITY = 0.86;

let isTransitioning = false;
let systemMql = null;
let systemMqlListener = null;

function backgroundForTheme(theme) {
  if (theme === 'garden') return GARDEN_GRADIENT;
  if (theme === 'studio') return STUDIO_SCENE_GRADIENT;
  return SPACE_SCENE_GRADIENT;
}

function resolveAuto() {
  // Light → studio (paper, low distraction). Dark → space.
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  return mql.matches ? 'space' : 'studio';
}

export function getThemePreference() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (PREFS.includes(stored)) return stored;
  return 'auto';
}

export function getTheme() {
  const pref = getThemePreference();
  return pref === 'auto' ? resolveAuto() : pref;
}

function applyResolvedTheme(theme) {
  if (!THEMES.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function setThemePreference(pref) {
  if (!PREFS.includes(pref)) return;
  localStorage.setItem(STORAGE_KEY, pref);
  document.documentElement.setAttribute('data-theme-pref', pref);
  applyResolvedTheme(pref === 'auto' ? resolveAuto() : pref);
  ensureSystemListener();
}

// Back-compat alias used by older callers (treats theme name as preference)
export function setTheme(theme) {
  setThemePreference(theme);
}

function ensureSystemListener() {
  const pref = getThemePreference();
  if (pref === 'auto') {
    if (systemMql) return;
    systemMql = window.matchMedia('(prefers-color-scheme: dark)');
    systemMqlListener = () => {
      if (getThemePreference() !== 'auto') return;
      applyResolvedTheme(resolveAuto());
    };
    systemMql.addEventListener('change', systemMqlListener);
  } else if (systemMql && systemMqlListener) {
    systemMql.removeEventListener('change', systemMqlListener);
    systemMql = null;
    systemMqlListener = null;
  }
}

export function initTheme() {
  const pref = getThemePreference();
  const resolved = pref === 'auto' ? resolveAuto() : pref;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', pref);
  ensureSystemListener();
}

export function transitionToPreference(pref) {
  if (!PREFS.includes(pref)) return;
  const target = pref === 'auto' ? resolveAuto() : pref;
  _transitionTo(pref, target);
}

// Back-compat: callers that pass a concrete theme name get the same animation path.
export function transitionToTheme(theme) {
  if (!PREFS.includes(theme)) return;
  transitionToPreference(theme);
}

function _transitionTo(pref, targetTheme) {
  if (isTransitioning) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    setThemePreference(pref);
    return;
  }

  const overlay = document.getElementById('sceneTransitionOverlay');
  if (!overlay) {
    setThemePreference(pref);
    return;
  }

  isTransitioning = true;
  overlay.classList.add('transitioning');

  overlay.style.background = backgroundForTheme(targetTheme);
  overlay.style.transition = SCENE_OVERLAY_TRANSITION;

  const TRANSITION_TIMEOUT = 3200;
  let timeoutId = setTimeout(() => {
    isTransitioning = false;
    overlay.classList.remove('transitioning');
    overlay.style.opacity = '0';
    if (getTheme() !== targetTheme || getThemePreference() !== pref) {
      setThemePreference(pref);
    }
  }, TRANSITION_TIMEOUT);

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    overlay.classList.remove('transitioning');
    isTransitioning = false;
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.style.opacity = String(SCENE_OVERLAY_MAX_OPACITY);
    });
  });

  const onFirstTransitionEnd = (event) => {
    if (event.propertyName !== 'opacity') return
    overlay.removeEventListener('transitionend', onFirstTransitionEnd);

    setThemePreference(pref);

    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      cleanup();
    }, 1000);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.style.opacity = '0';
      });
    });

    const onSecondTransitionEnd = (event) => {
      if (event.propertyName !== 'opacity') return
      overlay.removeEventListener('transitionend', onSecondTransitionEnd);
      cleanup();
    };

    overlay.addEventListener('transitionend', onSecondTransitionEnd);
  };

  overlay.addEventListener('transitionend', onFirstTransitionEnd);
}
