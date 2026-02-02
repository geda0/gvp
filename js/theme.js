// theme.js - Theme system (space | garden)
const STORAGE_KEY = 'gvp-theme';
const THEMES = ['space', 'garden'];

// Garden theme gradient (matches styles.css)
const GARDEN_GRADIENT = 'linear-gradient(180deg, #87ceeb 0%, #b8e0b8 50%, #6b8e6b 100%)';

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
  overlay.style.background = theme === 'garden' ? GARDEN_GRADIENT : '#000000';
  
  // Ensure overlay is ready
  overlay.style.transition = 'opacity 0.6s ease';
  
  // Fade in overlay
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
    });
  });
  
  // Handle first transition end (overlay fade-in complete)
  const onFirstTransitionEnd = () => {
    overlay.removeEventListener('transitionend', onFirstTransitionEnd);
    
    // Now switch the actual theme
    setTheme(theme);
    
    // Fade out overlay
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.style.opacity = '0';
      });
    });
    
    // Handle second transition end (overlay fade-out complete)
    const onSecondTransitionEnd = () => {
      overlay.removeEventListener('transitionend', onSecondTransitionEnd);
      overlay.classList.remove('transitioning');
      isTransitioning = false;
    };
    
    overlay.addEventListener('transitionend', onSecondTransitionEnd, { once: true });
  };
  
  overlay.addEventListener('transitionend', onFirstTransitionEnd, { once: true });
}
