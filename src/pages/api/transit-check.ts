/**
 * POST /api/transit-check
 *
 * Body: { target: string, start: string, end: string, lang?: Lang }
 *   - target: nombre del exoplaneta (formato MO o NASA, ej. "CoRoT-2",
 *     "WASP-135", "WASP-135 b", "WASP-135 A b")
 *   - start, end: datetimes en formato MO ("27-Jul-2026 04:18:42") o ISO UTC
 *
 * Cruza la ventana temporal de la secuencia del usuario con las efemérides
 * de tránsito del NASA Exoplanet Archive.
 *
 * Estrategia (cambio respecto a la versión anterior)
 * ----------------------------------------------------
 * La Transit Service Programmatic API (TransitSearch) IGNORA los parámetros
 * &bJD/&eJD y siempre devuelve el "next transit" con múltiples efemérides
 * de la misma época, NO todos los tránsitos del rango. Esto la hace
 * inservible para nuestro caso (queremos saber si la VENTANA del usuario
 * contiene un tránsito).
 *
 * En su lugar, hacemos TAP query a la tabla `ps` (Planetary Systems) para
 * sacar las efemérides de cada planeta (pl_tranmid, pl_orbper, pl_trandur,
 * pl_tranmiderr1/2) y COMPUTAMOS nosotros los tránsitos en la ventana con:
 *
 *     t_n = t_0 + n * P     (n entero)
 *
 * Matching de nombre
 * ------------------
 * La query cubre:
 *   - "WASP-135"       -> hostname = "WASP-135" (todas las letras A, B, etc.)
 *   - "WASP-135 b"     -> pl_name LIKE "WASP-135 b%" (match exacto)
 *   - "WASP-135 A"     -> hostname = "WASP-135 A" (estrella binaria)
 * La query es:
 *   WHERE (hostname = '<t>' OR pl_name LIKE '<t>%')
 *     AND tran_flag = 1 AND default_flag = 1
 * Esto devuelve una fila por planeta transiting con efeméride por defecto.
 *
 * Respuesta
 * ---------
 *   - found: hay al menos un midpoint dentro de la ventana
 *   - count: número de midpoints dentro de la ventana
 *   - transits: array con los tránsitos dentro de la ventana
 *   - nearest: el tránsito más cercano a la ventana (puede ser el mismo
 *     que uno de los transits si está dentro), con offsetMin (positivo =
 *     después del fin de ventana, negativo = antes del inicio)
 *   - matchedName: nombre del planet (pl_name) que matcheó
 */
import type { APIRoute } from "astro";
import { t, getReqLang, type Lang } from "@/lib/i18n";
import { parseDt } from "@/lib/filters";
import { utcIsoToJd } from "@/lib/jd";
import {
  type PlanetEph,
  type TransitHit,
  matchMostPreciseEphemeris,
  normalizeTargetForNasa,
} from "@/lib/transit-match";
import { TransitCheckRequestSchema, parseBody } from "@/lib/schemas";
import { sqlEscapeLike } from "@/lib/sql-escape";

export const prerender = false;

const TAP_URL =
  "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const TIMEOUT_MS = 12_000;

/**
 * Incertidumbre propagada de la predicción a una fecha futura.
 *
 * Para n períodos desde la referencia, la incertidumbre del midpoint
 * predicho crece aproximadamente como:
 *
 *     σ(t_n) ≈ √(σ(t_0)² + (n · σ(P))²)
 *
 * El término del periodo DOMINA a partir de ~1000 períodos hacia el
 * futuro (σ(P) se multiplica por n). Por eso NASA usa un flag
 * `ismostprecise=1` que NO es simplemente "menor pl_tranmiderr1", sino
 * la efeméride con menor σ(t_n) en el momento de la consulta.
 *
 * Caso real: WASP-135 b tiene 6 efemérides. A 2026-07-24 (n=1569):
 *   - Kokori 2023 (σ_t0=0.00019 d, σ_P=0.00000039 d)  -> σ(t_n) ≈ 55 min
 *   - Ivshina 2022 (σ_t0=0.00025 d, σ_P=0.00000034 d)  -> σ(t_n) ≈ 51 min
 * NASA marca Ivshina como ismostprecise=1. Si solo ordenamos por
 * σ_t0, habríamos cogido Kokori (incorrecto para fechas lejanas).
 *
 * La implementación vive en `@/lib/transit-match` (testeable aislada).
 */

type TransitCheckResponse = {
  ok: boolean;
  error?: string;
  target: string;
  matchedName?: string;     // pl_name que matcheó
  matchedHost?: string;     // hostname
  startJd: number;
  endJd: number;
  /**
   * `true` si la predicción de la efeméride "most precise" cae dentro
   * de la ventana del usuario. `false` si está fuera (incluso si otras
   * efemérides menos precisas caerían dentro — la UI muestra la
   * predicción como "near miss" con el offset en minutos).
   */
  found: boolean;
  /**
   * Predicción única de la efeméride "most precise" (réplica del
   * Event Midpoint Calendar UT de NASA TransitView). SIEMPRE presente
   * aunque la predicción caiga fuera de la ventana. Su `offsetMin`
   * indica la desviación en minutos (positivo = antes del inicio,
   * negativo = después del fin, 0 = dentro).
   */
  transit: TransitHit | null;
  source: string;
};

// Cache en memoria: 1h TTL por (target, startJd, endJd)
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

function toIsoUtc(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) throw new Error("empty");
  if (/^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return parseDt(trimmed).toISOString();
  }
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    return new Date(ms).toISOString();
  }
  throw new Error(`Unrecognized datetime format: ${s}`);
}

/**
 * `transitsInWindow` y `findNearest` viven ahora en `@/lib/transit-match`
 * para poder testearlas aisladas. Ver `transit-match.test.ts` para los
 * tests de regresión del bug de margen (WASP-67 b 2026-07-29).
 */

async function tapQuery(sql: string): Promise<PlanetEph[] | null> {
  const url = `${TAP_URL}?query=${encodeURIComponent(sql)}&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "mo-downloader-web/0.1 (transit check)" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data as PlanetEph[];
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Busca la efeméride del planeta en la tabla `ps` con un matching tolerante.
 * Devuelve todas las efemérides candidatas (multi-planet system, binary),
 * ordenadas de más a menos precisa (menor `pl_tranmiderr1` primero).
 *
 * Por qué NO usar `default_flag = 1`
 * ----------------------------------
 * El flag `default_flag` marca la efeméride "oficial" de NASA, pero
 * históricamente es la primera que se cargó en el archivo, NO la más
 * reciente ni la más precisa. Ejemplo real: WASP-135 b tiene 6
 * efemérides distintas. La `default_flag=1` es de 2010
 * (t0=2455230.99, err=0.0009 d) y predecía el tránsito del 2026-07-24
 * a las 02:09 UTC. La más precisa (err=0.00019 d, t0=2459046.94) lo
 * predice a las 04:58 UTC — 2h49min después, dentro de la ventana del
 * usuario. Usar la default_flag habría dado un falso "no transit in
 * window" en un caso donde SÍ lo había.
 *
 * NO ordenamos por `pl_tranmiderr1 ASC` aquí. La selección de la efeméride
 * "más precisa" la hace el caller (ver `pickBestByPlanet`) usando la
 * **incertidumbre propagada** σ(t_n) a la fecha de la consulta, igual que
 * el flag `ismostprecise=1` de la TransitView de NASA:
 *
 *     σ(t_n) ≈ √(σ(t_0)² + (n · σ(P))²)
 *
 * Caso real: WASP-135 b tiene 6 efemérides. A 2026-07-24 (n=1569):
 *   - Kokori 2023 (σ_t0=0.00019, σ_P=0.00000039) -> σ(t_n) ≈ 0.00083 d
 *   - Ivshina 2022 (σ_t0=0.00025, σ_P=0.00000034) -> σ(t_n) ≈ 0.00079 d
 * NASA marca Ivshina como ismostprecise=1; es la que la TransitView
 * exporta. Si solo ordenáramos por σ_t0, habríamos cogido Kokori y
 * predicho 04:58 UTC en vez de 04:57 UTC (1 min de diferencia, pero
 * para predicciones más lejanas o periodos más largos el offset
 * puede ser mucho mayor).
 */
async function findPlanetEphemerides(target: string): Promise<PlanetEph[]> {
  // El input del usuario (o el desplegable de MO) puede no coincidir
  // exactamente con el formato canónico de NASA. Casos reales:
  //   - "KELT-23A" (MO)   → NASA "KELT-23 A"   (espacio en sistema binario)
  //   - "TOI1516"  (MO)   → NASA "TOI-1516"    (guion prefijo-número)
  //   - "TOI 4145" (MO)   → NASA "TOI-4145"    (guion en vez de espacio)
  // `normalizeTargetForNasa` produce el input literal + variantes
  // canónicas. Probamos cada una hasta que alguna devuelva filas. La
  // primera (literal) es la más rápida cuando el usuario ya escribe en
  // formato NASA.
  const candidates = normalizeTargetForNasa(target);
  for (const candidate of candidates) {
    const ephs = await findPlanetEphemeridesExact(candidate);
    if (ephs.length > 0) return ephs;
  }
  return [];
}

/**
 * Query exacta (sin normalización) para una variante del nombre. Ver
 * `findPlanetEphemerides` para la versión que prueba múltiples
 * candidatos. Esta función es `async` por la TAP query a NASA; no
 * meter lógica de normalización aquí — vive en transit-match.ts
 * (`normalizeTargetForNasa`) para poder testearla aislada.
 */
async function findPlanetEphemeridesExact(target: string): Promise<PlanetEph[]> {
  const safe = sqlEscapeLike(target);
  // Cubrimos: hostname exacto, pl_name LIKE prefijo. El prefijo en pl_name
  // atrapa "WASP-135" -> "WASP-135 b" y "WASP-135 A" -> "WASP-135 A b".
  // Filtramos por tran_flag = 1 (solo planetas con tránsitos observados).
  // NO filtramos por default_flag=1 (ver comentario más abajo) ni ordenamos
  // aquí: la selección de la "más precisa" se hace en el caller en función
  // de la incertidumbre propagada a la fecha de la consulta.
  //
  // Matching case-INsensitive: NASA almacena los hostnames con la
  // capitalización original de la publicación (TrES-3, GJ-436, WASP-12,
  // HD-189733, KELT-9, etc.) y los usuarios suelen escribirlos en
  // mayúsculas (TRES-3, WASP-135). `LIKE` y `=` en ADQL son
  // case-sensitive, así que un "TRES-3" no matcheaba "TrES-3". Envolvemos
  // ambas partes en `LOWER()` para que cualquier capitalización del input
  // matchee el formato canónico.
  //
  // ESCAPE '\\' en LIKE: necesario porque `sqlEscape` neutraliza los
  // wildcards `%` y `_` con prefijo `\`. Sin ESCAPE, un usuario podría
  // enumerar la tabla metiendo `WASP-1%` y matchear WASP-12, WASP-121,
  // etc. (defense in depth: el endpoint es read-only, pero la
  // enumeración de planetas no es deseada).
  const query =
    `SELECT pl_name, hostname, pl_orbper, pl_orbpererr1, pl_tranmid, ` +
    `pl_tranmiderr1, pl_tranmiderr2, pl_trandur, pl_refname ` +
    `FROM ps ` +
    `WHERE (LOWER(hostname) = LOWER('${safe}') ` +
    `OR LOWER(pl_name) LIKE LOWER('${safe}%') ESCAPE '\\') ` +
    `AND tran_flag = 1`;

  const result = await tapQuery(query);
  return result ?? [];
}

/**
 * `transitsInWindow` y `findNearest` viven ahora en `@/lib/transit-match`
 * para poder testearlas aisladas. Ver `transit-match.test.ts` para los
 * tests de regresión del bug de margen (WASP-67 b 2026-07-29).
 */

export const POST: APIRoute = async ({ request }) => {
  const lang: Lang = getReqLang(request);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResp({ ok: false, error: t("error.invalidJson", lang) }, 400);
  }

  const parsed = parseBody(TransitCheckRequestSchema, rawBody);
  if (!parsed.ok) {
    return jsonResp({ ok: false, error: parsed.error }, 400);
  }
  const body = parsed.data;

  const target = body.target; // ya viene trimeado y validado
  let startIso: string;
  let endIso: string;
  try {
    startIso = toIsoUtc(body.start);
    endIso = toIsoUtc(body.end);
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

  const cacheKey = `${target.toLowerCase()}|${startJd.toFixed(3)}|${endJd.toFixed(3)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return jsonResp(cached.data);
  }

  const ephs = await findPlanetEphemerides(target);
  if (ephs.length === 0) {
    const response: TransitCheckResponse = {
      ok: true,
      target,
      startJd,
      endJd,
      found: false,
      transit: null,
      source: "exoplanetarchive.ipac.caltech.edu",
    };
    cache.set(cacheKey, {
      data: response,
      expires: Date.now() + CACHE_TTL_MS,
    });
    return jsonResp(response);
  }

  // Matching contra LA efeméride "most precise" (réplica del flag
  // ismostprecise=1 de NASA TransitView). Ver `matchMostPreciseEphemeris`
  // en transit-match.ts. Devuelve UNA sola predicción con `found: true`
  // si está dentro de la ventana, o con `found: false` + offset en
  // minutos si está fuera (near miss).
  const matched = matchMostPreciseEphemeris(ephs, startJd, endJd);
  const pickedTransit = matched.transit;
  const pickedName = matched.picked.pl_name;
  const pickedHost = matched.picked.hostname;

  const response: TransitCheckResponse = {
    ok: true,
    target,
    matchedName: pickedName,
    matchedHost: pickedHost,
    startJd,
    endJd,
    found: matched.found,
    transit: pickedTransit,
    source: "exoplanetarchive.ipac.caltech.edu",
  };

  cache.set(cacheKey, { data: response, expires: Date.now() + CACHE_TTL_MS });
  return jsonResp(response);
};
