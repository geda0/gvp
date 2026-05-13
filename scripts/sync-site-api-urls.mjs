import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const [, , contactUrl] = process.argv
if (!contactUrl) {
  console.error(
    'usage: sync-site-api-urls.mjs <contactApiUrl>\n' +
      '  contactApiUrl: full URL ending in /api/contact'
  )
  process.exit(1)
}

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}

function setMetaContent(html, metaName, value) {
  const esc = escapeAttr(value)
  const re = new RegExp(
    `(<meta\\s+name="${metaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content=")[^"]*("\\s*/?>)`,
    'i'
  )
  if (!re.test(html)) {
    throw new Error(`sync-site-api-urls: missing <meta name="${metaName}" ...> in file`)
  }
  return html.replace(re, `$1${esc}$2`)
}

const indexPath = path.join(root, 'index.html')
const adminPath = path.join(root, 'admin', 'index.html')

let indexHtml = fs.readFileSync(indexPath, 'utf8')
let adminHtml = fs.readFileSync(adminPath, 'utf8')

indexHtml = setMetaContent(indexHtml, 'gvp:contact-api-url', contactUrl)
adminHtml = setMetaContent(adminHtml, 'gvp:contact-api-url', contactUrl)

fs.writeFileSync(indexPath, indexHtml)
fs.writeFileSync(adminPath, adminHtml)
console.log('Updated', indexPath, adminPath)
