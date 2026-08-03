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
import { utcIsoToJd, jdToUtcIso, isoToMoFormat } from "@/lib/jd";

export const prerender = false;

const TAP_URL =
  "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const TIMEOUT_MS = 12_000;

type PlanetEph = {
  pl_name: string;
  hostname: string;
  pl_orbper: number;        // días
  pl_tranmid: number;       // BJD del tránsito de referencia
  pl_tranmiderr1: number;   // incertidumbre +1σ (días)
  pl_tranmiderr2: number;   // incertidumbre -1σ (días)
  pl_trandur?: number;      // horas (puede ser null/undefined)
};

type TransitHit = {
  pl_name: string;
  hostname: string;
  midtimeJd: number;
  midtimeUtc: string;     // formato MO "2026-07-24 02:09:00"
  midtimeIso: string;     // "2026-07-24T02:09:00.000Z"
  period: number;         // días
  duration?: number;      // horas
  uncertaintyJd: number;  // 1σ en días
  // 0 si el midpoint está dentro de la ventana. Si está fuera, minutos
  // de diferencia con el borde más cercano de la ventana (positivo = después
  // del fin, negativo = antes del inicio).
  offsetMin: number;
};

type TransitCheckResponse = {
  ok: boolean;
  error?: string;
  target: string;
  matchedName?: string;     // pl_name que matcheó
  matchedHost?: string;     // hostname
  startJd: number;
  endJd: number;
  found: boolean;           // al menos un midpoint en ventana
  count: number;            // número de midpoints en ventana
  transits: TransitHit[];   // midpoints en ventana
  nearest: TransitHit | null; // tránsito más cercano a la ventana
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
 * Escapa comillas simples para SQL (ADQL). El resto de caracteres son
 * seguros en este contexto (no concatenamos input del usuario a nada que
 * se evalúe como código, solo como literales en la cláusula WHERE).
 */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

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
 * Ordenamos por `pl_tranmiderr1 ASC` y usamos la primera fila.
 */
async function findPlanetEphemerides(target: string): Promise<PlanetEph[]> {
  const safe = sqlEscape(target);
  // Cubrimos: hostname exacto, pl_name LIKE prefijo. El prefijo en pl_name
  // atrapa "WASP-135" -> "WASP-135 b" y "WASP-135 A" -> "WASP-135 A b".
  // Ordenamos por precisión (menor incertidumbre primero) y filtramos por
  // tran_flag = 1 (solo planetas con tránsitos observados).
  const query =
    `SELECT pl_name, hostname, pl_orbper, pl_tranmid, ` +
    `pl_tranmiderr1, pl_tranmiderr2, pl_trandur ` +
    `FROM ps ` +
    `WHERE (hostname = '${safe}' OR pl_name LIKE '${safe}%') ` +
    `AND tran_flag = 1 ` +
    `ORDER BY ABS(pl_tranmiderr1) ASC`;

  const result = await tapQuery(query);
  return result ?? [];
}

/**
 * Genera los tránsitos del planeta en [startJd, endJd] usando
 * t_n = t_0 + n*P para n entero.
 *
 * Para no perdernos ningún tránsito en una ventana de varios días,
 * iteramos un margen extra de ±5 períodos alrededor del rango.
 */
function transitsInWindow(
  eph: PlanetEph,
  startJd: number,
  endJd: number,
): TransitHit[] {
  if (eph.pl_orbper <= 0) return [];
  const hits: TransitHit[] = [];

  // Centro aproximado: transit más cercano a startJd
  const nApprox = Math.round((startJd - eph.pl_tranmid) / eph.pl_orbper);
  // Rango de n a explorar: ±5 períodos extra + lo que cubre la ventana
  const periodsInWindow = Math.ceil((endJd - startJd) / eph.pl_orbper) + 2;
  const nStart = nApprox - 5;
  const nEnd = nApprox + periodsInWindow + 5;

  const uncertaintyJd = Math.max(
    Math.abs(eph.pl_tranmiderr1 || 0),
    Math.abs(eph.pl_tranmiderr2 || 0),
  );

  for (let n = nStart; n <= nEnd; n++) {
    const midJd = eph.pl_tranmid + n * eph.pl_orbper;
    if (midJd < startJd - 0.5 || midJd > endJd + 0.5) continue;
    const midIso = jdToUtcIso(midJd);
    let offsetMin = 0;
    if (midJd < startJd) {
      offsetMin = Math.round((startJd - midJd) * 24 * 60);
      // offsetMin positivo = tránsito ANTES del inicio (usuario llegó tarde)
    } else if (midJd > endJd) {
      offsetMin = -Math.round((midJd - endJd) * 24 * 60);
      // offsetMin negativo = tránsito DESPUÉS del fin (usuario terminó antes)
    }
    hits.push({
      pl_name: eph.pl_name,
      hostname: eph.hostname,
      midtimeJd: midJd,
      midtimeUtc: isoToMoFormat(midIso),
      midtimeIso: midIso,
      period: eph.pl_orbper,
      duration: eph.pl_trandur,
      uncertaintyJd,
      offsetMin,
    });
  }
  return hits;
}

/**
 * Encuentra el tránsito más cercano a la ventana (incluso si está fuera).
 * Busca un poco más allá de la ventana para detectar "near misses".
 */
function findNearest(
  eph: PlanetEph,
  startJd: number,
  endJd: number,
): TransitHit | null {
  if (eph.pl_orbper <= 0) return null;
  // Buscamos en una ventana extendida: ±10 períodos alrededor
  const nApprox = Math.round((startJd - eph.pl_tranmid) / eph.pl_orbper);
  const periodsInWindow = Math.ceil((endJd - startJd) / eph.pl_orbper) + 2;
  const nStart = nApprox - 10;
  const nEnd = nApprox + periodsInWindow + 10;

  const uncertaintyJd = Math.max(
    Math.abs(eph.pl_tranmiderr1 || 0),
    Math.abs(eph.pl_tranmiderr2 || 0),
  );

  let best: TransitHit | null = null;
  let bestDist = Infinity;

  for (let n = nStart; n <= nEnd; n++) {
    const midJd = eph.pl_tranmid + n * eph.pl_orbper;
    // Distancia al borde más cercano de la ventana
    let dist: number;
    if (midJd < startJd) dist = startJd - midJd;
    else if (midJd > endJd) dist = midJd - endJd;
    else dist = 0;
    if (dist < bestDist) {
      bestDist = dist;
      const midIso = jdToUtcIso(midJd);
      let offsetMin = 0;
      if (midJd < startJd) {
        offsetMin = Math.round((startJd - midJd) * 24 * 60);
      } else if (midJd > endJd) {
        offsetMin = -Math.round((midJd - endJd) * 24 * 60);
      }
      best = {
        pl_name: eph.pl_name,
        hostname: eph.hostname,
        midtimeJd: midJd,
        midtimeUtc: isoToMoFormat(midIso),
        midtimeIso: midIso,
        period: eph.pl_orbper,
        duration: eph.pl_trandur,
        uncertaintyJd,
        offsetMin,
      };
    }
  }
  return best;
}

export const POST: APIRoute = async ({ request }) => {
  const lang: Lang = getReqLang(request);

  let body: { target?: string; start?: string; end?: string };
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
      count: 0,
      transits: [],
      nearest: null,
      source: "exoplanetarchive.ipac.caltech.edu",
    };
    cache.set(cacheKey, {
      data: response,
      expires: Date.now() + CACHE_TTL_MS,
    });
    return jsonResp(response);
  }

  // Deduplicamos por pl_name: el mismo planeta puede aparecer varias
  // veces (con distintas efemérides). Como findPlanetEphemerides ya
  // ordena por precisión ASC, el primer match por pl_name es el más
  // preciso y es el que usamos.
  const bestByPlanet = new Map<string, PlanetEph>();
  for (const eph of ephs) {
    if (!bestByPlanet.has(eph.pl_name)) {
      bestByPlanet.set(eph.pl_name, eph);
    }
  }
  const bestEphs = Array.from(bestByPlanet.values());

  // Agregamos tránsitos de todos los planetas que matchearon
  // (multi-planet system, binary system con varias componentes).
  const allInWindow: TransitHit[] = [];
  let bestNearest: TransitHit | null = null;
  for (const eph of bestEphs) {
    allInWindow.push(...transitsInWindow(eph, startJd, endJd));
    const n = findNearest(eph, startJd, endJd);
    if (n) {
      if (!bestNearest || Math.abs(n.offsetMin) < Math.abs(bestNearest.offsetMin)) {
        bestNearest = n;
      }
    }
  }
  allInWindow.sort((a, b) => a.midtimeJd - b.midtimeJd);

  // matchedName: si hay un único planeta, su nombre. Si hay varios,
  // concatenamos.
  const matchedName = bestEphs.length === 1 ? bestEphs[0].pl_name : bestEphs.map((e) => e.pl_name).join(", ");
  const matchedHost = bestEphs.length === 1 ? bestEphs[0].hostname : `${bestEphs[0].hostname} (+${bestEphs.length - 1})`;

  const response: TransitCheckResponse = {
    ok: true,
    target,
    matchedName,
    matchedHost,
    startJd,
    endJd,
    found: allInWindow.length > 0,
    count: allInWindow.length,
    transits: allInWindow,
    nearest: bestNearest,
    source: "exoplanetarchive.ipac.caltech.edu",
  };

  cache.set(cacheKey, { data: response, expires: Date.now() + CACHE_TTL_MS });
  return jsonResp(response);
};
