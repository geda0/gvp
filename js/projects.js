// projects.js - Project data loading and rendering
import { trackProjectInteraction } from './analytics.js'
const projectDetailsById = new Map();
let dialogBootstrapped = false;

export async function loadProjects(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = await response.json()
    return {
      playground: Array.isArray(data.playground) ? data.playground : [],
      portfolio: Array.isArray(data.portfolio) ? data.portfolio : [],
      loadFailed: false
    }
  } catch (error) {
    console.error('Failed to load projects:', error);
    return { playground: [], portfolio: [], loadFailed: true };
  }
}

/**
 * Show a visible error when project JSON failed to load (network or parse).
 */
export function renderProjectsSectionError(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const section = container.querySelector('section');
  if (!section) return;

  const header = section.querySelector('h2, h3');
  const headerHTML = header ? header.outerHTML : '';

  section.innerHTML = headerHTML;

  const p = document.createElement('p');
  p.className = 'projects-load-error';
  p.setAttribute('role', 'alert');
  p.textContent =
    'Projects could not be loaded. Check your connection and refresh the page.';
  section.appendChild(p);
}

export function renderProjects(containerId, projects) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const section = container.querySelector('section');
  if (!section) return;

  const header = section.querySelector('h2, h3');
  const headerHTML = header ? header.outerHTML : '';

  section.innerHTML = headerHTML;

  projects.forEach((project) => {
    section.appendChild(createProjectCard(project));
  });
}

/**
 * Bind dialog + delegated clicks once (after project cards exist).
 */
export function initProjectDetailDialog() {
  if (dialogBootstrapped) return;
  dialogBootstrapped = true;

  const dialog = document.getElementById('projectDialog');
  if (!dialog) return;

  const titleEl = document.getElementById('projectDialogTitle');
  const descEl = document.getElementById('projectDialogDescription');
  const techWrap = document.getElementById('projectDialogTechWrap');
  const techEl = document.getElementById('projectDialogTech');
  const actionsEl = document.getElementById('projectDialogActions');
  const linkEl = document.getElementById('projectDialogLink');
  const mediaWrap = document.getElementById('projectDialogMediaWrap');
  const imageEl = document.getElementById('projectDialogImage');
  const closeBtn = dialog.querySelector('.project-dialog__close');
  const backdrop = dialog.querySelector('.project-dialog__backdrop');
  let lastFocus = null;

  function closeDialog() {
    if (imageEl) {
      imageEl.removeAttribute('src');
      imageEl.alt = '';
      imageEl.classList.remove('project-dialog__image--loading');
    }
    if (mediaWrap) mediaWrap.hidden = true;
    dialog.hidden = true;
    dialog.setAttribute('aria-hidden', 'true');
    dialog.removeAttribute('data-project-id')
    document.body.classList.remove('project-dialog-open');
    window.dispatchEvent(new CustomEvent('projectdialogclose'));
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
  }

  function openDialog(id) {
    const data = projectDetailsById.get(id);
    if (!data) return;
    dialog.setAttribute('data-project-id', id)
    const section = window.location.hash === '#portfolio'
      ? 'portfolio'
      : window.location.hash === '#playground'
        ? 'playground'
        : 'home'
    trackProjectInteraction('open_details', id, section)

    lastFocus = document.activeElement;
    if (data.image && imageEl && mediaWrap) {
      imageEl.alt = data.imageAlt || data.title || '';
      mediaWrap.hidden = false;
      imageEl.classList.add('project-dialog__image--loading');
      const reveal = () => {
        imageEl.classList.remove('project-dialog__image--loading');
      };
      imageEl.addEventListener('load', reveal, { once: true });
      imageEl.addEventListener('error', reveal, { once: true });
      imageEl.src = data.image;
      if (imageEl.complete && imageEl.naturalWidth > 0) {
        reveal();
      }
    } else if (mediaWrap && imageEl) {
      imageEl.removeAttribute('src');
      imageEl.alt = '';
      imageEl.classList.remove('project-dialog__image--loading');
      mediaWrap.hidden = true;
    }
    titleEl.textContent = data.title || '';
    descEl.innerHTML = data.description || '';
    descEl.hidden = !data.description;

    techEl.replaceChildren();
    const tech = data.tech || [];
    if (tech.length && techWrap) {
      techWrap.hidden = false;
      tech.forEach((t) => {
        const li = document.createElement('li');
        li.className = 'project-dialog__chip';
        li.textContent = t;
        techEl.appendChild(li);
      });
    } else if (techWrap) {
      techWrap.hidden = true;
    }

    if (data.link) {
      actionsEl.hidden = false;
      linkEl.href = data.link;
      linkEl.textContent = data.linkText || 'Open link';
    } else {
      actionsEl.hidden = true;
      linkEl.removeAttribute('href');
    }

    dialog.hidden = false;
    dialog.setAttribute('aria-hidden', 'false');
    document.body.classList.add('project-dialog-open');
    window.dispatchEvent(
      new CustomEvent('projectdialogopen', {
        detail: {
          projectId: id,
          title: data.title || '',
          projectDescription: data.descriptionPlain || ''
        }
      })
    );
    closeBtn?.focus();
  }

  function onActivateProject(e) {
    const card = e.target.closest('.project');
    if (!card) return;
    const id = card.getAttribute('data-project-id');
    if (!id) return;
    openDialog(id);
  }

  ['playgroundContent', 'portfolioContent'].forEach((cid) => {
    const wrap = document.getElementById(cid);
    if (!wrap) return;
    wrap.addEventListener('click', onActivateProject);
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.project');
      if (!card || !wrap.contains(card)) return;
      if (e.key === ' ') e.preventDefault();
      const id = card.getAttribute('data-project-id');
      if (id) openDialog(id);
    });
  });

  closeBtn?.addEventListener('click', closeDialog);
  backdrop?.addEventListener('click', closeDialog);
  linkEl?.addEventListener('click', () => {
    const id = dialog.getAttribute('data-project-id') || ''
    const section = window.location.hash === '#portfolio'
      ? 'portfolio'
      : window.location.hash === '#playground'
        ? 'playground'
        : 'home'
    trackProjectInteraction('open_link', id, section)
  })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dialog.hidden) return;
    e.preventDefault();
    closeDialog();
  });
}

function createProjectCard(project) {
  const id = project.id || '';
  const cardDescription =
    project.cardDescription ||
    (project.description ? project.description.replace(/<[^>]+>/g, '').trim() : '');

  if (id) {
    const descriptionPlain = project.description
      ? project.description.replace(/<[^>]+>/g, '').trim()
      : '';
    projectDetailsById.set(id, {
      title: project.title || '',
      description: project.description || '',
      descriptionPlain,
      tech: Array.isArray(project.tech) ? project.tech : [],
      link: project.link || '',
      linkText: project.linkText || '',
      image: project.image || '',
      imageAlt: project.imageAlt || project.title || ''
    });
  }

  const div = document.createElement('div');
  div.className = 'project';
  div.setAttribute('data-project-id', id);
  div.setAttribute('data-project-title', project.title || '');
  div.setAttribute('data-project-description', cardDescription);
  div.setAttribute('role', 'button');
  div.setAttribute('tabindex', '0');
  div.setAttribute(
    'aria-label',
    `${project.title || 'Project'} — open details${project.link ? ' and link' : ''}`
  );

  if (project.image) {
    const img = document.createElement('img');
    img.src = project.image;
    img.alt = project.imageAlt || project.title || '';
    img.loading = 'eager';
    img.decoding = 'async';
    div.appendChild(img);
  }

  const title = document.createElement('h4');
  title.textContent = project.title || '';
  div.appendChild(title);

  if (cardDescription) {
    const p = document.createElement('p');
    p.textContent = cardDescription;
    div.appendChild(p);
  }

  const hint = document.createElement('p');
  hint.className = 'project__hint';
  hint.textContent = `View details${project.link ? ' · link inside' : ''}`;
  div.appendChild(hint);

  return div;
}
