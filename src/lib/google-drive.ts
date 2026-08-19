import { hasConsent } from "@/lib/consent";

/**
 * Cliente de Google Drive 100% en el navegador.
 *
 * Estrategia:
 *   - OAuth 2.0 con Google Identity Services (GIS), scope `drive.file`.
 *     Esto concede a la app acceso SOLO a los archivos que ella misma
 *     suba; no puede listar/eliminar archivos ajenos del usuario.
 *   - Llamadas REST a Drive API v3 con `fetch`. Sin `googleapis` para
 *     evitar ~2 MB de bundle innecesarios.
 *   - Subida RESUMABLE (uploadType=resumable) — los FITS pueden ser
 *     10–20 MB y la subida simple (`multipart/related`) falla >5 MB.
 *   - Caché en memoria de folder IDs para no re-consultar Drive por
 *     cada archivo cuando hay 100+ FITS en una secuencia.
 *
 * Token storage:
 *   - El access token se guarda en `localStorage` con timestamp de
 *     expiración. GIS entrega tokens con `expires_in` (~1 h); al
 *     caducar, `getValidToken()` lo borra y devuelve `null`,
 *     obligando a re-autenticar.
 *
 * Variables de entorno:
 *   - `PUBLIC_GOOGLE_CLIENT_ID` (Astro expone al cliente cualquier
 *     variable prefijada con `PUBLIC_`). Es público por diseño: las
 *     OAuth client IDs de SPAs no son secretos.
 *
 * Privacidad / seguridad:
 *   - No usamos refresh tokens: solo access tokens de corta duración.
 *   - El `signOut()` revoca el token en Google Y lo borra del storage.
 *   - Si en algún momento se quiere endurecer, basta con añadir
 *     `code_challenge` (PKCE) aquí — GIS ya lo soporta.
 */

// En Astro/Vite, las variables `PUBLIC_*` se inyectan en
// `import.meta.env`. Si por algún motivo no está definida (build
// sin .env), usamos un placeholder vacío: las llamadas fallarán con
// un error claro y no se rompe el bundle.
const CLIENT_ID: string =
  (import.meta.env?.PUBLIC_GOOGLE_CLIENT_ID as string | undefined) ?? "";

// Scope: `drive.file` = solo los archivos que esta app suba.
// NO usamos `drive` completo porque dispara la pantalla de
// "Google no ha verificado esta app" en cuentas de consumer.
const SCOPES = "https://www.googleapis.com/auth/drive.file";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// ============================================================================
// Tipos públicos
// ============================================================================

export type DriveFile = { path: string; file: string };

export type UploadProgress = {
  total: number;
  done: number;
  current: string;
  phase:
    | "idle"
    | "preparing"
    | "uploading"
    | "done"
    | "error";
  errorMsg?: string;
  // ID de la carpeta raíz `EXOTIC/<target>/` para mostrar link al final.
  rootFolderId?: string;
  rootFolderUrl?: string;
};

// ============================================================================
// Token storage
// ============================================================================

const TOKEN_KEY = "mo.drive.token";
const EXPIRY_KEY = "mo.drive.expiry";
let memoryToken: StoredToken | null = null;

type StoredToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

function readStoredToken(): StoredToken | null {
  if (!hasConsent("functional")) return memoryToken;
  if (typeof localStorage === "undefined") return null;
  try {
    const accessToken = localStorage.getItem(TOKEN_KEY);
    const expiresAtStr = localStorage.getItem(EXPIRY_KEY);
    if (!accessToken || !expiresAtStr) return null;
    const expiresAt = parseInt(expiresAtStr, 10);
    if (!Number.isFinite(expiresAt)) return null;
    // Margen de 60 s: si expira en <60 s, lo consideramos inválido
    // para no fallar a mitad de una subida larga.
    if (Date.now() > expiresAt - 60_000) {
      clearStoredToken();
      return null;
    }
    return { accessToken, expiresAt };
  } catch {
    return null;
  }
}

function writeStoredToken(accessToken: string, expiresInSec: number): void {
  const expiresAt = Date.now() + expiresInSec * 1000;
  memoryToken = { accessToken, expiresAt };
  if (!hasConsent("functional")) return;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TOKEN_KEY, accessToken);
    localStorage.setItem(EXPIRY_KEY, String(expiresAt));
  } catch {
    /* quota / private mode */
  }
}

function clearStoredToken(): void {
  memoryToken = null;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRY_KEY);
  } catch {
    /* ignore */
  }
}

/** Devuelve un token válido o `null` si no hay sesión / ha expirado. */
export function getValidToken(): string | null {
  const t = readStoredToken();
  return t?.accessToken ?? null;
}

// ============================================================================
// Google Identity Services (carga perezosa del script + OAuth popup)
// ============================================================================

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: TokenResponse) => void;
            error_callback?: (err: unknown) => void;
          }) => TokenClient;
          revoke: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  error?: string;
  error_description?: string;
};

type TokenClient = {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
};

let gisLoadingPromise: Promise<void> | null = null;

/** Carga el script de GIS UNA sola vez. Las siguientes llamadas resuelven
 *  inmediatamente. Devuelve Promise<void> para poder `await`. */
export function loadGis(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Drive only works in the browser"));
  }
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadingPromise) return gisLoadingPromise;

  gisLoadingPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-mo="gis"]',
    );
    if (existing) {
      // Rara vez ocurre (p.ej. HMR), pero si ya está inyectado esperamos
      // a que `window.google` aparezca.
      const start = Date.now();
      const tick = () => {
        if (window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - start > 5000) {
          return reject(new Error("GIS script did not initialize"));
        }
        setTimeout(tick, 50);
      };
      tick();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.mo = "gis";
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve();
      else reject(new Error("GIS script loaded but window.google missing"));
    };
    script.onerror = () =>
      reject(new Error("Could not load Google Identity Services"));
    document.head.appendChild(script);
  });
  return gisLoadingPromise;
}

/** Abre el popup de consentimiento. La primera vez muestra la pantalla
 *  completa; en llamadas siguientes, con `prompt=""`, sale silencioso.
 *  Devuelve el access token (y lo persiste en localStorage). */
export async function signIn(): Promise<string> {
  if (!CLIENT_ID) {
    throw new Error(
      "PUBLIC_GOOGLE_CLIENT_ID is not set. Add it to .env (see README).",
    );
  }
  await loadGis();
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) {
          reject(
            new Error(
              resp.error_description || resp.error || "Google sign-in failed",
            ),
          );
          return;
        }
        writeStoredToken(resp.access_token, resp.expires_in);
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        const e = err as { type?: string; message?: string };
        // "popup_closed" / "user_cancel" no son errores reales.
        if (e?.type === "popup_closed" || e?.type === "user_cancel") {
          reject(new Error("Sign-in cancelled"));
        } else {
          reject(new Error(e?.message || e?.type || "Google sign-in failed"));
        }
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

/** Revoca el token en Google y lo borra del storage. Idempotente. */
export async function signOut(): Promise<void> {
  const tok = getValidToken();
  if (tok) {
    try {
      await loadGis();
      window.google!.accounts.oauth2.revoke(tok, () => {
        /* noop */
      });
    } catch {
      /* si GIS no carga, al menos limpiamos local */
    }
  }
  clearStoredToken();
  folderCache.clear();
}

// ============================================================================
// Caché de folder IDs (en memoria, vida = sesión del navegador)
// ============================================================================

// clave = `${parentId}::${name}` -> folderId
const folderCache = new Map<string, string>();

function cacheKey(parentId: string, name: string): string {
  return `${parentId}::${name}`;
}

// ============================================================================
// Drive API helpers (internos)
// ============================================================================

/** Quita comillas de un string que podría venir `name = 'foo'`
 *  en una respuesta JSON. No es estrictamente necesario para `files.list`
 *  pero lo dejamos por si en el futuro parseamos a mano. */
function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/** Busca una carpeta con `name` dentro de `parentId`. Devuelve su ID
 *  o `null` si no existe. */
async function findFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<string | null> {
  // `name` se escapa: la sintaxis de Drive `q=` no admite caracteres
  // especiales sin escapar. Usamos comillas simples y duplicamos las
  // comillas internas (regla estándar de Drive API).
  const safeName = name.replace(/'/g, "\\'");
  const q = [
    `'${parentId}' in parents`,
    `name = '${safeName}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ].join(" and ");
  const url = `${DRIVE_FILES}?q=${encodeURIComponent(
    q,
  )}&fields=files(id,name)&pageSize=1`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `Drive list failed (${r.status}): ${body.slice(0, 200) || r.statusText}`,
    );
  }
  const data = (await r.json()) as { files?: Array<{ id: string; name: string }> };
  return data.files?.[0]?.id ?? null;
}

/** Crea una carpeta y devuelve su ID. */
async function createFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<string> {
  const meta = {
    name: stripQuotes(name),
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
  };
  const r = await fetch(DRIVE_FILES, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(meta),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `Drive mkdir failed (${r.status}): ${body.slice(0, 200) || r.statusText}`,
    );
  }
  const data = (await r.json()) as { id: string };
  return data.id;
}

/** Devuelve el ID de la carpeta `name` bajo `parentId`, creándola si
 *  no existe. Usa `folderCache` para evitar viajes de ida y vuelta. */
async function ensureFolder(
  accessToken: string,
  parentId: string,
  name: string,
): Promise<string> {
  const key = cacheKey(parentId, name);
  const cached = folderCache.get(key);
  if (cached) return cached;
  const existing = await findFolder(accessToken, parentId, name);
  if (existing) {
    folderCache.set(key, existing);
    return existing;
  }
  const created = await createFolder(accessToken, parentId, name);
  folderCache.set(key, created);
  return created;
}

/** Crea/encadena una serie de carpetas anidadas, partiendo de `root`
 *  (típicamente "root" para Mi unidad). Devuelve el ID de la hoja. */
async function ensureFolderChain(
  accessToken: string,
  segments: string[],
): Promise<string> {
  let parent = "root";
  for (const seg of segments) {
    parent = await ensureFolder(accessToken, parent, seg);
  }
  return parent;
}

// ============================================================================
// Subida resumible
// ============================================================================

/** Sube un blob a `parentId` con nombre `name`. Usa uploadType=resumable
 *  para soportar archivos grandes (FITS pueden ser 10-20 MB). */
async function uploadFileResumable(
  accessToken: string,
  parentId: string,
  name: string,
  blob: Blob,
): Promise<{ id: string; name: string }> {
  // 1) Pedimos la sesión de subida
  const initRes = await fetch(
    `${DRIVE_UPLOAD}?uploadType=resumable`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": blob.type || "application/octet-stream",
        "X-Upload-Content-Length": String(blob.size),
      },
      body: JSON.stringify({ name, parents: [parentId] }),
    },
  );
  if (!initRes.ok) {
    const body = await initRes.text().catch(() => "");
    throw new Error(
      `Drive init upload failed (${initRes.status}): ${
        body.slice(0, 200) || initRes.statusText
      }`,
    );
  }
  const sessionUri = initRes.headers.get("Location");
  if (!sessionUri) {
    throw new Error("Drive did not return a session URI");
  }

  // 2) Subimos el binario PUT a la session URI.
  //    Drive ignora el `Content-Type` que enviamos aquí (debe coincidir
  //    con X-Upload-Content-Type), pero algunos proxies intermedios
  //    lo respetan. Lo dejamos binario.
  const putRes = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "Content-Length": String(blob.size),
    },
    body: blob,
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(
      `Drive upload failed (${putRes.status}): ${
        body.slice(0, 200) || putRes.statusText
      }`,
    );
  }
  const data = (await putRes.json()) as { id: string; name: string };
  return data;
}

// ============================================================================
// API pública de subida en lote
// ============================================================================

/** Sube `files` a `EXOTIC/<target>/...` replicando la estructura del ZIP.
 *  Devuelve el ID y la URL de la carpeta raíz del target. */
export async function uploadSequenceToDrive(
  accessToken: string,
  target: string,
  files: DriveFile[],
  onProgress: (p: UploadProgress) => void,
): Promise<{ rootFolderId: string; rootFolderUrl: string }> {
  if (files.length === 0) {
    throw new Error("No files to upload");
  }
  onProgress({ total: files.length, done: 0, current: "", phase: "preparing" });

  // 1) Asegurar la cadena EXOTIC/<target>/...
  const rootId = await ensureFolderChain(accessToken, ["EXOTIC", target]);
  const rootFolderUrl = `https://drive.google.com/drive/folders/${rootId}`;

  // 2) Construir (parentId, name, blobPath) por cada FITS.
  //    Para no descargar todos los blobs upfront (un tránsito puede
  //    ser 100+ imágenes = >1 GB en memoria), hacemos fetch por archivo
  //    justo antes de subirlo.
  type Job = {
    parentId: string;
    name: string;
    url: string; // FITS proxy URL
  };
  const jobs: Job[] = [];
  for (const f of files) {
    // f.path tiene la forma "YYYYMMDD/xxx.fits" o "YYYYMMDD/darks/yyy.fits"
    const segs = f.path.split("/").filter(Boolean);
    // El primer segmento es la fecha; lo unimos con el target raíz
    // para formar: EXOTIC/<target>/<date>[/darks]
    let parentId = rootId;
    for (let i = 0; i < segs.length - 1; i++) {
      parentId = await ensureFolder(accessToken, parentId, segs[i]);
    }
    jobs.push({
      parentId,
      name: segs[segs.length - 1],
      url: `/api/fits/${encodeURIComponent(f.file)}`,
    });
  }

  // 3) Pool de workers con concurrencia limitada (4) — mismo número
  //    que la descarga ZIP. Drive tolera 1000 req/100s, así que 4
  //    concurrentes para N archivos ≈ 4 req en vuelo, muy lejos del
  //    límite. Si el usuario tiene una conexión lenta, subir más en
  //    paralelo no ayuda y puede saturar el ancho de banda.
  const concurrency = 4;
  let done = 0;
  let failed = 0;

  async function worker(queue: Job[]): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      onProgress({
        total: files.length,
        done,
        current: job.name,
        phase: "uploading",
        rootFolderId: rootId,
        rootFolderUrl,
      });
      try {
        const r = await fetch(job.url);
        if (!r.ok) throw new Error(`FITS HTTP ${r.status}`);
        const blob = await r.blob();
        await uploadFileResumable(accessToken, job.parentId, job.name, blob);
      } catch (e) {
        failed++;
        console.error("Drive upload failed:", job.name, e);
      }
      done++;
    }
  }

  const queues: Job[][] = Array.from({ length: concurrency }, () => []);
  jobs.forEach((j, i) => queues[i % concurrency].push(j));
  await Promise.all(queues.map(worker));

  if (failed > 0) {
    throw new Error(
      `${failed} of ${files.length} files failed to upload to Drive`,
    );
  }
  onProgress({
    total: files.length,
    done: files.length,
    current: "",
    phase: "done",
    rootFolderId: rootId,
    rootFolderUrl,
  });
  return { rootFolderId: rootId, rootFolderUrl };
}
