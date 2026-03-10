import http from 'node:http'
import { URL } from 'node:url'
import { CANONICAL_DISTRICTS, canonicalizeDistrictName } from './district-name-validator.js'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const REQUEST_TIMEOUT_MS = 20000
const WORLD_BANK_TTL_MS = 12 * 60 * 60 * 1000
const WIKIDATA_TTL_MS = 6 * 60 * 60 * 1000

const cache = new Map()

function toNumber(value) {
  if (value == null || value === '') return null
  const num = Number(String(value).replace(/[+,]/g, '').trim())
  return Number.isFinite(num) ? Math.abs(num) : null
}

function pickBestClaim(claims = []) {
  if (!claims.length) return null
  return claims
    .map((claim) => {
      const time =
        claim?.qualifiers?.P585?.[0]?.datavalue?.value?.time?.replace('+', '') ||
        '0000-00-00'
      const amount = toNumber(claim?.mainsnak?.datavalue?.value?.amount)
      return { claim, time, amount }
    })
    .filter((item) => item.amount != null)
    .sort((a, b) => b.time.localeCompare(a.time))[0]?.claim
}

function claimAmount(claim) {
  return toNumber(claim?.mainsnak?.datavalue?.value?.amount)
}

async function searchWikidataEntity(district) {
  const candidates = [
    `${district} District, Bangladesh`,
    `${district} District`,
    `${district}, Bangladesh`,
    district,
  ]

  for (const term of candidates) {
    const url =
      'https://www.wikidata.org/w/api.php?' +
      new URLSearchParams({
        action: 'wbsearchentities',
        format: 'json',
        language: 'en',
        type: 'item',
        limit: '10',
        search: term,
      }).toString()

    const response = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'BD-Maps-Proxy/1.0' },
    })

    if (!response.ok) continue

    const json = await response.json()
    const items = json?.search || []
    if (!items.length) continue

    const preferred =
      items.find((item) => /bangladesh/i.test(item?.description || '')) || items[0]

    if (preferred?.id) {
      return preferred.id
    }
  }

  return null
}

async function fetchEntityClaims(entityId) {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'BD-Maps-Proxy/1.0' },
  })

  if (!response.ok) return null

  const json = await response.json()
  return json?.entities?.[entityId]?.claims || null
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) return
      results[current] = await mapper(items[current], current)
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    worker()
  )
  await Promise.all(workers)
  return results
}

async function fetchDistrictLiveRow(district) {
  const entityId = await searchWikidataEntity(district)
  if (!entityId) {
    return {
      district,
      population: null,
      areaKm2: null,
      literacyRate: null,
      growthRate: null,
      density: null,
    }
  }

  const claims = await fetchEntityClaims(entityId)
  const population = claimAmount(pickBestClaim(claims?.P1082 || []))
  const areaKm2 = claimAmount(pickBestClaim(claims?.P2046 || []))
  const density =
    population != null && areaKm2 != null && areaKm2 > 0
      ? Number((population / areaKm2).toFixed(2))
      : null

  return {
    district,
    population,
    areaKm2,
    literacyRate: null,
    growthRate: null,
    density,
  }
}

function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function setCached(key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchWorldBankIndicator(indicator) {
  const cacheKey = `wb:${indicator}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  const url =
    `https://api.worldbank.org/v2/country/BGD/indicator/${encodeURIComponent(indicator)}` +
    '?format=json&mrv=8'

  const response = await fetchWithTimeout(url)
  if (!response.ok) {
    throw new Error(`World Bank upstream failed (${response.status})`)
  }

  const payload = await response.json()
  const series = Array.isArray(payload) ? payload[1] : null
  const latest = Array.isArray(series)
    ? series.find((item) => typeof item?.value === 'number' && Number.isFinite(item.value))
    : null

  const result = {
    indicator,
    value: latest?.value ?? null,
    year: latest?.date ?? null,
    source: 'World Bank API',
    fetchedAt: new Date().toISOString(),
  }

  setCached(cacheKey, result, WORLD_BANK_TTL_MS)
  return result
}

async function fetchWikidataDistrictStats() {
  const cacheKey = 'wikidata:districts'
  const cached = getCached(cacheKey)
  if (cached) return cached

  const districts = await mapWithConcurrency(CANONICAL_DISTRICTS, 6, async (district) => {
    const canonical = canonicalizeDistrictName(district) || district
    return fetchDistrictLiveRow(canonical)
  })

  const populatedCount = districts.filter((row) => row.population != null || row.areaKm2 != null).length

  const result = {
    source: 'Wikidata API search + entity claims (P1082 population, P2046 area)',
    sourceUrl: 'https://www.wikidata.org/',
    generatedAt: new Date().toISOString(),
    count: districts.length,
    populatedCount,
    districts,
  }

  setCached(cacheKey, result, WIKIDATA_TTL_MS)
  return result
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: 'missing URL' })
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`)

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'bd-maps-api-proxy',
        now: new Date().toISOString(),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/worldbank/bgd') {
      const indicator = url.searchParams.get('indicator')
      if (!indicator) {
        sendJson(res, 400, { error: 'indicator query param is required' })
        return
      }
      const data = await fetchWorldBankIndicator(indicator)
      sendJson(res, 200, data)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/wikidata/districts') {
      const data = await fetchWikidataDistrictStats()
      sendJson(res, 200, data)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, 502, {
      error: 'upstream fetch failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[proxy] running at http://${HOST}:${PORT}`)
  console.log('[proxy] endpoints: /api/health, /api/worldbank/bgd?indicator=..., /api/wikidata/districts')
})
