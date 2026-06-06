// projects.js - Project data loading and rendering
import { trackProjectInteraction } from './analytics.js'
import { isContactProjectLink } from './project-link.js'
import { bindEscapeClosesDialogWhenOpen, setDialogVisibility } from './dialog-helpers.js'
// Detail cache keyed by project id. Bounded in practice by the project count
// in data/projects.json (populated once per render, small N) — no eviction needed.
const projectDetailsById = new Map();
let dialogBootstrapped = false;
// How long to wait for a dialog image before giving up and revealing the
// dialog anyway, so a hung image request never leaves it stuck loading.
const DIALOG_IMAGE_TIMEOUT_MS = 8000;

/**
 * Strip HTML to plain text robustly via a detached element's textContent,
 * instead of a regex that mishandles edge cases (entities, malformed tags).
 */
export function htmlToPlainText(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').trim();
}

const PROJECTS_LOAD_FAILURE_TEXT =
  'Projects could not be loaded. Check your connection and refresh the page.';

/**
 * Visible on any section: banner above main content when project JSON failed.
 */
export function showProjectsLoadSiteBanner() {
  const wrap = document.getElementById('contentWrapper');
  if (!wrap) return;
  let el = document.getElementById('gvpProjectsLoadBanner');
  if (!el) {
    el = document.createElement('p');
    el.id = 'gvpProjectsLoadBanner';
    el.className = 'projects-load-error projects-load-error--site';
    el.setAttribute('role', 'alert');
    wrap.insertBefore(el, wrap.firstChild);
  }
  el.textContent = PROJECTS_LOAD_FAILURE_TEXT;
  el.hidden = false;
}

export async function loadProjects(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (!contentType.includes('application/json')) {
      throw new Error('Projects response was not JSON')
    }
    const data = raw ? JSON.parse(raw) : {}
    // Legacy `playgroundBeta` rows (if any old JSON still ships them) are
    // folded back into `playground` so the single-section view captures them.
    const playground = [
      ...(Array.isArray(data.playground) ? data.playground : []),
      ...(Array.isArray(data.playgroundBeta) ? data.playgroundBeta : [])
    ]
    return {
      playground,
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
export function renderProjectsSectionError(containerId, sectionId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const sections = sectionId
    ? [container.querySelector(`#${sectionId}`)].filter(Boolean)
    : [...container.querySelectorAll('section')];

  sections.forEach((section) => {
    const header = section.querySelector('h2, h3');
    const headerHTML = header ? header.outerHTML : '';

    section.innerHTML = headerHTML;

    const p = document.createElement('p');
    p.className = 'projects-load-error';
    p.setAttribute('role', 'alert');
    p.textContent = PROJECTS_LOAD_FAILURE_TEXT;
    section.appendChild(p);
  });
}

export function renderProjects(containerId, projects, sectionId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const section = sectionId
    ? container.querySelector(`#${sectionId}`)
    : container.querySelector('section');
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
    setDialogVisibility(dialog, false);
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
    const section = window.location.hash === '#portfolio' ? 'portfolio' : window.location.hash === '#labs' ? 'labs' : 'home'
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
    if (titleEl) titleEl.textContent = data.title || ''
    if (descEl) {
      const htmlDesc = (data.description || '').trim()
      if (htmlDesc) {
        descEl.innerHTML = htmlDesc
        descEl.hidden = false
      } else {
        descEl.replaceChildren()
        descEl.hidden = true
      }
    }

    if (techEl) techEl.replaceChildren();
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
      if (isContactProjectLink(data.link)) {
        linkEl.removeAttribute('target');
        linkEl.removeAttribute('rel');
      } else {
        linkEl.target = '_blank';
        linkEl.rel = 'noopener noreferrer';
      }
    } else {
      actionsEl.hidden = true;
      linkEl.removeAttribute('href');
    }

    setDialogVisibility(dialog, true);
    document.body.classList.add('project-dialog-open');
    window.dispatchEvent(new CustomEvent('gvp:site-chat-collapse'));
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

  // Portfolio cards live in #portfolioContent, Labs cards in #labsContent.
  // Bind the same delegated handlers to each container.
  const onCardKeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.project');
    if (!card) return;
    if (e.key === ' ') e.preventDefault();
    const id = card.getAttribute('data-project-id');
    if (id) openDialog(id);
  };
  ['portfolioContent', 'labsContent'].forEach((wrapId) => {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.addEventListener('click', onActivateProject);
    wrap.addEventListener('keydown', onCardKeydown);
  });

  closeBtn?.addEventListener('click', closeDialog);
  backdrop?.addEventListener('click', closeDialog);
  linkEl?.addEventListener('click', (e) => {
    const id = dialog.getAttribute('data-project-id') || ''
    const data = projectDetailsById.get(id)
    const section = window.location.hash === '#portfolio' ? 'portfolio' : window.location.hash === '#labs' ? 'labs' : 'home'
    trackProjectInteraction('open_link', id, section)
    if (data && isContactProjectLink(data.link)) {
      e.preventDefault()
      closeDialog()
      import('./contact.js').then(({ openContactDialog }) => {
        openContactDialog(data.contactPrefill)
      })
    }
  })

  bindEscapeClosesDialogWhenOpen(dialog, closeDialog);
}

function createProjectCard(project) {
  const id = project.id || '';
  const cardDescription =
    project.cardDescription ||
    (project.description ? htmlToPlainText(project.description) : '');

  if (id) {
    const descriptionPlain = project.description
      ? htmlToPlainText(project.description)
      : '';
    projectDetailsById.set(id, {
      title: project.title || '',
      description: project.description || '',
      descriptionPlain,
      tech: Array.isArray(project.tech) ? project.tech : [],
      link: project.link || '',
      linkText: project.linkText || '',
      contactPrefill: project.contactPrefill || null,
      image: project.image || '',
      imageAlt: project.imageAlt || project.title || ''
    });
  }

  const div = document.createElement('div');
  div.className = 'project';
  if (project.featured) div.classList.add('project--featured');
  div.setAttribute('data-project-id', id);
  div.setAttribute('data-project-title', project.title || '');
  div.setAttribute('data-project-description', cardDescription);
  div.setAttribute('role', 'button');
  div.setAttribute('tabindex', '0');
  const labelSuffix = project.label ? ` (${project.label})` : '';
  div.setAttribute(
    'aria-label',
    `${project.title || 'Project'}${labelSuffix} — open details${project.link ? ' and link' : ''}`
  );

  if (project.image) {
    const img = document.createElement('img');
    img.src = project.image;
    img.alt = project.imageAlt || project.title || '';
    img.loading = 'eager';
    img.decoding = 'async';
    div.appendChild(img);
  }

  const head = document.createElement('div');
  head.className = 'project__head';
  const title = document.createElement('h4');
  title.textContent = project.title || '';
  head.appendChild(title);
  if (project.label) {
    const badge = document.createElement('span');
    badge.className = 'project__label';
    badge.textContent = project.label;
    head.appendChild(badge);
  }
  div.appendChild(head);

  if (project.role) {
    const role = document.createElement('p');
    role.className = 'project__role';
    role.textContent = project.role;
    div.appendChild(role);
  }

  const isStructured = !!(project.problem || project.work || project.outcome);

  if (isStructured) {
    ['problem', 'work', 'outcome'].forEach((key) => {
      if (!project[key]) return;
      const p = document.createElement('p');
      p.className = `project__${key}`;
      p.textContent = project[key];
      div.appendChild(p);
    });

    const tech = Array.isArray(project.tech) ? project.tech : [];
    if (tech.length) {
      const tags = document.createElement('div');
      tags.className = 'project__tags';
      tech.forEach((t) => {
        const tag = document.createElement('span');
        tag.className = 'project__tag';
        tag.textContent = t;
        tags.appendChild(tag);
      });
      div.appendChild(tags);
    }
  } else if (cardDescription) {
    const p = document.createElement('p');
    p.textContent = cardDescription;
    div.appendChild(p);
  }

  return div;
}
