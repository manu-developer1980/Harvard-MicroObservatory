/**
 * CORS dinámico para el proxy FITS.
 *
 * POR QUÉ NO USAR `Access-Control-Allow-Origin: *`
 * -----------------------------------------------
 * El proxy FITS sirve archivos públicos de MicroObservatory. Permitir
 * CORS universal (`*`) significa que cualquier web puede usar nuestro
 * dominio como proxy gratuito, incurriendo en (a) consumo de ancho de
 * banda facturable a nuestra cuenta de Netlify/CDN, (b) posible DoS,
 * (c) daño reputacional si el proxy se usa para actividades abusivas.
 *
 * La solución correcta es la allowlist dinámica:
 *   - Si el `Origin` de la petición está en la allowlist, lo "espejamos"
 *     en `Access-Control-Allow-Origin`.
 *   - Si no está, NO emitimos la cabecera → el navegador bloqueará el
 *     cross-origin XHR/fetch del cliente no autorizado.
 *   - SIEMPRE emitimos `Vary: Origin` para que la CDN no cachee una
 *     respuesta CORS de un origen y la sirva a otro (cache poisoning).
 *
 * CONFIGURACIÓN
 * -------------
 * Variable de entorno server-only `ALLOWED_FITS_ORIGINS` (sin
 * prefijo `PUBLIC_` para que no se exponga al bundle del cliente).
 * Formato: lista separada por comas. Sin espacios.
 *
 *   ALLOWED_FITS_ORIGINS=https://exotic.example.com,https://staging.example.com
 *
 * En desarrollo (`import.meta.env.DEV === true`) el helper añade
 * `http://localhost:4321` y `http://localhost:8888` (Netlify dev) por
 * defecto para que `npm run dev` funcione sin configurar nada.
 *
 * En producción, si la variable no está definida, NO se permite ningún
 * origen (deny-by-default). Configurar explícitamente.
 */
export type CorsEnv = {
  /** Lista cruda parseada de `ALLOWED_FITS_ORIGINS` (puede incluir
   *  comillas o espacios que limpiamos aquí). Vacío = deny-all. */
  allowedOrigins?: string | undefined;
  /** Si true, añadimos los localhost comunes a la allowlist. */
  isDev?: boolean;
};

/** Normaliza un origin: trim, lowercase del scheme+host, sin path.
 *  Devuelve null si no parece un origin válido. */
function normalizeOrigin(o: string | null | undefined): string | null {
  if (!o) return null;
  const trimmed = o.trim();
  if (!trimmed) return null;
  // Validación muy laxa: tiene que empezar por http(s):// y no contener
  // espacios. La validación estricta la hace el browser cuando recibe
  // la cabecera; aquí solo evitamos valores obviously-wrong.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/** Parsea la env var `ALLOWED_FITS_ORIGINS` a un Set normalizado. */
function parseAllowed(env: CorsEnv): Set<string> {
  const out = new Set<string>();
  if (env.allowedOrigins) {
    for (const raw of env.allowedOrigins.split(",")) {
      const norm = normalizeOrigin(raw);
      if (norm) out.add(norm);
    }
  }
  if (env.isDev) {
    // Defaults de dev. NO se añaden en producción (deny-by-default).
    for (const d of [
      "http://localhost:4321",   // astro dev
      "http://localhost:8888",   // netlify dev
      "http://127.0.0.1:4321",
      "http://127.0.0.1:8888",
    ]) {
      out.add(d);
    }
  }
  return out;
}

/** Dado un Request, devuelve el origin permitido a espejar en
 *  `Access-Control-Allow-Origin`, o `null` si no hay ninguno.
 *
 *  Uso:
 *    const allowOrigin = resolveAllowedOrigin(request, { allowedOrigins, isDev });
 *    if (allowOrigin) {
 *      response.headers.set("Access-Control-Allow-Origin", allowOrigin);
 *      response.headers.set("Vary", "Origin");
 *    }
 */
export function resolveAllowedOrigin(
  request: Request,
  env: CorsEnv,
): string | null {
  const requestOrigin = normalizeOrigin(request.headers.get("origin"));
  if (!requestOrigin) return null;
  const allowed = parseAllowed(env);
  return allowed.has(requestOrigin) ? requestOrigin : null;
}
