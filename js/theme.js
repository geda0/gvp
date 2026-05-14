// theme.js - Theme system (space | garden)
const STORAGE_KEY = 'gvp-theme';
const THEMES = ['space', 'garden'];

// Garden theme gradient (matches styles.css --bg-primary)
const GARDEN_GRADIENT = 'linear-gradient(180deg, #7eb0c8 0%, #a8cfae 48%, #4d7a58 100%)';

// Must match #sceneTransitionOverlay in styles.css (duration + easing)
const SCENE_OVERLAY_TRANSITION = 'opacity 0.52s cubic-bezier(0.4, 0, 0.2, 1)';

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
  
  // Set overlay background to target theme
  overlay.style.background = theme === 'garden' ? GARDEN_GRADIENT : '#0a0e14';
  
  // Ensure overlay is ready (inline wins over stylesheet; keep in sync with CSS)
  overlay.style.transition = SCENE_OVERLAY_TRANSITION;

  // Timeout fallback: reset flag if transitions don't complete
  // 2.5s = enough for both fades (~0.52s each) + buffer
  const TRANSITION_TIMEOUT = 2500;
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
      overlay.style.opacity = '1';
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
