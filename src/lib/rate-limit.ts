/**
 * Rate limiting — algoritmo puro (sin dependencias runtime).
 *
 * Diseñado para ser el CORE de una Edge Function de Netlify: la función
 * de borde se encarga del I/O (leer/escribir el counter en Blobs) y
 * delega la decisión a `checkRateLimit`. Eso permite testear el
 * algoritmo en vitest (entorno Node) sin necesidad de Deno ni de
 * mocks de Blobs.
 *
 * ALGORITMO: ventana fija por minuto
 * -----------------------------------
 * Para cada (key, ventana-actual) guardamos un counter. Si el counter
 * supera el límite en la ventana actual, denegamos.
 *
 * Trade-offs vs sliding window log:
 *   - Más simple (un counter en lugar de lista de timestamps).
 *   - Pico en el borde de ventana: 2x max durante el segundo de cambio
 *     (e.g. 30 requests a 0:59 + 30 a 1:00). Para nuestros límites
 *     (20-30/min) no es un problema real.
 *   - Si necesitamos fairness estricto, cambiamos a sliding window
 *     manteniendo la misma firma de la función (storage: array en vez
 *     de counter).
 *
 * FORMATO DE STORAGE
 * ------------------
 * El estado por key se serializa como `{ count, windowStart }` donde:
 *   - `count`: requests hechos en la ventana actual
 *   - `windowStart`: epoch ms del inicio de la ventana
 * Esto permite saber si el counter "sigue vigente" o si hay que
 * reiniciarlo a una nueva ventana.
 */
export type RateLimitConfig = {
  /** Máximo de requests permitidos POR VENTANA por key. */
  max: number;
  /** Duración de la ventana en segundos. */
  windowSec: number;
};

/** Estado serializado en el storage. */
export type RateLimitState = {
  count: number;
  /** epoch ms del inicio de la ventana actual. */
  windowStart: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests restantes en la ventana (0 si denied). */
  remaining: number;
  /** Segundos hasta que se reinicie la ventana. */
  resetInSec: number;
  /** Estado NUEVO a persistir (puede ser igual al actual si denied). */
  nextState: RateLimitState;
};

/** Decisión de rate limit + estado a persistir. Función PURA:
 *  el caller hace el I/O. Eso facilita testing y reutilización. */
export function checkRateLimit(
  current: RateLimitState | null,
  nowMs: number,
  config: RateLimitConfig,
): RateLimitDecision {
  const windowMs = config.windowSec * 1000;
  const currentWindowStart = Math.floor(nowMs / windowMs) * windowMs;
  const windowEnd = currentWindowStart + windowMs;
  const resetInSec = Math.max(1, Math.ceil((windowEnd - nowMs) / 1000));

  // Sin estado previo o ventana anterior: empezamos una nueva.
  if (!current || current.windowStart !== currentWindowStart) {
    return {
      allowed: true,
      remaining: config.max - 1,
      resetInSec,
      nextState: { count: 1, windowStart: currentWindowStart },
    };
  }

  // Misma ventana: comprobamos el counter.
  if (current.count >= config.max) {
    return {
      allowed: false,
      remaining: 0,
      resetInSec,
      nextState: current, // no incrementamos si denied
    };
  }

  return {
    allowed: true,
    remaining: config.max - current.count - 1,
    resetInSec,
    nextState: {
      count: current.count + 1,
      windowStart: currentWindowStart,
    },
  };
}

/** Extrae la IP del cliente desde cabeceras estándar de proxies.
 *  Netlify siempre rellena `x-forwarded-for`; `x-real-ip` es fallback
 *  para setups con nginx delante. Si no hay ninguna, devuelve "unknown"
 *  (todos los anonimos comparten bucket, aceptable). */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // x-forwarded-for puede traer "client, proxy1, proxy2"; el primero
    // es el cliente real.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip")?.trim();
  if (xri) return xri;
  return "unknown";
}
