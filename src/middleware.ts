/**
 * Middleware global de cabeceras de seguridad.
 *
 * Aplica a TODAS las respuestas (HTML, JSON, FITS binario):
 *   - X-Content-Type-Options: nosniff
 *       Evita que el navegador "adivine" el MIME type y ejecute
 *       contenido como algo distinto (e.g. servir .FITS y que el
 *       navegador lo trate como HTML ejecutable).
 *   - X-Frame-Options: DENY
 *       La app no debe ser embebida en iframes de terceros (clickjacking).
 *       En HTML servimos también `frame-ancestors 'none'` vía CSP.
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *       No enviamos el path completo cuando el usuario navega a un
 *       origen externo (las queries de búsqueda de exoplanetas no
 *       deberían filtrarse en el header Referer).
 *   - Permissions-Policy: cerrar APIs que la app no usa
 *       (geolocation, camera, microphone, etc.).
 *
 * Solo en respuestas HTML añade Content-Security-Policy estricta:
 *   - default-src 'self'
 *   - script-src 'self' 'unsafe-inline' https://accounts.google.com
 *       'unsafe-inline' es necesario porque Astro inyecta scripts de
 *       hidratación inline (`<astro-island>`); endurecer a nonces
 *       queda como follow-up.
 *   - connect-src permite hablar con la API de Drive y GIS
 *   - frame-src solo para el popup de OAuth de Google
 *   - frame-ancestors 'none' como segunda línea anti-clickjacking
 *
 * No sobreescribe cabeceras CORS ya establecidas por /api/fits/[file].
 * Las API routes se ejecutan DESPUÉS del middleware, así que sus
 * cabeceras (e.g. Access-Control-Allow-Origin: *) tienen prioridad
 * si hubiera conflicto (no lo hay porque son cabeceras distintas).
 */
import { defineMiddleware } from "astro:middleware";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": [
    "accelerometer=()",
    "autoplay=()",
    "camera=()",
    "cross-origin-isolated=()",
    "display-capture=()",
    "encrypted-media=()",
    "fullscreen=(self)",
    "geolocation=()",
    "gyroscope=()",
    "keyboard-map=()",
    "magnetometer=()",
    "microphone=()",
    "midi=()",
    "payment=()",
    "picture-in-picture=()",
    "publickey-credentials-get=(self)",
    "screen-wake-lock=()",
    "sync-xhr=()",
    "usb=()",
    "xr-spatial-tracking=()",
  ].join(", "),
};

const CSP = [
  "default-src 'self'",
  // 'unsafe-inline' para scripts: Astro inyecta scripts inline de
  // hidratación (astro-island custom elements). Endurecer a nonces
  // requeriría render hooks en cada isla. Trade-off aceptado: el
  // scope `drive.file` minimiza el blast radius si hubiera XSS.
  "script-src 'self' 'unsafe-inline' https://accounts.google.com",
  // Estilos: la app usa CSS modules y estilos inline para algunas
  // animaciones del progreso. Permitimos 'unsafe-inline' aquí.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Conectividad: API de Drive (subida) y NASA (transit-check) sale
  // desde el cliente, no del servidor.
  "connect-src 'self' https://www.googleapis.com https://accounts.google.com",
  // El popup de OAuth de Google NO es un iframe (es window.open), pero
  // por si en el futuro cambiamos a flow con iframe, lo dejamos
  // permitido solo para accounts.google.com.
  "frame-src https://accounts.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();

  // Cabeceras universales (HTML, JSON, binario).
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    // No sobreescribimos si la ruta ya las estableció (defense in depth).
    if (!response.headers.has(k)) response.headers.set(k, v);
  }

  // CSP solo en HTML. JSON/FITS no se renderizan en navegador, no
  // necesitan CSP.
  const ct = response.headers.get("Content-Type") ?? "";
  if (ct.startsWith("text/html") && !response.headers.has("Content-Security-Policy")) {
    response.headers.set("Content-Security-Policy", CSP);
  }

  return response;
});
