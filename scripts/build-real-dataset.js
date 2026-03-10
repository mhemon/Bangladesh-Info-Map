import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import * as XLSX from 'xlsx'
import {
  CANONICAL_DISTRICTS,
  canonicalizeDistrictName,
} from './district-name-validator.js'

const DEFAULT_INPUT_DIR = 'data/raw'
const DEFAULT_OUTPUT_FILE = 'public/data/bd-real-stats.json'

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT_DIR,
    output: DEFAULT_OUTPUT_FILE,
    allowMissing: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--input' && argv[i + 1]) {
      args.input = argv[i + 1]
      i += 1
    } else if (token === '--output' && argv[i + 1]) {
      args.output = argv[i + 1]
      i += 1
    } else if (token === '--allow-missing') {
      args.allowMissing = true
    }
  }

  return args
}

function readDataFiles(inputDir) {
  if (!fs.existsSync(inputDir)) return []
  return fs
    .readdirSync(inputDir)
    .filter((name) => /\.(csv|xlsx|xls)$/i.test(name))
    .map((name) => path.join(inputDir, name))
}

function toNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/%/g, '')
    .trim()

  if (!cleaned) return null
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

function pickDistrictColumn(headers) {
  const normalized = headers.map((h) => String(h || '').toLowerCase())
  const exact = normalized.findIndex((h) => h === 'district' || h === 'zila' || h === 'zilla')
  if (exact >= 0) return headers[exact]

  const fuzzy = normalized.findIndex((h) => /district|zila|zilla/.test(h))
  if (fuzzy >= 0) return headers[fuzzy]

  const nameLike = normalized.findIndex((h) => /name/.test(h))
  if (nameLike >= 0) return headers[nameLike]

  return null
}

function mapMetricField(header) {
  const h = String(header || '').toLowerCase()
  if (/population|pop/.test(h)) return 'population'
  if (/area/.test(h) && /km|sq/.test(h)) return 'areaKm2'
  if (/literacy/.test(h)) return 'literacyRate'
  if (/growth/.test(h)) return 'growthRate'
  if (/density/.test(h)) return 'density'
  return null
}

function rowsFromFile(filePath) {
  const workbook = XLSX.readFile(filePath)
  const rows = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null })
    rows.push(...rawRows)
  }

  return rows
}

function mergeRowsIntoMap(rows, sourceName, merged, unknownDistricts) {
  if (!rows.length) return

  const headers = Object.keys(rows[0])
  const districtCol = pickDistrictColumn(headers)

  if (!districtCol) {
    console.warn(`[skip] ${sourceName}: no district/zila column found`)
    return
  }

  for (const row of rows) {
    const canonical = canonicalizeDistrictName(row[districtCol])
    if (!canonical) {
      unknownDistricts.add(String(row[districtCol] || '').trim())
      continue
    }

    const current = merged.get(canonical) || {
      district: canonical,
      population: null,
      areaKm2: null,
      literacyRate: null,
      growthRate: null,
      density: null,
      _sources: {},
    }

    for (const [header, value] of Object.entries(row)) {
      if (header === districtCol) continue
      const metric = mapMetricField(header)
      if (!metric) continue

      const parsed = toNumber(value)
      if (parsed == null) continue

      current[metric] = parsed
      current._sources[metric] = sourceName
    }

    merged.set(canonical, current)
  }
}

function buildDataset(inputDir, allowMissing) {
  const files = readDataFiles(inputDir)
  if (!files.length) {
    throw new Error(
      `No CSV/XLSX files found in ${inputDir}. Put your raw files there first.`
    )
  }

  const merged = new Map()
  const unknownDistricts = new Set()

  for (const filePath of files) {
    const rows = rowsFromFile(filePath)
    mergeRowsIntoMap(rows, path.basename(filePath), merged, unknownDistricts)
  }

  if (unknownDistricts.size) {
    const items = [...unknownDistricts].filter(Boolean).sort()
    throw new Error(
      `Unknown district names found (${items.length}): ${items.join(', ')}`
    )
  }

  const districts = CANONICAL_DISTRICTS.map((district) => {
    const row = merged.get(district)
    if (!row) {
      return {
        district,
        population: null,
        areaKm2: null,
        literacyRate: null,
        growthRate: null,
        density: null,
      }
    }

    return {
      district: row.district,
      population: row.population,
      areaKm2: row.areaKm2,
      literacyRate: row.literacyRate,
      growthRate: row.growthRate,
      density: row.density,
    }
  })

  const missingDistricts = districts
    .filter((d) =>
      d.population == null &&
      d.areaKm2 == null &&
      d.literacyRate == null &&
      d.growthRate == null &&
      d.density == null
    )
    .map((d) => d.district)

  if (!allowMissing && missingDistricts.length) {
    throw new Error(
      `Strict validation failed. Missing data for ${missingDistricts.length} districts: ${missingDistricts.join(', ')}`
    )
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceFiles: files.map((f) => path.basename(f)),
    count: districts.length,
    strictValidation: !allowMissing,
    missingDistricts,
    districts,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outputDir = path.dirname(args.output)

  const dataset = buildDataset(args.input, args.allowMissing)

  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(dataset, null, 2))

  console.log(`[ok] wrote ${args.output}`)
  console.log(`[info] districts: ${dataset.count}`)
  console.log(`[info] missing districts: ${dataset.missingDistricts.length}`)
}

main()
