# Bangladesh Info Map

Bangladesh Info Map is an interactive web app for exploring Bangladesh through a clickable map of divisions and districts.

The project combines map boundaries with real-world statistics so users can quickly view and compare regional information.

## Live Link

https://bangladesh-info-map.vercel.app/

## What You Can Do

- View Bangladesh at country, division, and district levels.
- Click divisions to zoom in and explore districts.
- Click districts to see local metrics.
- Check key stats such as population, area, density, literacy rate, and growth rate.
- Use map-based boundary area for geographic context.

## Project Highlights

- Built with React + Vite.
- Interactive SVG map rendering.
- Local census dataset support.
- Optional live API enrichment for additional data.
- Fallback-safe display (`N/A`) for missing values.

## Tech Stack

- React
- Vite
- d3-geo
- JavaScript (ESM)

## Local Development

```powershell
npm install
npm run dev
```

## Build For Production

```powershell
npm run build
```

## Notes

- Main data files are in `public/data/`.
- The app is designed to stay usable even when some live data fields are unavailable.


