/**
 * Point index.html (+ admin) API meta tags at prod or stage execute-api URLs.
 * Usage: node scripts/prepare.mjs <prod|stage>
 * npm:    npm run prepare-site -- prod
 *
 * Override (optional): GVP_CHAT_API_URL_STAGE when stage chat differs from prod.
 */
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const DEFAULTS = {
  prod: {
    contact: 'https://lwi0vmdpb5.execute-api.us-east-2.amazonaws.com/api/contact',
    chat: 'https://m7qmz78kb6.execute-api.us-east-2.amazonaws.com/api/chat',
  },
  stage: {
    contact: 'https://fvfqpef8kb.execute-api.us-east-2.amazonaws.com/api/contact',
    chat:
      process.env.GVP_CHAT_API_URL_STAGE ||
      'https://m7qmz78kb6.execute-api.us-east-2.amazonaws.com/api/chat',
  },
}

const env = (process.argv[2] || '').toLowerCase()
if (env !== 'prod' && env !== 'stage') {
  console.error('usage: node scripts/prepare.mjs <prod|stage>')
  console.error('  prod  — production contact + chat meta (page stack URLs)')
  console.error('  stage — staging contact meta (page-staging); chat: GVP_CHAT_API_URL_STAGE or prod chat default')
  process.exit(1)
}

const { contact, chat } = DEFAULTS[env]
const sync = path.join(__dirname, 'sync-site-api-urls.mjs')
const r = spawnSync(process.execPath, [sync, contact, chat], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(r.status === 0 ? 0 : r.status || 1)
