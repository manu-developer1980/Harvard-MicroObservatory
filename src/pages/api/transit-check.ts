/**
 * POST /api/transit-check
 *
 * Body: { target: string, start: string, end: string, lang?: Lang }
 *   - target: nombre del exoplaneta (formato MO, ej. "CoRoT-2")
 *   - start, end: datetimes en formato MO ("27-Jul-2026 04:18:42") o ISO UTC
 *
 * Cruza la ventana temporal de la secuencia del usuario con las predicciones
 * de tránsito del NASA Exoplanet Archive (Transit Service API). Devuelve:
 *   - ok, found, count, transits[] con midpointjd + midpointUtc + period + incertidumbre
 *
 * Por qué endpoint nuevo y no scraping de la URL
 *   El usuario mencionó la URL del TransitView para visualizarlo en el
 *   navegador, pero la API programática está en otro endpoint:
 *     https://exoplanetarchive.ipac.caltech.edu/cgi-bin/TransitSearch/nph-transits-api
 *   con parámetros &sname=, &bJD=, &eJD=, &format=json. Es síncrona para
 *   queries de un solo target, lo que encaja perfecto con nuestro caso.
 *
 * Matching de nombre
 *   MO usa "CoRoT-2" pero el archive usa "CoRoT-2 b". Probamos candidatos
 *   en orden: nombre exacto, nombre + " b", nombre con espacios/guiones.
 *
 * Caché
 *   1h por (target, startJd, endJd) en memoria. Las efemérides no cambian
 *   entre requests del mismo usuario. Como es serverless, solo cubre
 *   instancias warm, pero es suficiente para evitar hammering a NASA.
 */
import type { APIRoute } from "astro";
import { t, getReqLang, type Lang } from "@/lib/i18n";
import { parseDt } from "@/lib/filters";
import { utcIsoToJd, jdToUtcIso, isoToMoFormat } from "@/lib/jd";

export const prerender = false;

const NASA_API =
  "https://exoplanetarchive.ipac.caltech.edu/cgi-bin/TransitSearch/nph-transits-api";
const TIMEOUT_MS = 12_000;

type TransitHit = {
  midtimeJd: number;
  midtimeUtc: string; // "2026-08-04 02:06:00"
  midtimeIso: string; // "2026-08-04T02:06:00.000Z"
  period?: number;
  uncertaintyJd?: number; // incertidumbre del midpoint en días
};

type TransitCheckResponse = {
  ok: boolean;
  error?: string;
  target: string;
  matchedName?: string; // nombre tal cual lo encontró el archive
  startJd: number;
  endJd: number;
  found: boolean;
  count: number;
  transits: TransitHit[];
  source: string;
};

// Cache en memoria: 1h TTL
type CacheEntry = { data: TransitCheckResponse; expires: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Acepta tanto formato MO ("27-Jul-2026 04:18:42") como ISO UTC
 * ("2026-07-27T04:18:42Z"). Devuelve ISO UTC canónico.
 */
function toIsoUtc(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) throw new Error("empty");
  // ¿Formato MO?  "27-Jul-2026 04:18:42"
  if (/^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return parseDt(trimmed).toISOString();
  }
  // Si no, intenta Date.parse (acepta ISO 8601 con o sin ms/Z)
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    return new Date(ms).toISOString();
  }
  throw new Error(`Unrecognized datetime format: ${s}`);
}

type NasaQueryResult =
  | { ok: true; name: string; records: NasaRecord[] }
  | { ok: false; reason: "not-found" | "error"; errorMsg?: string };

type NasaRecord = {
  planetname: string;
  midpointjd: string;
  midpointcalendar?: string;
  period?: string;
  propmidpointunc?: string;
};

async function queryNasa(
  planet: string,
  startJd: number,
  endJd: number,
): Promise<NasaQueryResult> {
  // Candidatos en orden de probabilidad. El archive suele añadir el sufijo
  // "b" (CoRoT-2 -> CoRoT-2 b) o usar guiones/espacios distintos.
  const candidates = [
    planet,
    `${planet} b`,
    `${planet}b`,
    planet.replace(/_/g, " "),
    planet.replace(/-/g, " "),
  ];

  let lastError: string | undefined;
  for (const name of candidates) {
    const url =
      `${NASA_API}?sname=${encodeURIComponent(name)}` +
      `&bJD=${startJd.toFixed(5)}&eJD=${endJd.toFixed(5)}` +
      `&format=json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "mo-downloader-web/0.1 (transit check)" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = `NASA HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as {
        stat?: string;
        data?: NasaRecord[];
        msg?: string;
      };
      if (json?.stat !== "OK" || !Array.isArray(json.data)) {
        lastError = json?.msg ?? "NASA stat != OK";
        continue;
      }
      if (json.data.length === 0) {
        // Match vacío con este nombre, prueba el siguiente candidato
        continue;
      }
      return { ok: true, name, records: json.data };
    } catch (e) {
      clearTimeout(timer);
      lastError = e instanceof Error ? e.message : String(e);
      // Si fue un timeout/abort, no tiene sentido seguir probando nombres
      return { ok: false, reason: "error", errorMsg: lastError };
    }
  }
  // Si llegamos aquí, ningún candidato devolvió datos. Distinguimos:
  // - reason "error" si el último intento fue fallo de red/HTTP
  // - reason "not-found" si el último intento fue 200 con data=[] (target desconocido)
  return lastError
    ? { ok: false, reason: "error", errorMsg: lastError }
    : { ok: false, reason: "not-found" };
}

export const POST: APIRoute = async ({ request }) => {
  const lang: Lang = getReqLang(request);

  let body: {
    target?: string;
    start?: string;
    end?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResp({ ok: false, error: t("error.invalidJson", lang) }, 400);
  }

  const target = (body.target ?? "").trim();
  if (!target) {
    return jsonResp(
      { ok: false, error: t("error.missingTarget", lang) },
      400,
    );
  }

  let startIso: string;
  let endIso: string;
  try {
    startIso = toIsoUtc(body.start ?? "");
    endIso = toIsoUtc(body.end ?? "");
  } catch (e) {
    return jsonResp(
      {
        ok: false,
        error: t("error.invalidDateFormat", lang, {
          value: e instanceof Error ? e.message : String(e),
        }),
      },
      400,
    );
  }

  const startJd = utcIsoToJd(startIso);
  const endJd = utcIsoToJd(endIso);
  if (!(endJd > startJd)) {
    return jsonResp(
      { ok: false, error: t("error.invalidDate", lang) },
      400,
    );
  }

  // Cache key: target normalizado + JD con 0.001 d (~86s) de resolución
  // para reutilizar respuestas de queries casi idénticas.
  const cacheKey = `${target.toLowerCase()}|${startJd.toFixed(3)}|${endJd.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return jsonResp(cached.data);
  }

  const result = await queryNasa(target, startJd, endJd);

  if (!result.ok) {
    const response: TransitCheckResponse = {
      ok: false,
      error: result.errorMsg,
      target,
      startJd,
      endJd,
      found: false,
      count: 0,
      transits: [],
      source: "exoplanetarchive.ipac.caltech.edu",
    };
    // No cacheamos errores transitorios de red, pero sí "not-found" (1h)
    if (result.reason === "not-found") {
      cache.set(cacheKey, {
        data: response,
        expires: Date.now() + CACHE_TTL_MS,
      });
    }
    return jsonResp(response);
  }

  // Filtramos solo los registros cuyo midpoint cae dentro de la ventana
  // (la API a veces devuelve puntos adyacentes al rango por redondeo).
  const transits: TransitHit[] = [];
  for (const rec of result.records) {
    const midJd = parseFloat(rec.midpointjd);
    if (!Number.isFinite(midJd)) continue;
    if (midJd < startJd - 0.01 || midJd > endJd + 0.01) continue;
    const midIso = jdToUtcIso(midJd);
    transits.push({
      midtimeJd: midJd,
      midtimeUtc: isoToMoFormat(midIso),
      midtimeIso: midIso,
      period: rec.period ? parseFloat(rec.period) : undefined,
      uncertaintyJd: rec.propmidpointunc
        ? parseFloat(rec.propmidpointunc)
        : undefined,
    });
  }
  transits.sort((a, b) => a.midtimeJd - b.midtimeJd);

  const response: TransitCheckResponse = {
    ok: true,
    target,
    matchedName: result.name,
    startJd,
    endJd,
    found: transits.length > 0,
    count: transits.length,
    transits,
    source: "exoplanetarchive.ipac.caltech.edu",
  };

  cache.set(cacheKey, { data: response, expires: Date.now() + CACHE_TTL_MS });
  return jsonResp(response);
};
