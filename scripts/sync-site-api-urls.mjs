import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const META_VOICE = 'gvp:chat-voice-enabled'

const contactUrl = process.argv[2]
let chatUrl
let voiceCliRaw

if (process.argv.length <= 3) {
  chatUrl = undefined
  voiceCliRaw = undefined
} else if (process.argv.length === 4) {
  chatUrl = process.argv[3]
  voiceCliRaw = undefined
} else {
  chatUrl = process.argv[3]
  voiceCliRaw = process.argv[4]
}

if (chatUrl === '') chatUrl = undefined

if (!contactUrl) {
  console.error(
    'usage: sync-site-api-urls.mjs <contactApiUrl> [chatApiUrl] [chatVoiceFlag]\n' +
      '  contactApiUrl: full URL ending in /api/contact\n' +
      '  chatApiUrl: optional full URL ending in /api/chat (for browser voice use a WebSocket-capable chat host, e.g. ECS/ALB, not Lambda-only execute-api)\n' +
      '  chatVoiceFlag: optional 1/true/yes → meta gvp:chat-voice-enabled=1; 0 otherwise. When omitted, uses env GVP_CHAT_VOICE if set; otherwise does not change the voice meta.\n' +
      '  Backward compatible: two-arg form (contact + chat) unchanged.'
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

function parseVoiceEnabled(raw) {
  if (raw === undefined || raw === null) return false
  const s = String(raw).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

const voiceFromCli = voiceCliRaw !== undefined
const voiceFromEnv = process.env.GVP_CHAT_VOICE !== undefined && process.env.GVP_CHAT_VOICE !== ''
const shouldPatchVoice = voiceFromCli || voiceFromEnv
const voiceEnabled = voiceFromCli
  ? parseVoiceEnabled(voiceCliRaw)
  : parseVoiceEnabled(process.env.GVP_CHAT_VOICE)

const indexPath = path.join(root, 'index.html')
const adminPath = path.join(root, 'admin', 'index.html')

let indexHtml = fs.readFileSync(indexPath, 'utf8')
indexHtml = setMetaContent(indexHtml, 'gvp:contact-api-url', contactUrl)
if (chatUrl) {
  indexHtml = setMetaContent(indexHtml, 'gvp:chat-api-url', chatUrl, { required: false })
}
if (shouldPatchVoice) {
  indexHtml = setMetaContent(indexHtml, META_VOICE, voiceEnabled ? '1' : '0')
}
fs.writeFileSync(indexPath, indexHtml)

const updatedPaths = [indexPath]
if (fs.existsSync(adminPath)) {
  let adminHtml = fs.readFileSync(adminPath, 'utf8')
  adminHtml = setMetaContent(adminHtml, 'gvp:contact-api-url', contactUrl)
  if (chatUrl) {
    adminHtml = setMetaContent(adminHtml, 'gvp:chat-api-url', chatUrl, { required: false })
  }
  if (shouldPatchVoice) {
    adminHtml = setMetaContent(adminHtml, META_VOICE, voiceEnabled ? '1' : '0', {
      required: false
    })
  }
  fs.writeFileSync(adminPath, adminHtml)
  updatedPaths.push(adminPath)
}

console.log('Updated', ...updatedPaths)
