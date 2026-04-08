import crypto from 'crypto'
import { getStore } from '@netlify/blobs'

const STORE_NAME = 'contact'
const MSG_PREFIX = 'msg:'
const META_KEY = 'meta'

export function getContactStore() {
  return getStore(STORE_NAME)
}

export function nowIso() {
  return new Date().toISOString()
}

export function safeTrim(v) {
  return String(v || '').trim()
}

export function makeId() {
  return crypto.randomUUID()
}

export function hashIp(ip) {
  const val = safeTrim(ip)
  if (!val) return ''
  return crypto.createHash('sha256').update(val).digest('hex').slice(0, 16)
}

export function msgKey(id) {
  return `${MSG_PREFIX}${id}`
}

export async function loadMeta(store) {
  const raw = await store.get(META_KEY, { type: 'json' })
  return raw || { lastReportAt: null }
}

export async function saveMeta(store, meta) {
  await store.set(META_KEY, JSON.stringify(meta || {}))
}

export async function listMessages(store) {
  // `list` API is available in Netlify Blobs. Returns { blobs: [{ key, ... }] }.
  const res = await store.list({ prefix: MSG_PREFIX })
  return res?.blobs || []
}

