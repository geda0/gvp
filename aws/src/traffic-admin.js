import crypto from 'crypto'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { json, optionsResponse, unauthorized } from './common/contact-shared.js'

const secrets = new SecretsManagerClient({})
const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/bigquery.readonly',
  'https://www.googleapis.com/auth/analytics.readonly'
].join(' ')
const MAX_BIGQUERY_STALENESS_DAYS = 1
const tokenCache = {
  accessToken: '',
  expiresAt: 0
}

function requireAdminKey(event) {
  const expected = process.env.ADMIN_API_KEY
  const provided =
    event?.headers?.['x-admin-key'] ||
    event?.headers?.['X-Admin-Key'] ||
    ''
  if (!expected || provided !== expected) return false
  return true
}

function getMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || 'GET'
}

function getPath(event) {
  return event?.rawPath || event?.path || ''
}

function parseNumber(raw, fallback, min, max) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function getQueryValue(event, key, fallback) {
  const value = event?.queryStringParameters?.[key]
  return value == null || value === '' ? fallback : value
}

function getTrafficConfig() {
  const projectId = String(process.env.TRAFFIC_GCP_PROJECT_ID || '').trim()
  const dataset = String(process.env.TRAFFIC_BIGQUERY_DATASET || '').trim()
  const serviceAccountSecretArn = String(process.env.TRAFFIC_SERVICE_ACCOUNT_SECRET_ARN || '').trim()
  const ga4PropertyId = String(process.env.TRAFFIC_GA4_PROPERTY_ID || '').trim()
  const hasBigQuery = Boolean(projectId && dataset && serviceAccountSecretArn)
  const hasGa4 = Boolean(ga4PropertyId && serviceAccountSecretArn)
  if (!hasBigQuery && !hasGa4) {
    throw new Error(
      'Traffic analytics is not configured. Set TRAFFIC_GA4_PROPERTY_ID (GA4) or BigQuery env variables.'
    )
  }
  return { projectId, dataset, serviceAccountSecretArn, ga4PropertyId, hasBigQuery, hasGa4 }
}

async function getServiceAccount(config) {
  const response = await secrets.send(
    new GetSecretValueCommand({
      SecretId: config.serviceAccountSecretArn
    })
  )
  const raw = response.SecretString || '{}'
  const secret = JSON.parse(raw)
  const clientEmail = secret.client_email || secret.clientEmail
  const privateKey = secret.private_key || secret.privateKey
  if (!clientEmail || !privateKey) {
    throw new Error('Service account secret is missing client_email or private_key.')
  }
  return {
    clientEmail,
    privateKey: String(privateKey).replace(/\\n/g, '\n')
  }
}

function createJwtAssertion(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: OAUTH_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })
  ).toString('base64url')
  const unsigned = `${header}.${payload}`
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

async function getAccessToken(config) {
  if (tokenCache.accessToken && tokenCache.expiresAt - Date.now() > 60000) {
    return tokenCache.accessToken
  }
  const serviceAccount = await getServiceAccount(config)
  const assertion = createJwtAssertion(serviceAccount.clientEmail, serviceAccount.privateKey)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  }).toString()
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || 'Could not authenticate to Google OAuth.')
  }
  tokenCache.accessToken = data.access_token
  tokenCache.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000
  return tokenCache.accessToken
}

function buildTrafficSql(datasetPath) {
  return {
    summary: `
WITH base AS (
  SELECT
    event_timestamp,
    event_name,
    user_pseudo_id,
    CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING) AS ga_session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS engagement_time_msec
  FROM \`${datasetPath}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY))
    AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
),
sessions AS (
  SELECT
    CONCAT(user_pseudo_id, '.', ga_session_id) AS session_key,
    user_pseudo_id,
    COUNT(*) AS events_count,
    COUNTIF(event_name = 'page_view') AS page_views,
    MAX(IFNULL(session_engaged, '0')) = '1' AS engaged,
    SUM(IFNULL(engagement_time_msec, 0)) AS engagement_time_msec
  FROM base
  WHERE ga_session_id IS NOT NULL
  GROUP BY session_key, user_pseudo_id
)
SELECT
  COUNT(*) AS sessions,
  COUNT(DISTINCT user_pseudo_id) AS users,
  SAFE_DIVIDE(SUM(page_views), COUNT(*)) AS avg_pageviews_per_session,
  SAFE_DIVIDE(SUM(engagement_time_msec), COUNT(*)) AS avg_engagement_msec,
  SUM(CASE WHEN engaged THEN 1 ELSE 0 END) AS engaged_sessions,
  SUM(CASE WHEN NOT engaged THEN 1 ELSE 0 END) AS bounce_sessions,
  SUM(CASE WHEN NOT engaged AND events_count <= 1 THEN 1 ELSE 0 END) AS estimated_bot_sessions,
  SUM(CASE WHEN engaged OR events_count > 1 THEN 1 ELSE 0 END) AS estimated_human_sessions
FROM sessions`,
    geo: `
WITH base AS (
  SELECT
    CONCAT(user_pseudo_id, '.', CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING)) AS session_key,
    geo.country AS country,
    geo.region AS region,
    geo.city AS city
  FROM \`${datasetPath}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY))
    AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
),
sessions AS (
  SELECT
    session_key,
    ANY_VALUE(country) AS country,
    ANY_VALUE(region) AS region,
    ANY_VALUE(city) AS city
  FROM base
  WHERE session_key IS NOT NULL
  GROUP BY session_key
)
SELECT
  COALESCE(country, 'Unknown') AS country,
  COALESCE(region, 'Unknown') AS region,
  COALESCE(city, 'Unknown') AS city,
  COUNT(*) AS sessions
FROM sessions
GROUP BY country, region, city
ORDER BY sessions DESC
LIMIT @limit`,
    exits: `
WITH base AS (
  SELECT
    event_timestamp,
    CONCAT(user_pseudo_id, '.', CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING)) AS session_key,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location
  FROM \`${datasetPath}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY))
    AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
),
session_exits AS (
  SELECT
    session_key,
    ARRAY_AGG(page_location IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS exit_page
  FROM base
  WHERE session_key IS NOT NULL
  GROUP BY session_key
)
SELECT
  COALESCE(exit_page, '(no page)') AS exit_page,
  COUNT(*) AS sessions
FROM session_exits
GROUP BY exit_page
ORDER BY sessions DESC
LIMIT @limit`,
    sessions: `
WITH base AS (
  SELECT
    event_timestamp,
    event_name,
    user_pseudo_id,
    CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING) AS ga_session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'session_engaged') AS session_engaged,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS engagement_time_msec,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
    geo.country AS country,
    geo.city AS city
  FROM \`${datasetPath}.events_*\`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY))
    AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
),
sessions AS (
  SELECT
    CONCAT(user_pseudo_id, '.', ga_session_id) AS session_key,
    user_pseudo_id,
    MIN(TIMESTAMP_MICROS(event_timestamp)) AS session_start,
    MAX(TIMESTAMP_MICROS(event_timestamp)) AS session_end,
    COUNT(*) AS events_count,
    COUNTIF(event_name = 'page_view') AS page_views,
    MAX(IFNULL(session_engaged, '0')) = '1' AS engaged,
    SUM(IFNULL(engagement_time_msec, 0)) AS engagement_time_msec,
    ANY_VALUE(country) AS country,
    ANY_VALUE(city) AS city,
    ARRAY_AGG(page_location IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[SAFE_OFFSET(0)] AS exit_page
  FROM base
  WHERE ga_session_id IS NOT NULL
  GROUP BY session_key, user_pseudo_id
)
SELECT
  session_key,
  user_pseudo_id,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', session_start) AS session_start,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', session_end) AS session_end,
  events_count,
  page_views,
  engaged,
  engagement_time_msec,
  COALESCE(country, 'Unknown') AS country,
  COALESCE(city, 'Unknown') AS city,
  COALESCE(exit_page, '(no page)') AS exit_page,
  CASE
    WHEN NOT engaged AND events_count <= 1 THEN 'high'
    WHEN NOT engaged AND events_count <= 2 THEN 'medium'
    ELSE 'low'
  END AS bot_likelihood
FROM sessions
ORDER BY session_start DESC
LIMIT @limit
OFFSET @offset`,
    sessionDetail: `
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', TIMESTAMP_MICROS(event_timestamp)) AS event_time,
  event_name,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_title') AS page_title,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'link_url') AS link_url,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'interaction_type') AS interaction_type,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'project_id') AS project_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'section') AS section,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'theme') AS theme
FROM \`${datasetPath}.events_*\`
WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY))
  AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
  AND user_pseudo_id = @userPseudoId
  AND CAST((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS STRING) = @gaSessionId
ORDER BY event_timestamp ASC
LIMIT 500`
  }
}

function makeQueryParameters(params) {
  return Object.entries(params).map(([name, value]) => {
    const type = Number.isInteger(value) ? 'INT64' : 'STRING'
    return {
      name,
      parameterType: { type },
      parameterValue: { value: String(value) }
    }
  })
}

function parseSchemaValue(fieldSchema, value) {
  if (value == null || value.v == null) return null
  if (fieldSchema.mode === 'REPEATED') {
    return (value.v || []).map((item) => parseSchemaValue({ ...fieldSchema, mode: 'NULLABLE' }, item))
  }
  if (fieldSchema.type === 'RECORD') {
    const obj = {}
    fieldSchema.fields.forEach((nestedField, index) => {
      obj[nestedField.name] = parseSchemaValue(nestedField, value.v.f[index])
    })
    return obj
  }
  if (fieldSchema.type === 'INTEGER' || fieldSchema.type === 'INT64') return Number(value.v)
  if (fieldSchema.type === 'FLOAT' || fieldSchema.type === 'FLOAT64' || fieldSchema.type === 'NUMERIC') {
    return Number(value.v)
  }
  if (fieldSchema.type === 'BOOLEAN' || fieldSchema.type === 'BOOL') return value.v === 'true' || value.v === true
  return value.v
}

function rowsToObjects(schemaFields, rows = []) {
  return rows.map((row) => {
    const obj = {}
    schemaFields.forEach((field, index) => {
      obj[field.name] = parseSchemaValue(field, row.f[index])
    })
    return obj
  })
}

async function runQuery(config, sql, params) {
  const accessToken = await getAccessToken(config)
  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${config.projectId}/queries`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 20000,
      useQueryCache: true,
      parameterMode: 'NAMED',
      queryParameters: makeQueryParameters(params)
    })
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) {
    const message = data?.error?.message || data?.error?.errors?.[0]?.message || 'BigQuery request failed.'
    throw new Error(message)
  }
  const schemaFields = data.schema?.fields || []
  return rowsToObjects(schemaFields, data.rows || [])
}

async function getSummary(config, sql, days) {
  const rows = await runQuery(config, sql.summary, { days })
  return rows[0] || {
    sessions: 0,
    users: 0,
    avg_pageviews_per_session: 0,
    avg_engagement_msec: 0,
    engaged_sessions: 0,
    bounce_sessions: 0,
    estimated_bot_sessions: 0,
    estimated_human_sessions: 0
  }
}

async function getBigQueryFreshness(config) {
  const sql = `
SELECT
  MAX(PARSE_DATE('%Y%m%d', REGEXP_EXTRACT(table_name, r'^events_(\\d{8})$'))) AS latest_event_date
FROM \`${config.projectId}.${config.dataset}.INFORMATION_SCHEMA.TABLES\`
WHERE table_name LIKE 'events_%'
`
  const rows = await runQuery(config, sql, {})
  const latest = rows[0]?.latest_event_date
  if (!latest) {
    return { isFresh: false, latestEventDate: null, lagDays: null }
  }
  const latestDate = new Date(`${latest}T00:00:00Z`)
  const now = new Date()
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const latestUtc = Date.UTC(
    latestDate.getUTCFullYear(),
    latestDate.getUTCMonth(),
    latestDate.getUTCDate()
  )
  const lagDays = Math.max(0, Math.floor((todayUtc - latestUtc) / 86400000))
  return {
    isFresh: lagDays <= MAX_BIGQUERY_STALENESS_DAYS,
    latestEventDate: latest,
    lagDays
  }
}

function mapGa4SummaryRow(row = {}) {
  const sessions = Number(row.sessions || 0)
  const engagedSessions = Number(row.engagedSessions || 0)
  const bounceRate = Number(row.bounceRate || 0)
  const bounceSessions = Math.max(0, Math.round(sessions * bounceRate))
  return {
    sessions,
    users: Number(row.totalUsers || 0),
    avg_pageviews_per_session: Number(row.screenPageViewsPerSession || 0),
    avg_engagement_msec: Math.round(Number(row.userEngagementDuration || 0) * 1000),
    engaged_sessions: engagedSessions,
    bounce_sessions: bounceSessions,
    estimated_bot_sessions: null,
    estimated_human_sessions: null
  }
}

function mapGa4Rows(data, dimensions = [], metrics = []) {
  const rows = data.rows || []
  return rows.map((row) => {
    const item = {}
    dimensions.forEach((name, i) => {
      item[name] = row.dimensionValues?.[i]?.value ?? ''
    })
    metrics.forEach((name, i) => {
      item[name] = Number(row.metricValues?.[i]?.value || 0)
    })
    return item
  })
}

async function runGa4Report(config, payload) {
  if (!config.ga4PropertyId) {
    throw new Error('Missing TRAFFIC_GA4_PROPERTY_ID for GA4 live fallback.')
  }
  const accessToken = await getAccessToken(config)
  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${config.ga4PropertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }
  )
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) {
    const message = data?.error?.message || 'GA4 Data API request failed.'
    throw new Error(message)
  }
  return data
}

async function getLiveSummary(config, days) {
  const endDate = 'today'
  const startDate = `${Math.max(1, Number(days || 30) - 1)}daysAgo`
  const data = await runGa4Report(config, {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViewsPerSession' },
      { name: 'userEngagementDuration' },
      { name: 'engagedSessions' },
      { name: 'bounceRate' }
    ],
    keepEmptyRows: true
  })
  const values = data.rows?.[0]?.metricValues || []
  const row = {
    sessions: values[0]?.value,
    totalUsers: values[1]?.value,
    screenPageViewsPerSession: values[2]?.value,
    userEngagementDuration: values[3]?.value,
    engagedSessions: values[4]?.value,
    bounceRate: values[5]?.value
  }
  return mapGa4SummaryRow(row)
}

async function getLiveGeo(config, days, limit) {
  const endDate = 'today'
  const startDate = `${Math.max(1, Number(days || 30) - 1)}daysAgo`
  const data = await runGa4Report(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'country' }, { name: 'region' }, { name: 'city' }],
    metrics: [{ name: 'sessions' }],
    limit: String(limit),
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    keepEmptyRows: false
  })
  return mapGa4Rows(data, ['country', 'region', 'city'], ['sessions']).map((item) => ({
    country: item.country || 'Unknown',
    region: item.region || 'Unknown',
    city: item.city || 'Unknown',
    sessions: item.sessions
  }))
}

async function getLiveExitPages(config, days, limit) {
  const endDate = 'today'
  const startDate = `${Math.max(1, Number(days || 30) - 1)}daysAgo`
  const data = await runGa4Report(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'exits' }],
    dimensionFilter: {
      filter: {
        fieldName: 'pagePath',
        stringFilter: { matchType: 'FULL_REGEXP', value: '.+' }
      }
    },
    limit: String(limit),
    orderBys: [{ metric: { metricName: 'exits' }, desc: true }],
    keepEmptyRows: false
  })
  return mapGa4Rows(data, ['pagePath'], ['exits']).map((item) => ({
    exit_page: item.pagePath || '(no page)',
    sessions: item.exits
  }))
}

async function getSummaryWithFallback(config, sql, days) {
  let live = null
  let liveError = null
  try {
    live = await getLiveSummary(config, days)
  } catch (error) {
    liveError = error
  }

  try {
    if (!config.hasBigQuery || !sql) {
      if (!live) {
        throw new Error(String(liveError?.message || 'GA4 unavailable and BigQuery not configured.'))
      }
      return {
        ...live,
        data_source: 'ga4-data-api',
        complementary_source: null,
        fallback_reason: 'bigquery-not-configured'
      }
    }

    const freshness = await getBigQueryFreshness(config)
    if (freshness.isFresh) {
      const summary = await getSummary(config, sql, days)
      if (!live) {
        return {
          ...summary,
          data_source: 'bigquery',
          complementary_source: null,
          fallback_reason: String(liveError?.message || 'ga4-failed'),
          bigquery_latest_event_date: freshness.latestEventDate,
          bigquery_lag_days: freshness.lagDays
        }
      }
      return {
        ...live,
        estimated_bot_sessions: summary.estimated_bot_sessions,
        estimated_human_sessions: summary.estimated_human_sessions,
        complementary_source: 'bigquery',
        data_source: 'ga4-data-api',
        bigquery_latest_event_date: freshness.latestEventDate,
        bigquery_lag_days: freshness.lagDays
      }
    }

    if (!live) {
      throw new Error(
        `GA4 unavailable and BigQuery stale (${freshness.lagDays ?? 'unknown'} day lag).`
      )
    }
    return {
      ...live,
      data_source: 'ga4-data-api',
      complementary_source: null,
      bigquery_latest_event_date: freshness.latestEventDate,
      bigquery_lag_days: freshness.lagDays
    }
  } catch (error) {
    if (!live) {
      throw error
    }
    return {
      ...live,
      data_source: 'ga4-data-api',
      complementary_source: null,
      fallback_reason: String(error?.message || 'bigquery-failed')
    }
  }
}

async function getGeoGa4First(config, sql, days, limit) {
  try {
    return {
      items: await getLiveGeo(config, days, limit),
      data_source: 'ga4-data-api'
    }
  } catch (gaError) {
    if (!config.hasBigQuery || !sql) {
      throw gaError
    }
    const items = await getGeo(config, sql, days, limit)
    return {
      items,
      data_source: 'bigquery',
      fallback_reason: String(gaError?.message || 'ga4-failed')
    }
  }
}

async function getExitPagesGa4First(config, sql, days, limit) {
  try {
    return {
      items: await getLiveExitPages(config, days, limit),
      data_source: 'ga4-data-api'
    }
  } catch (gaError) {
    if (!config.hasBigQuery || !sql) {
      throw gaError
    }
    const items = await getExitPages(config, sql, days, limit)
    return {
      items,
      data_source: 'bigquery',
      fallback_reason: String(gaError?.message || 'ga4-failed')
    }
  }
}

async function getGeo(config, sql, days, limit) {
  return runQuery(config, sql.geo, { days, limit })
}

async function getExitPages(config, sql, days, limit) {
  return runQuery(config, sql.exits, { days, limit })
}

async function getSessions(config, sql, days, limit, offset) {
  return runQuery(config, sql.sessions, { days, limit, offset })
}

async function getSessionDetail(config, sql, days, sessionKey) {
  const [userPseudoId, gaSessionId] = String(sessionKey || '').split('.')
  if (!userPseudoId || !gaSessionId) {
    throw new Error('Invalid session key.')
  }
  return runQuery(config, sql.sessionDetail, { days, userPseudoId, gaSessionId })
}

export const handler = async (event) => {
  const method = getMethod(event)
  if (method === 'OPTIONS') return optionsResponse()
  if (!requireAdminKey(event)) return unauthorized()

  try {
    const config = getTrafficConfig()
    const sql = config.hasBigQuery ? buildTrafficSql(`${config.projectId}.${config.dataset}`) : null
    const path = getPath(event)
    const days = parseNumber(getQueryValue(event, 'days', 30), 30, 1, 90)

    if (method === 'GET' && path.endsWith('/traffic/summary')) {
      return json(200, await getSummaryWithFallback(config, sql, days))
    }

    if (method === 'GET' && path.endsWith('/traffic/geo')) {
      const limit = parseNumber(getQueryValue(event, 'limit', 20), 20, 1, 100)
      return json(200, await getGeoGa4First(config, sql, days, limit))
    }

    if (method === 'GET' && path.endsWith('/traffic/exit-pages')) {
      const limit = parseNumber(getQueryValue(event, 'limit', 20), 20, 1, 100)
      return json(200, await getExitPagesGa4First(config, sql, days, limit))
    }

    if (method === 'GET' && path.endsWith('/traffic/sessions')) {
      if (!config.hasBigQuery || !sql) {
        return json(501, {
          error: 'Session timeline requires BigQuery configuration.',
          data_source: 'unavailable'
        })
      }
      const limit = parseNumber(getQueryValue(event, 'limit', 25), 25, 1, 100)
      const offset = parseNumber(getQueryValue(event, 'offset', 0), 0, 0, 500)
      return json(200, {
        items: await getSessions(config, sql, days, limit, offset),
        offset,
        limit
      })
    }

    if (method === 'GET' && /\/traffic\/sessions\/[^/]+$/.test(path)) {
      if (!config.hasBigQuery || !sql) {
        return json(501, {
          error: 'Session timeline requires BigQuery configuration.',
          data_source: 'unavailable'
        })
      }
      const match = path.match(/\/traffic\/sessions\/([^/]+)$/)
      const sessionKey = decodeURIComponent(match?.[1] || '')
      return json(200, { events: await getSessionDetail(config, sql, days, sessionKey) })
    }
  } catch (error) {
    return json(500, { error: String(error?.message || error || 'Traffic query failed.') })
  }

  return json(404, { error: 'Not found' })
}
