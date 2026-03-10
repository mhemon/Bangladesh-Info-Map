import fs from 'node:fs'
import path from 'node:path'
import {
  CANONICAL_DISTRICTS,
  canonicalizeDistrictName,
} from './district-name-validator.js'

const OUTPUT_FILE = 'public/data/bd-real-stats.json'
const REQUEST_TIMEOUT_MS = 15000

const DISTRICT_LIST_QUERY = `
SELECT ?district ?districtLabel
WHERE {
  ?district wdt:P31/wdt:P279* wd:Q1149652;
            wdt:P17 wd:Q902.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?districtLabel
`

function toNumber(value) {
  if (value == null || value === '') return null
  const num = Number(String(value).replace(/[+,]/g, '').trim())
  return Number.isFinite(num) ? Math.abs(num) : null
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
    .filter((x) => x.amount != null)
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

    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'BD-Maps/1.0 (local dataset builder)' },
    })

    if (!res.ok) continue

    const json = await res.json()
    const items = json?.search || []
    if (!items.length) continue

    const preferred =
      items.find((item) => /bangladesh/i.test(item?.description || '')) || items[0]

    if (preferred?.id) {
      return { id: preferred.id, label: preferred.label || null, term }
    }
  }

  return null
}

async function fetchDistrictEntityMapBySparql() {
  const url =
    'https://query.wikidata.org/sparql?format=json&query=' +
    encodeURIComponent(DISTRICT_LIST_QUERY)

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'BD-Maps/1.0 (local dataset builder)',
      Accept: 'application/sparql-results+json',
    },
  })

  if (!res.ok) return new Map()
  const json = await res.json()
  const bindings = json?.results?.bindings || []

  const map = new Map()
  for (const b of bindings) {
    const label = String(b?.districtLabel?.value || '')
      .replace(/\s+district$/i, '')
      .trim()
    const canonical = canonicalizeDistrictName(label)
    const qid = String(b?.district?.value || '').split('/').pop()
    if (canonical && qid) {
      map.set(canonical, qid)
    }
  }
  return map
}

async function fetchEntityClaims(entityId) {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'BD-Maps/1.0 (local dataset builder)' },
  })

  if (!res.ok) return null

  const json = await res.json()
  return json?.entities?.[entityId]?.claims || null
}

async function main() {
  const qidMap = await fetchDistrictEntityMapBySparql()
  const districts = []
  const missing = []
  const unresolved = []

  for (const district of CANONICAL_DISTRICTS) {
    let entityId = qidMap.get(district) || null
    let matchedBy = 'sparql'

    if (!entityId) {
      const match = await searchWikidataEntity(district)
      entityId = match?.id || null
      matchedBy = match ? `search:${match.term}` : 'none'
    }

    if (!entityId) {
      unresolved.push(district)
      districts.push({
        district,
        population: null,
        areaKm2: null,
        literacyRate: null,
        growthRate: null,
        density: null,
      })
      continue
    }

    const claims = await fetchEntityClaims(entityId)
    const populationClaim = pickBestClaim(claims?.P1082 || [])
    const areaClaim = pickBestClaim(claims?.P2046 || [])

    const population = claimAmount(populationClaim)
    const areaKm2 = claimAmount(areaClaim)
    const density =
      population != null && areaKm2 != null && areaKm2 > 0
        ? Number((population / areaKm2).toFixed(2))
        : null

    if (population == null && areaKm2 == null) {
      missing.push(district)
    }

    districts.push({
      district,
      population,
      areaKm2,
      literacyRate: null,
      growthRate: null,
      density,
      _matchedBy: matchedBy,
      _entityId: entityId,
    })

    // Keep requests friendly to public API.
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'Wikidata search + entity claims (P1082 population, P2046 area)',
    sourceUrl: 'https://www.wikidata.org/',
    count: districts.length,
    missingDistricts: missing,
    unresolvedDistricts: unresolved,
    districts,
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2))

  console.log(`[ok] wrote ${OUTPUT_FILE}`)
  console.log(`[info] districts: ${districts.length}`)
  console.log(`[info] unresolved districts: ${unresolved.length}`)
  console.log(`[info] missing metrics after fetch: ${missing.length}`)
}

main().catch((err) => {
  console.error('[error]', err.message)
  process.exit(1)
})
