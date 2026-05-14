import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const [, , contactUrl, chatUrl] = process.argv
if (!contactUrl) {
  console.error(
    'usage: sync-site-api-urls.mjs <contactApiUrl> [chatApiUrl]\n' +
      '  contactApiUrl: full URL ending in /api/contact\n' +
      '  chatApiUrl: optional full URL ending in /api/chat (for browser voice use a WebSocket-capable chat host, e.g. ECS/ALB, not Lambda-only execute-api)'
  )
  process.exit(1)
}

function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}

function setMetaContent(html, metaName, value, options = {}) {
  const { required = true } = options
  const esc = escapeAttr(value)
  const re = new RegExp(
    `(<meta\\s+name="${metaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content=")[^"]*("\\s*/?>)`,
    'i'
  )
  if (!re.test(html)) {
    if (required) {
      throw new Error(`sync-site-api-urls: missing <meta name="${metaName}" ...> in file`)
    }
    return html
  }
  return html.replace(re, `$1${esc}$2`)
}

const indexPath = path.join(root, 'index.html')
const adminPath = path.join(root, 'admin', 'index.html')

let indexHtml = fs.readFileSync(indexPath, 'utf8')
indexHtml = setMetaContent(indexHtml, 'gvp:contact-api-url', contactUrl)
if (chatUrl) {
  indexHtml = setMetaContent(indexHtml, 'gvp:chat-api-url', chatUrl, { required: false })
}
fs.writeFileSync(indexPath, indexHtml)

const updatedPaths = [indexPath]
if (fs.existsSync(adminPath)) {
  let adminHtml = fs.readFileSync(adminPath, 'utf8')
  adminHtml = setMetaContent(adminHtml, 'gvp:contact-api-url', contactUrl)
  if (chatUrl) {
    adminHtml = setMetaContent(adminHtml, 'gvp:chat-api-url', chatUrl, { required: false })
  }
  fs.writeFileSync(adminPath, adminHtml)
  updatedPaths.push(adminPath)
}

console.log('Updated', ...updatedPaths)
