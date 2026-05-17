// theme.js - Theme system (space | garden)
const STORAGE_KEY = 'gvp-theme';
const THEMES = ['space', 'garden'];

// Garden theme gradient (matches styles.css --bg-primary)
const GARDEN_GRADIENT = 'linear-gradient(180deg, #7eb0c8 0%, #a8cfae 48%, #4d7a58 100%)';

// Keep in sync with --bg-space-gradient in styles.css
const SPACE_SCENE_GRADIENT =
  'radial-gradient(ellipse 95% 70% at 18% 8%, rgba(190, 78, 102, 0.14) 0%, transparent 48%), ' +
  'radial-gradient(ellipse 90% 65% at 82% 88%, rgba(58, 98, 178, 0.16) 0%, transparent 50%), ' +
  'radial-gradient(ellipse 110% 80% at 50% -5%, #1c2a4a 0%, #121a32 38%, #0a1020 62%, #06080f 100%)';

// Softer cross-fade: lower peak opacity + longer ease (sync #sceneTransitionOverlay in styles.css)
const SCENE_OVERLAY_TRANSITION = 'opacity 0.78s cubic-bezier(0.33, 0, 0.18, 1)';
const SCENE_OVERLAY_MAX_OPACITY = 0.86;

let isTransitioning = false;

export function getTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (THEMES.includes(stored)) return stored;
  return 'space';
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEY, theme);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function initTheme() {
  const theme = getTheme();
  document.documentElement.setAttribute('data-theme', theme);
}

export function transitionToTheme(theme) {
  if (!THEMES.includes(theme)) return;
  
  // Check if already transitioning - debounce rapid clicks
  if (isTransitioning) return;
  
  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    setTheme(theme);
    return;
  }
  
  const overlay = document.getElementById('sceneTransitionOverlay');
  if (!overlay) {
    // Fallback if overlay doesn't exist
    setTheme(theme);
    return;
  }
  
  isTransitioning = true;
  overlay.classList.add('transitioning');
  
  // Set overlay background to target theme (gradient eases the jump vs flat fill)
  overlay.style.background = theme === 'garden' ? GARDEN_GRADIENT : SPACE_SCENE_GRADIENT;
  
  // Ensure overlay is ready (inline wins over stylesheet; keep in sync with CSS)
  overlay.style.transition = SCENE_OVERLAY_TRANSITION;

  // Timeout fallback: reset flag if transitions don't complete
  const TRANSITION_TIMEOUT = 3200;
  let timeoutId = setTimeout(() => {
    // Emergency reset: ensure flag is cleared and overlay is reset
    isTransitioning = false;
    overlay.classList.remove('transitioning');
    overlay.style.opacity = '0';
    // Ensure theme is set even if transitions failed
    const currentTheme = getTheme();
    if (currentTheme !== theme) {
      setTheme(theme);
    }
  }, TRANSITION_TIMEOUT);
  
  // Cleanup function to clear timeout and reset state
  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    overlay.classList.remove('transitioning');
    isTransitioning = false;
  };
  
  // Fade in overlay
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.style.opacity = String(SCENE_OVERLAY_MAX_OPACITY);
    });
  });
  
  // Handle first transition end (overlay fade-in complete)
  const onFirstTransitionEnd = (event) => {
    if (event.propertyName !== 'opacity') return
    overlay.removeEventListener('transitionend', onFirstTransitionEnd);
    
    // Now switch the actual theme
    setTheme(theme);
    
    // Reset timeout for second transition (shorter timeout since we're halfway done)
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      // If second transition doesn't fire, cleanup after 1s
      cleanup();
    }, 1000);
    
    // Fade out overlay
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.style.opacity = '0';
      });
    });
    
    // Handle second transition end (overlay fade-out complete)
    const onSecondTransitionEnd = (event) => {
      if (event.propertyName !== 'opacity') return
      overlay.removeEventListener('transitionend', onSecondTransitionEnd);
      cleanup();
    };
    
    overlay.addEventListener('transitionend', onSecondTransitionEnd);
  };
  
  overlay.addEventListener('transitionend', onFirstTransitionEnd);
}
