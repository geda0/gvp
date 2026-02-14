// projects.js - Project data loading and rendering
export async function loadProjects(url) {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    console.error('Failed to load projects:', error);
    return { playground: [], portfolio: [] };
  }
}

export function renderProjects(containerId, projects) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const section = container.querySelector('section');
  if (!section) return;

  // Keep the header (h2/h3) element
  const header = section.querySelector('h2, h3');
  const headerHTML = header ? header.outerHTML : '';

  // Clear section and restore header
  section.innerHTML = headerHTML;

  // Render each project
  projects.forEach(project => {
    section.appendChild(createProjectCard(project));
  });
}

function createProjectCard(project) {
  const div = document.createElement('div');
  div.className = 'project';
  div.setAttribute('data-project-id', project.id || '');
  div.setAttribute('data-project-title', project.title || '');
  const desc = project.description ? project.description.replace(/<[^>]+>/g, '').trim() : '';
  div.setAttribute('data-project-description', desc);

  let html = '';

  if (project.image) {
    html += `<img src="${project.image}" alt="${project.imageAlt || project.title}" loading="lazy" width="299">`;
  }

  html += `<h4>${project.title}</h4>`;

  if (project.description) {
    html += `<p>${project.description}</p>`;
  }

  if (project.link) {
    html += `<a href="${project.link}" target="_blank">${project.linkText || project.link}</a>`;
  }

  div.innerHTML = html;
  return div;
}
