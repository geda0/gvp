import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const [, , contactUrl, adminUrl, trafficUrl] = process.argv
if (!contactUrl || !adminUrl || !trafficUrl) {
  console.error('usage: sync-site-api-urls.mjs <contactApiUrl> <adminApiBaseUrl> <trafficApiBaseUrl>')
  process.exit(1)
}

function patchIndex(html) {
  return html.replace(
    /window\.__CONTACT_API_URL__\s*=\s*'[^']*'/,
    `window.__CONTACT_API_URL__ = '${contactUrl}'`
  )
}

function patchAdmin(html) {
  let s = html
  s = s.replace(
    /window\.__CONTACT_API_URL__\s*=\s*'[^']*'/,
    `window.__CONTACT_API_URL__ = '${contactUrl}'`
  )
  s = s.replace(
    /window\.__ADMIN_API_BASE_URL__\s*=\s*'[^']*'/,
    `window.__ADMIN_API_BASE_URL__ = '${adminUrl}'`
  )
  s = s.replace(
    /window\.__TRAFFIC_API_BASE_URL__\s*=\s*'[^']*'/,
    `window.__TRAFFIC_API_BASE_URL__ = '${trafficUrl}'`
  )
  return s
}

const indexPath = path.join(root, 'index.html')
const adminPath = path.join(root, 'admin', 'index.html')
fs.writeFileSync(indexPath, patchIndex(fs.readFileSync(indexPath, 'utf8')))
fs.writeFileSync(adminPath, patchAdmin(fs.readFileSync(adminPath, 'utf8')))
console.log('Updated', indexPath, adminPath)
