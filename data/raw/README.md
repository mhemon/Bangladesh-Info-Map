# Raw Real-Data Inputs

Put your source files here, then run:

`npm run build:data`

Accepted file types:
- `.csv`
- `.xlsx`
- `.xls`

Expected columns:
- one district column: `district` or `zila` or similar
- metric columns with recognizable names, for example:
  - `population`
  - `area_km2`
  - `literacy_rate`
  - `growth_rate`
  - `density`

The build script outputs:
- `public/data/bd-real-stats.json`

Strict validator rules (default):
- every district name must resolve to one of the 64 Bangladesh districts
- no unknown district names allowed
- all 64 districts must appear (unless `--allow-missing` is used)
