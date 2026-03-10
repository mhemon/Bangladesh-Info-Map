# BD Maps

React project scaffolded with Vite.

## Run

Use Command Prompt or PowerShell with command shims:

```powershell
npm.cmd install
npm.cmd run dev
```

## Build

```powershell
npm.cmd run build
npm.cmd run preview
```

## Publish To GitHub

If `git` is not installed yet, install **Git for Windows** first:

1. Download from https://git-scm.com/download/win
2. Re-open terminal after installation.

Then run:

```powershell
cd "d:\Test\BD Maps"
git init
git add .
git commit -m "Initial commit: Bangladesh Info Map"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## Deploy To Vercel

### Option A: Vercel Dashboard (easiest)

1. Push your repo to GitHub.
2. Go to https://vercel.com/new
3. Import your GitHub repository.
4. Framework preset: `Vite` (auto-detected)
5. Build command: `npm run build`
6. Output directory: `dist`
7. Click Deploy.

### Option B: Vercel CLI

```powershell
npm.cmd install -g vercel
cd "d:\Test\BD Maps"
vercel
vercel --prod
```

## Notes

- This app reads local data files from `public/data` and can also fetch live API data via the proxy server.
- For reliable live API mode during development, run proxy in a separate terminal:

```powershell
npm.cmd run dev:proxy
```
