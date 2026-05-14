import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const resumePath = path.join(repoRoot, 'resume', 'resume.json')
const projectsPath = path.join(repoRoot, 'data', 'projects.json')
const bioSourcePath = path.join(repoRoot, 'data', 'chat-knowledge', 'bio.source.json')
const outputDir = path.join(repoRoot, 'data', 'chat-knowledge')

const ROLE_TAGS = {
  'apptio (ibm)': ['aws', 'platform architecture', 'saas', 'subscriptions', 'identity', 'data pipelines', 'finops', 'cloudability'],
  jumpcloud: ['identity', 'platform architecture', 'saas', 'security', 'apis'],
  'instant ink (hp)': ['subscriptions', 'saas', 'platform architecture', 'high-scale systems'],
  'at&t': ['backend', 'data systems', 'query systems'],
  'sunrise resorts & cruises': ['infrastructure', 'operations', 'networks'],
  '5d-agency (swi)': ['frontend', 'games', 'mobile'],
  'dda / oig / qreo': ['startups', 'full-stack', 'linux']
}

const PROJECT_TAGS = {
  gvp: ['this-site', 'frontend', 'ai', 'platform architecture'],
  'monday-rover': ['python', 'embedded', 'hardware', 'computer vision'],
  apptio: ['saas', 'data pipelines', 'platform architecture', 'aws'],
  jumpcloud: ['identity', 'security', 'saas'],
  'instant-ink': ['subscriptions', 'saas', 'backend'],
  att: ['backend', 'query systems'],
  sunrise: ['infrastructure', 'operations'],
  '5d-agency': ['frontend', 'games', 'mobile']
}

const PROJECT_FRAMES = {
  gvp: 'Demonstrates how Marwan combines product UX with clear service boundaries for AI-enabled workflows.',
  apptio: "Shows Marwan's approach to platform modernization in data-intensive SaaS with strong operability guardrails.",
  jumpcloud: "Reflects Marwan's work in identity-critical systems where reliability and safe rollout matter.",
  'instant-ink': 'Highlights experience evolving subscription systems to larger scale while protecting reliability.',
  att: 'Shows foundational backend work where query semantics and operational usefulness were both central.'
}

const FAQ = [
  {
    q: ['how do i contact him', 'can i reach out', 'how do i get in touch', 'is he hiring', 'is he available'],
    a: "The contact form on this site is the preferred channel. Marwan reads every submission. Want me to open it for you, prefilled with what we've discussed?",
    trigger_tool: 'open_contact_form'
  },
  {
    q: ['can i see the resume', 'do you have a cv', 'send me the resume', 'show me his resume'],
    a: 'Yes. Marwan keeps a public resume PDF on the site.',
    trigger_tool: 'open_resume'
  },
  {
    q: ["what's his salary expectation", 'how much does he want', "what's his rate"],
    a: "That's not something I can answer here. Marwan handles compensation conversations directly, and the contact form is the right channel."
  },
  {
    q: ['are you marwan', 'is this marwan', 'am i talking to a person'],
    a: "No. I'm an assistant embedded in Marwan's portfolio site. I can answer questions about his work and route you to him when needed, but I'm not Marwan."
  }
]

function toId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function roleTags(company, role) {
  const key = String(company || '').toLowerCase()
  const base = ROLE_TAGS[key] || []
  const dynamic = []
  const roleText = `${company || ''} ${role || ''}`.toLowerCase()
  if (roleText.includes('cloud')) dynamic.push('cloud')
  if (roleText.includes('identity') || roleText.includes('directory')) dynamic.push('identity')
  if (roleText.includes('subscription')) dynamic.push('subscriptions')
  return Array.from(new Set([...base, ...dynamic]))
}

function projectTags(projectId, section, tech) {
  const base = PROJECT_TAGS[projectId] || []
  const derived = (tech || []).flatMap((item) => {
    const t = String(item || '').toLowerCase()
    if (t.includes('aws') || t.includes('lambda') || t.includes('dynamo') || t.includes('sqs')) return ['aws', 'serverless']
    if (t.includes('python')) return ['python']
    if (t.includes('java')) return ['java']
    if (t.includes('node')) return ['node.js']
    if (t.includes('typescript')) return ['typescript']
    if (t.includes('frontend') || t.includes('web')) return ['frontend']
    return []
  })
  return Array.from(new Set([...base, ...derived, section]))
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

function buildRoles(resume) {
  return (resume.experience || []).map((exp) => {
    const company = String(exp.company || '').trim()
    const role = String(exp.role || '').trim()
    const period = String(exp.period || '').trim()
    const highlights = Array.isArray(exp.highlights) ? exp.highlights.map((item) => String(item)) : []
    return {
      id: toId(company) || toId(role),
      company,
      product: role,
      tenure: period,
      team: role,
      summary: highlights[0] || `${role} at ${company}.`,
      highlights,
      tech: [],
      relevance_tags: roleTags(company, role)
    }
  })
}

function buildProjects(projects) {
  const all = [
    ...(projects.playground || []).map((item) => ({ ...item, section: 'playground' })),
    ...(projects.portfolio || []).map((item) => ({ ...item, section: 'portfolio' }))
  ]

  return all.map((item) => {
    const id = String(item.id || '')
    const summary = `${item.cardDescription || ''} ${stripHtml(item.description || '')}`.trim()
    return {
      id,
      name: String(item.title || ''),
      summary,
      why_it_matters: PROJECT_FRAMES[id] || "Demonstrates Marwan's practical approach to delivering reliable, maintainable systems.",
      tech: Array.isArray(item.tech) ? item.tech.map((x) => String(x)) : [],
      links: item.link ? [{ label: String(item.linkText || 'Link'), url: String(item.link) }] : [],
      relevance_tags: projectTags(id, item.section, item.tech)
    }
  })
}

async function writeJson(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(filePath, payload, 'utf8')
}

async function main() {
  const [resume, projects, bio] = await Promise.all([
    readJson(resumePath),
    readJson(projectsPath),
    readJson(bioSourcePath)
  ])

  await mkdir(outputDir, { recursive: true })

  await Promise.all([
    writeJson(path.join(outputDir, 'bio.json'), bio),
    writeJson(path.join(outputDir, 'roles.json'), buildRoles(resume)),
    writeJson(path.join(outputDir, 'projects.json'), buildProjects(projects)),
    writeJson(path.join(outputDir, 'faq.json'), FAQ)
  ])
}

main().catch((error) => {
  console.error('Failed to build chat knowledge pack:', error)
  process.exitCode = 1
})
