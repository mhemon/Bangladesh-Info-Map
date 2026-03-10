import { useEffect, useMemo, useState } from 'react'
import {
  geoArea,
  geoCentroid,
  geoContains,
  geoDistance,
  geoMercator,
  geoPath,
} from 'https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm'

const VIEWPORT = { width: 900, height: 640 }
const ADM1_URL = '/data/bgd-adm1.geojson'
const ADM2_URL = '/data/bgd-adm2.geojson'
const CENSUS_DB_URL = '/data/bd-census-data.json'
const DUMMY_DB_URL = '/data/bd-district-dummy.json'
const LOCAL_PROXY_BASE_URL = 'http://127.0.0.1:8787'
const PROXY_WIKIDATA_DISTRICTS_URLS = [
  '/api/wikidata/districts',
  `${LOCAL_PROXY_BASE_URL}/api/wikidata/districts`,
]
const PROXY_WORLDBANK_BGD_URLS = [
  '/api/worldbank/bgd',
  `${LOCAL_PROXY_BASE_URL}/api/worldbank/bgd`,
]
const COUNTRY_API_FALLBACK = {
  population: null,
  areaKm2: null,
  literacyRate: null,
  growthRate: null,
}
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql'

const DISTRICT_STATS_QUERY = `
SELECT ?districtLabel (SAMPLE(?populationVal) AS ?population) (SAMPLE(?areaVal) AS ?area)
WHERE {
  ?district wdt:P31/wdt:P279* wd:Q1149652;
            wdt:P17 wd:Q902.
  OPTIONAL { ?district wdt:P1082 ?populationVal. }
  OPTIONAL { ?district wdt:P2046 ?areaVal. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?districtLabel
ORDER BY ?districtLabel
`

const NAME_FIX = {
  Barisal: 'Barishal',
  Bogura: 'Bogra',
  Brahamanbaria: 'Brahmanbaria',
  Brahmanbaria: 'Brahmanbaria',
  Chittagong: 'Chattogram',
  Comilla: 'Cumilla',
  CoxsBazar: "Cox's Bazar",
  Jessore: 'Jashore',
  Jhalakathi: 'Jhalokati',
  Moulvibazar: 'Moulvibazar',
  Maulvibazar: 'Moulvibazar',
  Netrakona: 'Netrokona',
  Nawabganj: 'Chapai Nawabganj',
  Rajshani: 'Rajshahi',
}

function normalizeName(name) {
  const raw = String(name || '').trim()
  const fixed = NAME_FIX[raw] || raw
  return fixed
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return 'N/A'
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

function steradiansToKm2(areaSteradians) {
  const earthRadiusKm = 6371.0088
  return areaSteradians * earthRadiusKm * earthRadiusKm
}

function reverseRings(geometry) {
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring) => [...ring].reverse()),
    }
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((poly) => poly.map((ring) => [...ring].reverse())),
    }
  }
  return geometry
}

function normalizeOrientation(feature) {
  if (geoArea(feature) > 2 * Math.PI) {
    return { ...feature, geometry: reverseRings(feature.geometry) }
  }
  return feature
}

function toDatasetMap(dataset) {
  const map = new Map()
  for (const row of dataset?.districts || []) {
    map.set(normalizeName(row.district), row)
  }
  return map
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function averageOf(items, key) {
  const valid = items.filter((x) => typeof x?.[key] === 'number' && Number.isFinite(x[key]))
  if (!valid.length) return null
  return valid.reduce((sum, x) => sum + x[key], 0) / valid.length
}

function sumOf(items, key) {
  const valid = items.filter((x) => typeof x?.[key] === 'number' && Number.isFinite(x[key]))
  if (!valid.length) return null
  return valid.reduce((sum, x) => sum + x[key], 0)
}

function toNumber(value) {
  if (value == null || value === '') return null
  const num = Number(String(value).replace(/[+,]/g, '').trim())
  return Number.isFinite(num) ? Math.abs(num) : null
}

function normalizeDistrictLabel(label) {
  return normalizeName(String(label || '').replace(/\s+district$/i, '').trim())
}

function flattenCensusDataset(payload) {
  if (!Array.isArray(payload)) return []
  const rows = []

  for (const divisionBlock of payload) {
    const division = normalizeName(divisionBlock?.division)
    const districts = Array.isArray(divisionBlock?.districts) ? divisionBlock.districts : []

    for (const row of districts) {
      const district = normalizeName(row?.district)
      if (!district) continue

      rows.push({
        district,
        division,
        population: toNumber(row?.population),
        areaKm2: toNumber(row?.areaKm2),
        density: toNumber(row?.density),
        literacyRate: toNumber(row?.literacyRate),
        growthRate: toNumber(row?.growthRate),
      })
    }
  }

  return rows
}

async function fetchInternetDistrictDataset(canonicalDistricts) {
  const internetMap = new Map()

  try {
    let proxyJson = null
    for (const url of PROXY_WIKIDATA_DISTRICTS_URLS) {
      try {
        const response = await fetch(url)
        if (!response.ok) continue
        proxyJson = await response.json()
        break
      } catch {
        // Try next proxy URL.
      }
    }

    if (!proxyJson) throw new Error('proxy wikidata fetch failed')
    for (const row of proxyJson?.districts || []) {
      const district = normalizeDistrictLabel(row?.district)
      if (!district) continue
      internetMap.set(district, {
        district,
        population: toNumber(row?.population),
        areaKm2: toNumber(row?.areaKm2),
        literacyRate: null,
        growthRate: null,
        density: toNumber(row?.density),
      })
    }
  } catch {
    const url =
      `${WIKIDATA_SPARQL_URL}?format=json&query=` + encodeURIComponent(DISTRICT_STATS_QUERY)
    const response = await fetch(url, {
      headers: {
        Accept: 'application/sparql-results+json',
      },
    })

    if (!response.ok) {
      throw new Error('Wikidata district fetch failed')
    }

    const json = await response.json()
    const bindings = json?.results?.bindings || []

    for (const b of bindings) {
      const district = normalizeDistrictLabel(b?.districtLabel?.value)
      if (!district) continue

      const population = toNumber(b?.population?.value)
      const areaKm2 = toNumber(b?.area?.value)
      const density =
        isPositiveNumber(population) && isPositiveNumber(areaKm2)
          ? Number((population / areaKm2).toFixed(2))
          : null

      internetMap.set(district, {
        district,
        population,
        areaKm2,
        literacyRate: null,
        growthRate: null,
        density,
      })
    }
  }

  const districts = canonicalDistricts.map((district) => {
    return (
      internetMap.get(normalizeName(district)) || {
        district: normalizeName(district),
        population: null,
        areaKm2: null,
        literacyRate: null,
        growthRate: null,
        density: null,
      }
    )
  })

  const usableCount = districts.filter(
    (row) => isPositiveNumber(row.population) || isPositiveNumber(row.areaKm2)
  ).length

  if (usableCount === 0) {
    throw new Error('Live district API returned no usable records')
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'Wikidata SPARQL (P1082 population, P2046 area)',
    sourceUrl: 'https://query.wikidata.org/',
    usableCount,
    districts,
  }
}

function mergeDistrictDatasets(primaryRows = [], secondaryRows = []) {
  const map = new Map()

  for (const row of secondaryRows) {
    map.set(normalizeName(row?.district), { ...row, district: normalizeName(row?.district) })
  }

  for (const row of primaryRows) {
    const key = normalizeName(row?.district)
    const current = map.get(key) || { district: key }
    map.set(key, {
      ...current,
      district: key,
      population: isPositiveNumber(row?.population) ? row.population : current.population ?? null,
      areaKm2: isPositiveNumber(row?.areaKm2) ? row.areaKm2 : current.areaKm2 ?? null,
      literacyRate:
        isPositiveNumber(row?.literacyRate) || row?.literacyRate === 0
          ? row.literacyRate
          : current.literacyRate ?? null,
      growthRate:
        isPositiveNumber(row?.growthRate) || row?.growthRate === 0
          ? row.growthRate
          : current.growthRate ?? null,
      density: isPositiveNumber(row?.density) ? row.density : current.density ?? null,
    })
  }

  return Array.from(map.values())
}

async function fetchWorldBankIndicator(indicatorCode) {
  try {
    let proxyJson = null
    for (const baseUrl of PROXY_WORLDBANK_BGD_URLS) {
      const proxyUrl = `${baseUrl}?indicator=${encodeURIComponent(indicatorCode)}`
      try {
        const response = await fetch(proxyUrl)
        if (!response.ok) continue
        proxyJson = await response.json()
        break
      } catch {
        // Try next proxy URL.
      }
    }

    if (!proxyJson) throw new Error('proxy world bank fetch failed')
    return toNumber(proxyJson?.value)
  } catch {
    const url = `https://api.worldbank.org/v2/country/BGD/indicator/${indicatorCode}?format=json&mrv=8`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`World Bank API failed for ${indicatorCode}`)
    }

    const payload = await response.json()
    const series = Array.isArray(payload) ? payload[1] : null
    if (!Array.isArray(series)) return null

    const latest = series.find((item) => typeof item?.value === 'number' && Number.isFinite(item.value))
    return latest?.value ?? null
  }
}

async function fetchCountryBaselineFromApi() {
  const [populationRes, areaRes, literacyRes, growthRes] = await Promise.allSettled([
    fetchWorldBankIndicator('SP.POP.TOTL'),
    fetchWorldBankIndicator('AG.SRF.TOTL.K2'),
    fetchWorldBankIndicator('SE.ADT.LITR.ZS'),
    fetchWorldBankIndicator('SP.POP.GROW'),
  ])

  return {
    population:
      populationRes.status === 'fulfilled' && isPositiveNumber(populationRes.value)
        ? populationRes.value
        : COUNTRY_API_FALLBACK.population,
    areaKm2:
      areaRes.status === 'fulfilled' && isPositiveNumber(areaRes.value)
        ? areaRes.value
        : COUNTRY_API_FALLBACK.areaKm2,
    literacyRate:
      literacyRes.status === 'fulfilled' && isPositiveNumber(literacyRes.value)
        ? literacyRes.value
        : COUNTRY_API_FALLBACK.literacyRate,
    growthRate:
      growthRes.status === 'fulfilled' && isPositiveNumber(growthRes.value)
        ? growthRes.value
        : COUNTRY_API_FALLBACK.growthRate,
  }
}

function App() {
  const [divisions, setDivisions] = useState(null)
  const [districts, setDistricts] = useState(null)
  const [realDataset, setRealDataset] = useState(null)
  const [dummyDataset, setDummyDataset] = useState(null)
  const [countryBaseline, setCountryBaseline] = useState(COUNTRY_API_FALLBACK)
  const [datasetMode, setDatasetMode] = useState('loading')
  const [selectedDivision, setSelectedDivision] = useState(null)
  const [selectedDistrict, setSelectedDistrict] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    async function loadAll() {
      try {
        const [adm1Res, adm2Res, dummyRes] = await Promise.all([
          fetch(ADM1_URL),
          fetch(ADM2_URL),
          fetch(DUMMY_DB_URL),
        ])

        if (!adm1Res.ok || !adm2Res.ok || !dummyRes.ok) {
          throw new Error('Failed to load required local files from public/data')
        }

        const [adm1, adm2, dummy] = await Promise.all([
          adm1Res.json(),
          adm2Res.json(),
          dummyRes.json(),
        ])

        setDivisions({ ...adm1, features: adm1.features.map(normalizeOrientation) })
        setDistricts({ ...adm2, features: adm2.features.map(normalizeOrientation) })
        setDummyDataset(dummy)

        let censusRows = []
        try {
          const censusRes = await fetch(CENSUS_DB_URL)
          if (!censusRes.ok) throw new Error('census file missing')
          const censusPayload = await censusRes.json()
          censusRows = flattenCensusDataset(censusPayload)

          if (!censusRows.length) {
            throw new Error('census file has no district rows')
          }

          setRealDataset({
            generatedAt: new Date().toISOString(),
            source: 'Local census dataset (bd-census-data.json)',
            sourceUrl: CENSUS_DB_URL,
            districts: censusRows,
          })
          setDatasetMode('census')
          setError('')
        } catch {
          // Keep strict N/A mode if no usable local census file exists.
        }

        try {
          const canonicalDistricts = (dummy?.districts || []).map((row) => normalizeName(row.district))
          const internet = await fetchInternetDistrictDataset(canonicalDistricts)

          const mergedDistricts = mergeDistrictDatasets(internet.districts || [], censusRows)

          setRealDataset({
            generatedAt: internet.generatedAt,
            source: censusRows.length
              ? `${internet.source} merged with ${CENSUS_DB_URL}`
              : internet.source,
            sourceUrl: internet.sourceUrl,
            districts: mergedDistricts,
          })
          setDatasetMode(censusRows.length ? 'internet+census' : 'internet')
          setError('')
        } catch {
          if (!censusRows.length) {
            setRealDataset({
              generatedAt: null,
              source: 'Live internet data unavailable',
              sourceUrl: null,
              districts: (dummy?.districts || []).map((row) => ({
                district: normalizeName(row.district),
                population: null,
                areaKm2: null,
                literacyRate: null,
                growthRate: null,
                density: null,
              })),
            })
            setDatasetMode('unavailable')
            setError(
              'Live district API unavailable and census file missing. Start proxy with `npm.cmd run dev:proxy` or provide `public/data/bd-census-data.json`.'
            )
          } else {
            setDatasetMode('census')
          }
        }
      } catch (err) {
        setError(err.message || 'Could not load map data files')
      }
    }

    async function loadCountryBaseline() {
      try {
        const apiBaseline = await fetchCountryBaselineFromApi()
        setCountryBaseline(apiBaseline)
      } catch {
        setCountryBaseline(COUNTRY_API_FALLBACK)
      }
    }

    loadAll()
    loadCountryBaseline()
  }, [])

  const projection = useMemo(() => {
    if (!divisions) return null
    return geoMercator().fitSize([VIEWPORT.width, VIEWPORT.height], divisions)
  }, [divisions])

  const pathGenerator = useMemo(() => {
    if (!projection) return null
    return geoPath(projection)
  }, [projection])

  const divisionCentroids = useMemo(() => {
    if (!divisions) return []
    return divisions.features.map((d) => ({
      name: normalizeName(d.properties.shapeName),
      feature: d,
      centroid: geoCentroid(d),
    }))
  }, [divisions])

  const districtsWithDivision = useMemo(() => {
    if (!districts || !divisionCentroids.length) return []

    return districts.features.map((d) => {
      const center = geoCentroid(d)
      let parent = divisionCentroids.find((div) => geoContains(div.feature, center))

      if (!parent) {
        parent = divisionCentroids
          .map((div) => ({ div, dist: geoDistance(div.centroid, center) }))
          .sort((a, b) => a.dist - b.dist)[0]?.div
      }

      return {
        ...d,
        properties: {
          ...d.properties,
          shapeName: normalizeName(d.properties.shapeName),
          parentDivision: parent?.name || null,
        },
      }
    })
  }, [districts, divisionCentroids])

  const visibleDistricts = useMemo(() => {
    if (!selectedDivision) return []
    const divisionName = normalizeName(selectedDivision.properties.shapeName)
    return districtsWithDivision.filter((d) => d.properties.parentDivision === divisionName)
  }, [selectedDivision, districtsWithDivision])

  const realMap = useMemo(() => toDatasetMap(realDataset), [realDataset])

  function getDistrictRow(name) {
    const normalized = normalizeName(name)
    const real = realMap.get(normalized) || null
    return real
  }

  const facts = useMemo(() => {
    if (!divisions || !districtsWithDivision.length || !dummyDataset) return null

    if (selectedDistrict) {
      const name = normalizeName(selectedDistrict.properties.shapeName)
      const row = getDistrictRow(name)
      return {
        label: name,
        level: 'district',
        population: row?.population ?? null,
        areaKm2: row?.areaKm2 ?? null,
        literacyRate: row?.literacyRate ?? null,
        growthRate: row?.growthRate ?? null,
        geometryAreaKm2: steradiansToKm2(geoArea(selectedDistrict)),
      }
    }

    if (selectedDivision) {
      const divisionName = normalizeName(selectedDivision.properties.shapeName)
      const items = districtsWithDivision
        .filter((d) => d.properties.parentDivision === divisionName)
        .map((d) => getDistrictRow(d.properties.shapeName))
        .filter(Boolean)

      const population = sumOf(items, 'population')
      const areaKm2 = sumOf(items, 'areaKm2')
      const literacyRate = averageOf(items, 'literacyRate')
      const growthRate = averageOf(items, 'growthRate')

      return {
        label: divisionName,
        level: 'division',
        population,
        areaKm2,
        literacyRate,
        growthRate,
        geometryAreaKm2: steradiansToKm2(geoArea(selectedDivision)),
      }
    }

    const baseRows = (dummyDataset?.districts || [])
      .map((row) => getDistrictRow(row.district))
      .filter(Boolean)

    return {
      label:
        datasetMode === 'internet' || datasetMode === 'internet+census'
          ? 'Bangladesh (Live Internet Dataset)'
          : datasetMode === 'census'
            ? 'Bangladesh (Local Census Dataset)'
            : 'Bangladesh (Live Data Unavailable)',
      level: 'country',
      population: countryBaseline.population,
      areaKm2: countryBaseline.areaKm2,
      literacyRate: countryBaseline.literacyRate ?? averageOf(baseRows, 'literacyRate'),
      growthRate: countryBaseline.growthRate ?? averageOf(baseRows, 'growthRate'),
      geometryAreaKm2: null,
    }
  }, [
    divisions,
    districtsWithDivision,
    dummyDataset,
    realDataset,
    datasetMode,
    selectedDistrict,
    selectedDivision,
    realMap,
    countryBaseline,
  ])

  const density = useMemo(() => {
    if (!facts?.population || !facts?.areaKm2) return null
    return facts.population / facts.areaKm2
  }, [facts])

  const sourceText = useMemo(() => {
    if (datasetMode === 'internet+census') {
      return 'Most recent Census data (up to 2026). Some data also loaded from Wiki and public APIs.'
    }
    if (datasetMode === 'census') {
      return 'Most recent Census data (up to 2026).'
    }
    if (datasetMode === 'internet') {
      return 'Some data loaded from Wiki and public APIs.'
    }
    return 'Live data unavailable at the moment.'
  }, [datasetMode])

  const focusFeature = selectedDistrict || selectedDivision || divisions

  const mapTransform = useMemo(() => {
    if (!pathGenerator || !focusFeature) return 'translate(0 0) scale(1)'
    if (!selectedDivision && !selectedDistrict) return 'translate(0 0) scale(1)'
    const [[x0, y0], [x1, y1]] = pathGenerator.bounds(focusFeature)
    const dx = Math.max(1, x1 - x0)
    const dy = Math.max(1, y1 - y0)
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const scale = Math.min(8, 0.82 / Math.max(dx / VIEWPORT.width, dy / VIEWPORT.height))
    const tx = VIEWPORT.width / 2 - scale * cx
    const ty = VIEWPORT.height / 2 - scale * cy
    return `translate(${tx} ${ty}) scale(${scale})`
  }, [focusFeature, pathGenerator, selectedDivision, selectedDistrict])

  return (
    <main className="bd-layout">
      <header className="topbar">
        <h1 className="title-fancy">Bangladesh Info Map by Emon</h1>
        <p>
          Explore Bangladesh through interactive maps backed by real-world statistics.
        </p>
      </header>

      <section className="content-grid">
        <div className="map-shell">
          <div className="map-toolbar">
            <span>
              {selectedDistrict
                ? `Bangladesh > ${normalizeName(selectedDivision.properties.shapeName)} > ${normalizeName(selectedDistrict.properties.shapeName)}`
                : selectedDivision
                  ? `Bangladesh > ${normalizeName(selectedDivision.properties.shapeName)}`
                  : 'Bangladesh'}
            </span>
            <button
              type="button"
              onClick={() => {
                setSelectedDistrict(null)
                setSelectedDivision(null)
              }}
              disabled={!selectedDivision && !selectedDistrict}
            >
              Reset view
            </button>
          </div>

          <svg viewBox={`0 0 ${VIEWPORT.width} ${VIEWPORT.height}`} className="map-svg" role="img">
            <title>Interactive map of Bangladesh divisions and districts</title>
            {error ? (
              <text x="24" y="42" className="map-error">
                {error}
              </text>
            ) : null}

            {divisions && pathGenerator ? (
              <g transform={mapTransform}>
                {divisions.features.map((feature, idx) => {
                  const name = normalizeName(feature.properties.shapeName)
                  const isActive = normalizeName(selectedDivision?.properties?.shapeName) === name
                  return (
                    <path
                      key={`division-${idx}-${name}`}
                      d={pathGenerator(feature)}
                      className={`division ${isActive ? 'active' : ''}`}
                      fillRule="evenodd"
                      onClick={() => {
                        setSelectedDistrict(null)
                        setSelectedDivision(feature)
                      }}
                    >
                      <title>{name} Division</title>
                    </path>
                  )
                })}

                {visibleDistricts.map((feature, idx) => {
                  const name = normalizeName(feature.properties.shapeName)
                  const isActive = normalizeName(selectedDistrict?.properties?.shapeName) === name
                  return (
                    <path
                      key={`district-${idx}-${name}`}
                      d={pathGenerator(feature)}
                      className={`district ${isActive ? 'active' : ''}`}
                      fillRule="evenodd"
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedDistrict(feature)
                      }}
                    >
                      <title>{name} District</title>
                    </path>
                  )
                })}
              </g>
            ) : null}
          </svg>
        </div>

        <aside className="panel">
          <h2>{facts?.label || 'Loading...'}</h2>
          <p className="level-tag">{facts?.level || 'region'}</p>
          <p className="fetch-hint">
            {datasetMode === 'internet+census'
              ? 'Using live internet data first, with local census fallback for missing district values.'
              : datasetMode === 'internet'
                ? 'Live internet district stats only. Missing live values are shown as N/A.'
                : datasetMode === 'census'
                  ? 'Using verified census district statistics.'
                  : 'Live data unavailable. Metrics remain N/A until internet data is reachable.'}
          </p>

          <div className="stat-grid">
            <article>
              <span>Population</span>
              <strong>{formatNumber(facts?.population)}</strong>
            </article>
            <article>
              <span>Area (km²)</span>
              <strong>{formatNumber(facts?.areaKm2)}</strong>
            </article>
            <article>
              <span>Density (per km²)</span>
              <strong>{formatNumber(density)}</strong>
            </article>
            <article>
              <span>Literacy rate (%)</span>
              <strong>{facts?.literacyRate != null ? facts.literacyRate.toFixed(1) : 'N/A'}</strong>
            </article>
            <article>
              <span>Growth rate (%)</span>
              <strong>{facts?.growthRate != null ? facts.growthRate.toFixed(1) : 'N/A'}</strong>
            </article>
            <article>
              <span>Boundary area (km²)</span>
              <strong>{formatNumber(facts?.geometryAreaKm2)}</strong>
            </article>
          </div>

          <section className="source-block" aria-label="Data source">
            <h3>Source</h3>
            <p>{sourceText}</p>
          </section>

          <section className="contact-block" aria-label="Contact">
            <h3>Contact</h3>
            <p>Made with love for Bangladesh map lovers.</p>
            <p>Want to connect? Email: mhemon02 [at] gmail.com</p>
          </section>

        </aside>
      </section>
    </main>
  )
}

export default App
