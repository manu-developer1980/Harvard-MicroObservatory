// netlify/edge-functions/rate-limit.ts
//
// Edge Function de Netlify para rate limiting. Corre ANTES de la
// función SSR de Astro (registrada en netlify.toml).
//
// ARQUITECTURA
// ------------
//   request → [Edge Function: rate-limit] → [Astro SSR Function]
//                ↓ (si excede)
//              429 Too Many Requests
//
// El algoritmo vive en `src/lib/rate-limit.ts` (puro, sin imports
// runtime-específicos) y se importa desde aquí. Eso permite testear
// el algoritmo en vitest (Node) sin Deno ni mocks de Blobs.
//
// STORAGE: Netlify Blobs
// ----------------------
// Usamos un store llamado "rate-limits" con una entry por
// (path, clientIp). TTL = 2 × ventana para que el counter expire
// automáticamente aunque una request no llegue a cerrarlo.
//
// FAIL-OPEN
// ---------
// Si Blobs falla (timeout, 5xx, etc.), DEjamos pasar la request
// (fail-open). Es preferible un breve periodo sin rate limit a
// tirar abajo toda la API por un blip del storage.
//
// CONFIG
// ------
// Variables de entorno (en netlify.toml o Netlify UI):
//   RATE_LIMIT_PREVIEW_MAX          (default 30)
//   RATE_LIMIT_TRANSIT_CHECK_MAX    (default 20)
//   RATE_LIMIT_WINDOW_SEC           (default 60)

import type { Context } from "https://edge.netlify.com";
// Patrón recomendado por Netlify para usar npm packages en edge
// functions: `npm:` sin versión (package.json fija la versión) y el
// paquete debe estar en dependencies (no solo transitivo).
import { getStore } from "npm:@netlify/blobs";

// Importamos el core desde el repo. Netlify bundle (esbuild) resuelve
// la ruta relativa en el deploy. NO usamos el alias `@/` aquí porque
// Deno/edge runtime no lo entiende.
import {
  checkRateLimit,
  clientIp,
  type RateLimitConfig,
  type RateLimitState,
} from "../../src/lib/rate-limit.ts";

const STORE_NAME = "rate-limits";

const PATH_CONFIG: Record<string, { name: string; defaultMax: number }> = {
  "/api/preview": { name: "preview", defaultMax: 30 },
  "/api/transit-check": { name: "transit-check", defaultMax: 20 },
};

function readConfig(pathname: string): RateLimitConfig | null {
  const meta = PATH_CONFIG[pathname];
  if (!meta) return null;
  const env = Deno.env.toObject();
  const windowSec = parseInt(env.RATE_LIMIT_WINDOW_SEC ?? "60", 10);
  const max = parseInt(
    env[`RATE_LIMIT_${meta.name.replace(/-/g, "_").toUpperCase()}_MAX`] ??
      String(meta.defaultMax),
    10,
  );
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(windowSec) || windowSec <= 0) return null;
  return { max, windowSec };
}

function rateLimitHeaders(
  cfg: RateLimitConfig,
  remaining: number,
  resetInSec: number,
): HeadersInit {
  return {
    "X-RateLimit-Limit": String(cfg.max),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(resetInSec),
  };
}

export default async (request: Request, context: Context): Promise<Response> => {
  const url = new URL(request.url);
  const cfg = readConfig(url.pathname);
  if (!cfg) {
    // Path no rate-limited: pasa al SSR sin tocar nada.
    return context.next();
  }

  const ip = clientIp(request);
  const key = `${url.pathname}:${ip}`;

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (e) {
    console.error("rate-limit: getStore failed, failing open", e);
    return context.next();
  }

  // Leemos el counter actual. consistency: "strong" garantiza que
  // vemos nuestra propia escritura reciente (en la misma región).
  let current: RateLimitState | null = null;
  try {
    current = (await store.get(key, {
      type: "json",
      consistency: "strong",
    })) as RateLimitState | null;
  } catch (e) {
    console.error("rate-limit: read failed, failing open", e);
    return context.next();
  }

  const decision = checkRateLimit(current, Date.now(), cfg);

  // Persistimos el nuevo estado con TTL = 2× ventana (limpieza auto).
  // No bloqueamos el response en este write: si falla, ya hemos
  // decidido allow/deny; logueamos y seguimos.
  try {
    await store.setJSON(key, decision.nextState, {
      ttl: cfg.windowSec * 2,
    });
  } catch (e) {
    console.error("rate-limit: write failed (decision still applied)", e);
  }

  if (!decision.allowed) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(decision.resetInSec),
        ...rateLimitHeaders(cfg, 0, decision.resetInSec),
      },
    });
  }

  // Allow: dejamos pasar al SSR y añadimos cabeceras informativas
  // a la respuesta para que la UI pueda mostrarlas si quiere.
  const response = await context.next();
  response.headers.set("X-RateLimit-Limit", String(cfg.max));
  response.headers.set("X-RateLimit-Remaining", String(decision.remaining));
  response.headers.set("X-RateLimit-Reset", String(decision.resetInSec));
  return response;
};
