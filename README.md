# MicroObservatory Downloader — Web

Sitio estático (Astro + React island) que replica la lógica de
`download_mo.py` con UI en el navegador, descargando FITS como ZIP.

## Stack

- **Astro 5** (server output) + **TypeScript estricto**
- **@astrojs/netlify** adapter — API routes se despliegan como Netlify Functions
- **@astrojs/react** — única island para el formulario + preview + descarga
- **JSZip** — empaquetado en el cliente
- **cheerio** — parseo HTML server-side (en la Function)

## Arquitectura

```
src/
├── pages/
│   ├── index.astro              ← UI principal
│   └── api/
│       ├── preview.ts           ← POST: aplica filtros y devuelve JSON
│       └── fits/[file].ts       ← GET: proxy CORS de un FITS desde MO
├── lib/
│   ├── targets.ts               ← lista de exoplanetas
│   ├── filters.ts               ← applyGapFilter + helpers (puerto del .py)
│   └── mo-client.ts             ← fetchHtml + parseRows (cheerio)
├── components/
│   └── Downloader.tsx           ← island React: form + preview + zip
└── styles/
    └── global.css
```

## Setup local

```bash
cd web/
npm install
npm run dev          # http://localhost:4321
```

## Build + deploy a Netlify

```bash
npm install -g netlify-cli   # solo la primera vez
netlify login
netlify init                  # enlaza con el sitio (o crea uno nuevo)
netlify deploy --prod
```

O conectar el repo a Netlify directamente (build command `npm run build`,
publish dir `dist`).

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| `POST` | `/api/preview` | Body: `{target, date?, threshold?, telescope?}`. Devuelve JSON con `transitByDate`, `transitDiscarded`, telescopios descubiertos, etc. |
| `GET` | `/api/fits/{filename}` | Proxy de `https://mo-www.cfa.harvard.edu/ImageDirectory/{filename}`. Cabeceras CORS abiertas. |
| `OPTIONS` | `/api/fits/{filename}` | Pre-flight CORS. |

## Reglas de filtrado (idénticas al script Python)

**Tránsito** (`weather_sensitive=true`):
- weather < threshold → descartar
- gap 4-5 min + vecino nuboso → descartar
- gap 5-30 min → descartar
- gap ≥ 30 min → OK (corte de sesión)
- gap < 4 min → OK

**Darks** (sin filtros adicionales):
- Solo se usan los que existan en la fecha de un tránsito válido

**Regla global**: una fecha solo se descarga si tiene tránsito Y darks
del telescopio elegido (toggle "Requerir darks").

## Limitaciones Netlify

- **Funciones free tier**: 10s de ejecución, 1024 MB RAM, 6 MB body.
- El endpoint `/api/preview` solo hace fetch de HTML + filtrado (sin FITS),
  encaja sin problemas.
- El proxy `/api/fits/[file]` hace streaming de un único FITS (~656 KB)
  por request, sin retención en memoria.
- La descarga masiva + zip se hace en el cliente con `JSZip` (4 workers
  en paralelo), evitando los límites del servidor.
