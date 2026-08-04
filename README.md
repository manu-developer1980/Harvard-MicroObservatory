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
cp .env.example .env       # edita PUBLIC_GOOGLE_CLIENT_ID (ver sección Drive)
npm install
npm run dev                # http://localhost:4321
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

## Google Drive upload

La app permite subir la misma secuencia de FITS a una carpeta
`EXOTIC/<target>/` de tu Google Drive, replicando la estructura del ZIP
(`<date>/<fits>` y `<date>/darks/<fits>`).

### Cómo funciona

- OAuth 2.0 con **Google Identity Services** en el navegador, scope
  `https://www.googleapis.com/auth/drive.file`. La app solo puede ver
  y gestionar los archivos que ella misma suba; **no** tiene acceso al
  resto de tu Drive.
- El access token se guarda en `localStorage` con su `expires_in`
  (~1 h). Al caducar, la app te pide re-autenticar.
- Las subidas usan `uploadType=resumable` para soportar FITS grandes
  (10–20 MB).
- Concurrencia: 4 workers en paralelo (igual que la descarga ZIP),
  muy por debajo del rate limit de Drive (1000 req / 100 s).
- Si ya tienes la carpeta `EXOTIC/` y/o `EXOTIC/<target>/` en tu Drive,
  se reutilizan: el sistema cachea los folder IDs en memoria durante
  la sesión.

### Setup (solo una vez)

1. **Google Cloud Console** → [console.cloud.google.com](https://console.cloud.google.com/).
2. Crea un proyecto (o reutiliza uno existente).
3. **APIs & Services → Library** → habilita **Google Drive API**.
4. **APIs & Services → OAuth consent screen**:
   - User type: **External** (o Internal si usas Google Workspace).
   - Scopes: añade `https://www.googleapis.com/auth/drive.file`.
   - Test users: añade tu email mientras esté en modo "Testing".
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins:
     - `http://localhost:4321` (dev)
     - `https://tu-sitio.netlify.app` (producción)
6. Copia el **Client ID** y pégalo en `web/.env`:
   ```
   PUBLIC_GOOGLE_CLIENT_ID=1234567890-abc...xyz.apps.googleusercontent.com
   ```
7. Reinicia `npm run dev`. El botón "Sign in with Google Drive"
   debería abrir el popup de consentimiento en el primer click.

### Lo que la app NO hace (por diseño)

- **No** sube el ZIP completo: sube los FITS sueltos con la
  estructura de carpetas, más útil para EXOTIC.
- **No** comparte la carpeta con nadie: queda privada en tu cuenta.
- **No** usa refresh tokens: solo access tokens de corta duración
  guardados en `localStorage`. Si quieres más seguridad, cierra
  sesión con el botón "Desconectar" tras subir.
- **No** se reintenta automáticamente en subidas fallidas: el error
  se muestra en la barra de progreso y puedes volver a pulsar "Subir".
