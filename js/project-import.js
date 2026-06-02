export function slugifyProjectId(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const STRING_FIELDS = ['id', 'title', 'cardDescription', 'description', 'image', 'imageAlt', 'link', 'linkText', 'role']

function _findInvalidField(obj) {
  if (!obj || typeof obj !== 'object') return 'object'
  for (const key of STRING_FIELDS) {
    if (typeof obj[key] !== 'string' || obj[key].length === 0) return key
  }
  if (typeof obj.hidden !== 'boolean') return 'hidden'
  if (!Array.isArray(obj.tech) || obj.tech.length === 0) return 'tech'
  if (!obj.tech.every(t => typeof t === 'string')) return 'tech'
  return null
}

export function isValidProject(obj) {
  return _findInvalidField(obj) === null
}

export function assertValidProject(obj) {
  const field = _findInvalidField(obj)
  if (field !== null) throw new Error(`invalid project: ${field}`)
}

const SECTIONS = ['playground', 'portfolio']

export function addProjectToSection(collection, section, project) {
  if (!SECTIONS.includes(section)) {
    throw new Error(`unknown section: ${section}`)
  }
  assertValidProject(project)
  const existingIds = new Set([
    ...collection.playground.map(p => p.id),
    ...collection.portfolio.map(p => p.id)
  ])
  if (existingIds.has(project.id)) {
    throw new Error(`duplicate project id: ${project.id}`)
  }
  return {
    ...collection,
    [section]: [...collection[section], project]
  }
}

export function buildPresentationProject(input) {
  return {
    id: slugifyProjectId(input.title),
    title: input.title,
    cardDescription: input.summary,
    description: input.descriptionHtml,
    image: input.image ?? 'images/presentation-cover.png',
    imageAlt: input.imageAlt ?? `Cover slide for ${input.title}`,
    link: input.deckUrl,
    linkText: 'View presentation',
    label: 'Presentation',
    kind: 'presentation',
    tech: input.tech,
    hidden: false,
    role: input.role ?? 'Presenter'
  }
}
