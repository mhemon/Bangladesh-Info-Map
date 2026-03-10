const CANONICAL_DISTRICTS = [
  'Bagerhat',
  'Bandarban',
  'Barguna',
  'Barishal',
  'Bhola',
  'Bogra',
  'Brahmanbaria',
  'Chandpur',
  'Chapai Nawabganj',
  'Chattogram',
  'Chuadanga',
  "Cox's Bazar",
  'Cumilla',
  'Dhaka',
  'Dinajpur',
  'Faridpur',
  'Feni',
  'Gaibandha',
  'Gazipur',
  'Gopalganj',
  'Habiganj',
  'Jamalpur',
  'Jashore',
  'Jhalokati',
  'Jhenaidah',
  'Joypurhat',
  'Khagrachhari',
  'Khulna',
  'Kishoreganj',
  'Kurigram',
  'Kushtia',
  'Lakshmipur',
  'Lalmonirhat',
  'Madaripur',
  'Magura',
  'Manikganj',
  'Meherpur',
  'Moulvibazar',
  'Munshiganj',
  'Mymensingh',
  'Naogaon',
  'Narail',
  'Narayanganj',
  'Narsingdi',
  'Natore',
  'Netrokona',
  'Nilphamari',
  'Noakhali',
  'Pabna',
  'Panchagarh',
  'Patuakhali',
  'Pirojpur',
  'Rajbari',
  'Rajshahi',
  'Rangamati',
  'Rangpur',
  'Satkhira',
  'Shariatpur',
  'Sherpur',
  'Sirajganj',
  'Sunamganj',
  'Sylhet',
  'Tangail',
  'Thakurgaon',
]

const ALIASES = {
  barisal: 'Barishal',
  bogura: 'Bogra',
  brahamanbaria: 'Brahmanbaria',
  brahmanbaria: 'Brahmanbaria',
  chapainawabganj: 'Chapai Nawabganj',
  chapai_nawabganj: 'Chapai Nawabganj',
  chittagong: 'Chattogram',
  comilla: 'Cumilla',
  coxsbazar: "Cox's Bazar",
  coxs_bazar: "Cox's Bazar",
  jessore: 'Jashore',
  moulvibazar: 'Moulvibazar',
  maulvibazar: 'Moulvibazar',
  netrokona: 'Netrokona',
  narshingdi: 'Narsingdi',
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

const DISTRICT_BY_KEY = new Map(
  CANONICAL_DISTRICTS.map((name) => [normalizeKey(name), name])
)

for (const [alias, canonical] of Object.entries(ALIASES)) {
  DISTRICT_BY_KEY.set(normalizeKey(alias), canonical)
}

function canonicalizeDistrictName(rawName) {
  const key = normalizeKey(rawName)
  return DISTRICT_BY_KEY.get(key) || null
}

function validateDistrictNames(rows, districtField = 'district') {
  const unknown = []
  const canonicalRows = []

  for (const row of rows) {
    const raw = row?.[districtField]
    const canonical = canonicalizeDistrictName(raw)
    if (!canonical) {
      unknown.push(raw)
      continue
    }
    canonicalRows.push({ ...row, [districtField]: canonical })
  }

  const uniqueCanonical = new Set(canonicalRows.map((r) => r[districtField]))
  const missing = CANONICAL_DISTRICTS.filter((name) => !uniqueCanonical.has(name))

  return {
    ok: unknown.length === 0 && missing.length === 0,
    unknown,
    missing,
    canonicalRows,
  }
}

export {
  ALIASES,
  CANONICAL_DISTRICTS,
  canonicalizeDistrictName,
  validateDistrictNames,
}
