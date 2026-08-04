/**
 * Tipos y funciones de filtrado, puertos TypeScript de download_mo.py.
 *
 * Reglas:
 *   Tránsito (weather_sensitive=true):
 *     - weather < threshold  ->  descartar
 *     - gap 4-10 min + vecino nuboso  ->  descartar
 *     - gap 10-30 min  ->  descartar
 *     - gap >= 30 min  ->  OK (corte de sesión)
 *
 *   Darks (weather_sensitive=false):
 *     - ningún filtro adicional; basta con que existan en la fecha
 *     - los gaps > BAD_GAP_MID siguen marcando como malas
 *
 * i18n: si pasas `lang` en las options, los motivos de descarte se
 * formatean con los diccionarios de `@/lib/i18n`. Si no, salen en
 * inglés (default seguro para que el ZIP y la API sean estables).
 */

import { t as i18n, type Lang } from "@/lib/i18n";

export type ImageRecord = {
  short: string;       // nombre corto, ej. "Qatar-6260723030146"
  datetime: string;    // "20-Jul-2026 06:12:15"
  fits: string;        // "Qatar-6260723030146.FITS"
  weather: number;     // 0..100
  filter: string;      // "V", "R", "I", "clear", etc. (rueda de filtros del telescopio)
  telescope: string;
  site: string;
};

export type DiscardedRecord = {
  record: ImageRecord;
  reasons: string[];   // TODOS los motivos por los que no pasó
  gapPrev: number | null;  // gap al vecino anterior (min), null si no tiene
  gapNext: number | null;  // gap al vecino siguiente (min)
};

export type ApplyGapFilterResult = {
  kept: ImageRecord[];
  discarded: DiscardedRecord[];
  /**
   * Sesiones detectadas tras la agrupación (clustering por gap).
   * Una sesión = un bloque continuo de imágenes separadas por gaps
   * < `sessionBreakMin`. Sustituye al agrupamiento por fecha UTC que
   * teníamos antes, que fallaba en secuencias que cruzan medianoche.
   * Ver `clusterSessions`.
   */
  sessions: Session[];
};

// ---------------------------------------------------------------------------
// Clustering por sesiones
// ---------------------------------------------------------------------------

/**
 * Sesión = bloque continuo de observaciones separado de los vecinos
 * por un gap > `sessionBreakMin` (default 30 min). Independiente de la
 * fecha UTC: una sesión puede cruzar medianoche (ej. 23:30 day 1 →
 * 00:30 day 2 con gaps de 30 min = misma sesión).
 */
export type Session = {
  /** Índice dentro del array devuelto por `clusterSessions`. */
  id: number;
  /** Primer frame de la sesión, formato MO "23-Jul-2026 22:00:00" (UTC). */
  start: string;
  /** Último frame de la sesión, mismo formato. */
  end: string;
  /** YYYYMMDD del primer frame (UTC). */
  startDate: string;
  /** YYYYMMDD del último frame (UTC). */
  endDate: string;
  /** Número de imágenes en la sesión. */
  imageCount: number;
  /** Duración en minutos (end - start). */
  durationMinutes: number;
  /** `true` si la sesión cruza la medianoche UTC (startDate !== endDate). */
  crossesMidnight: boolean;
};

/**
 * Umbral por defecto para considerar un gap como corte de sesión.
 * Coincide con `badGapHigh` del filtro de gaps: cualquier gap
 * estrictamente mayor se interpreta como "el observador dejó de
 * capturar, vuelve más tarde".
 */
export const DEFAULT_SESSION_BREAK_MIN = 30;

/**
 * Agrupa imágenes en sesiones separadas por gaps > `sessionBreakMin`.
 * No depende de la fecha UTC, por lo que detecta correctamente
 * secuencias que cruzan medianoche.
 *
 * Por qué este helper existe:
 *   La versión anterior agrupaba por `YYYYMMDD` (fecha UTC) antes de
 *   aplicar el filtro de gaps. Eso significaba que una sesión de
 *   22:00 a 02:00 (cruzando medianoche) se partía en dos grupos
 *   independientes, y el gap de 1.5h entre ellos nunca se evaluaba
 *   contra el filtro. Con el clustering por sesión, esos dos grupos
 *   ahora son uno solo, y los filtros se aplican correctamente sobre
 *   el conjunto completo.
 */
export function clusterSessions(
  rows: ImageRecord[],
  sessionBreakMin: number = DEFAULT_SESSION_BREAK_MIN,
): Session[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort(
    (a, b) => parseDt(a.datetime).getTime() - parseDt(b.datetime).getTime(),
  );
  const sessions: Session[] = [];

  let startRec = sorted[0];
  let endRec = sorted[0];
  let count = 1;

  const pushCurrent = (id: number) => {
    const startDate = dateKey(parseDt(startRec.datetime));
    const endDate = dateKey(parseDt(endRec.datetime));
    sessions.push({
      id,
      start: startRec.datetime,
      end: endRec.datetime,
      startDate,
      endDate,
      imageCount: count,
      durationMinutes: Math.round(
        (parseDt(endRec.datetime).getTime() -
          parseDt(startRec.datetime).getTime()) /
          60000,
      ),
      crossesMidnight: startDate !== endDate,
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const gapMin =
      (parseDt(r.datetime).getTime() - parseDt(endRec.datetime).getTime()) /
      60000;
    if (gapMin > sessionBreakMin) {
      pushCurrent(sessions.length);
      startRec = r;
      endRec = r;
      count = 1;
    } else {
      endRec = r;
      count++;
    }
  }
  pushCurrent(sessions.length);
  return sessions;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseDt(s: string): Date {
  // "20-Jul-2026 06:12:15" -> Date (asumiendo UTC, que es lo que da MO)
  const m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Fecha inválida: ${s}`);
  const [, dd, monStr, yyyy, hh, mi, ss] = m;
  const monthIdx = MONTHS.indexOf(monStr);
  if (monthIdx < 0) throw new Error(`Mes inválido en fecha: ${s}`);
  return new Date(Date.UTC(+yyyy, monthIdx, +dd, +hh, +mi, +ss));
}

export function toYyyyMmdd(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

export function dateKey(d: Date): string {
  return toYyyyMmdd(d);
}

export type ApplyGapFilterOptions = {
  threshold: number;
  inclusiveWeather?: boolean;   // default true (>= threshold)
  badGapLow?: number;            // default 4
  badGapHigh?: number;           // default 30
  badGapMid?: number;            // default 10 (frontera small/medium gap)
  weatherSensitive?: boolean;    // default true
  lang?: Lang;                   // idioma de los motivos de descarte
  /**
   * Gap mínimo (min) para considerar dos imágenes como pertenecientes
   * a sesiones distintas. Default 30. Lo usamos para reemplazar el
   * agrupamiento por fecha UTC: ahora una sesión de 22:00 a 02:00 que
   * cruza medianoche se trata como UNA sola sesión (no dos fechas).
   * Ver `clusterSessions`.
   */
  sessionBreakMin?: number;
};

export function applyGapFilter(
  rows: ImageRecord[],
  opts: ApplyGapFilterOptions,
): ApplyGapFilterResult {
  const {
    threshold,
    inclusiveWeather = true,
    badGapLow = 4,
    badGapHigh = 30,
    badGapMid = 10,
    weatherSensitive = true,
    lang = "en",
    sessionBreakMin = DEFAULT_SESSION_BREAK_MIN,
  } = opts;

  // Frontera entre "gap pequeño con vecino sospechoso" y "gap medio siempre malo".
  // - 4..badGapMid con vecino nuboso   -> descartar
  // - badGapMid..badGapHigh            -> descartar siempre
  // - >= badGapHigh                    -> OK (corte de sesión)
  // Subir este valor tolera pausas operativas más largas (slew, reenfoque,
  // cambio de filtro) sin penalizar la imagen adyacente.
  const BAD_GAP_MID = badGapMid;

  const passesWeather = (w: number) =>
    inclusiveWeather ? w >= threshold : w > threshold;

  // Agrupar por SESIÓN (no por fecha UTC). Esto arregla el bug histórico
  // donde secuencias que cruzaban medianoche se partían en dos grupos
  // independientes y los gaps a ambos lados del cambio de día no se
  // evaluaban. Ver `clusterSessions` y `project_memory.md`.
  const sessionList = clusterSessions(rows, sessionBreakMin);

  const kept: ImageRecord[] = [];
  const discarded: DiscardedRecord[] = [];

  for (const session of sessionList) {
    const sessionStartMs = parseDt(session.start).getTime();
    const sessionEndMs = parseDt(session.end).getTime();
    const items = rows.filter((r) => {
      const t = parseDt(r.datetime).getTime();
      return t >= sessionStartMs && t <= sessionEndMs;
    });
    const sorted = [...items].sort(
      (a, b) => parseDt(a.datetime).getTime() - parseDt(b.datetime).getTime(),
    );
    const n = sorted.length;

    for (let i = 0; i < n; i++) {
      const r = sorted[i];

      // Calculamos gaps a vecinos (los mostraremos aunque no fallen, para
      // que la UI pueda enseñar la "forma" de la secuencia al usuario).
      const prev = i > 0 ? sorted[i - 1] : undefined;
      const next = i < n - 1 ? sorted[i + 1] : undefined;
      const gapTo = (other: ImageRecord | undefined) =>
        other
          ? Math.abs(
              (parseDt(r.datetime).getTime() -
                parseDt(other.datetime).getTime()) /
                60000,
            )
          : null;
      const gapPrev = gapTo(prev);
      const gapNext = gapTo(next);

      // Acumulamos TODOS los motivos por los que esta imagen cae.
      // Antes se hacía `continue` tras el primer fallo de weather, lo que
      // ocultaba problemas adicionales de gap; ahora recogemos todos.
      const reasons: string[] = [];

      // 1) Chequeo de weather
      if (weatherSensitive && !passesWeather(r.weather)) {
        reasons.push(
          inclusiveWeather
            ? i18n("reason.weather", lang, { value: r.weather, threshold })
            : i18n("reason.weatherLeq", lang, { value: r.weather, threshold }),
        );
      }

      // 2) Chequeo de gap a cada vecino
      const checkNeighbor = (
        neighbor: ImageRecord | undefined,
        gap: number | null,
        label: string,
      ) => {
        if (neighbor === undefined || gap === null) return;
        if (weatherSensitive) {
          if (
            badGapLow! <= gap &&
            gap <= BAD_GAP_MID &&
            !passesWeather(neighbor.weather)
          ) {
            reasons.push(
              i18n("reason.gapCloudy", lang, {
                label,
                gap: gap.toFixed(1),
                min: badGapLow,
                mid: BAD_GAP_MID,
                neighbor: neighbor.weather,
              }),
            );
          } else if (BAD_GAP_MID < gap && gap < badGapHigh!) {
            reasons.push(
              i18n("reason.gapMedium", lang, {
                label,
                gap: gap.toFixed(1),
                mid: BAD_GAP_MID,
                high: badGapHigh,
              }),
            );
          }
        } else {
          if (BAD_GAP_MID < gap && gap < badGapHigh!) {
            reasons.push(
              i18n("reason.gapDark", lang, { label, gap: gap.toFixed(1) }),
            );
          }
        }
      };

      checkNeighbor(prev, gapPrev, "prev");
      checkNeighbor(next, gapNext, "next");

      if (reasons.length > 0) {
        discarded.push({ record: r, reasons, gapPrev, gapNext });
      } else {
        kept.push(r);
      }
    }
  }

  return { kept, discarded, sessions: sessionList };
}

export type FilterByDateRangeOptions = {
  start: Date | null;   // null = sin límite inferior
  end: Date | null;     // null = sin límite superior
};

export function filterByDateRange(
  rows: ImageRecord[],
  opts: FilterByDateRangeOptions,
): ImageRecord[] {
  if (opts.start === null && opts.end === null) return [...rows];
  // Comparamos por FECHA (YYYYMMDD) y no por datetime, para que un día
  // suelto (start==end) incluya todas las imágenes de esa noche aunque
  // estén datadas a las 04:30 UTC. Comparar Date objects fallaría
  // porque 04:30 > 00:00 del mismo día.
  const startKey = opts.start ? dateKey(opts.start) : null;
  const endKey = opts.end ? dateKey(opts.end) : null;
  return rows.filter((r) => {
    const k = dateKey(parseDt(r.datetime));
    if (startKey !== null && k < startKey) return false;
    if (endKey !== null && k > endKey) return false;
    return true;
  });
}

export function filterByTelescope(
  rows: ImageRecord[],
  telescope: string,
): ImageRecord[] {
  const t = telescope.toLowerCase();
  return rows.filter((r) => r.telescope.toLowerCase() === t);
}

/**
 * Filtra por el filtro óptico de captura (rueda de filtros del telescopio:
 * "V", "R", "I", "clear"...). Si el filtro es vacío, devuelve todo.
 * Importante: EXOTIC asume que todas las imágenes de un tránsito están
 * con el mismo filtro. Mezclar filtros contamina la curva de luz.
 */
export function filterByCaptureFilter(
  rows: ImageRecord[],
  filter: string,
): ImageRecord[] {
  const f = filter.trim();
  if (!f) return [...rows];
  return rows.filter((r) => r.filter === f);
}

/**
 * Devuelve los filtros únicos presentes en un set de filas, ordenados
 * alfabéticamente. Útil para el discovery de la UI.
 */
export function discoverFilters(rows: ImageRecord[]): string[] {
  return Array.from(
    new Set(rows.map((r) => r.filter).filter((f) => f.length > 0)),
  ).sort();
}

/**
 * Elige el filtro más común de un set de filas. Si hay empate, el primero
 * alfabéticamente. Si no hay filas, devuelve "".
 */
export function pickMostCommonFilter(rows: ImageRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.filter) continue;
    counts.set(r.filter, (counts.get(r.filter) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [f, c] of counts) {
    if (c > bestCount || (c === bestCount && f < best)) {
      best = f;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Formatos de fecha (UI DD-MM-YYYY, storage YYYYMMDD)
// ---------------------------------------------------------------------------

/** YYYYMMDD -> DD-MM-YYYY. Si el input no encaja, lo devuelve tal cual. */
export function toDDMMYYYY(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  return `${yyyymmdd.slice(6, 8)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(0, 4)}`;
}

/** Acepta DD-MM-YYYY o YYYY-MM-DD. Devuelve YYYYMMDD o null. */
export function fromAnyDateFormat(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}${m[2]}${m[1]}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return null;
}

/**
 * Parsea un argumento de fecha. Acepta:
 *   - ""                                  -> sin rango
 *   - "DD-MM-YYYY" / "YYYY-MM-DD"         -> un día
 *   - ":DD-MM-YYYY"                       -> solo límite superior
 *   - "DD-MM-YYYY:"                       -> solo límite inferior
 *   - "DD-MM-YYYY:DD-MM-YYYY" o YYYY-MM-DD:YYYY-MM-DD  -> rango
 * El separador `:` puede ir con o sin espacios alrededor.
 */
export function parseDateArg(
  s: string,
  lang: Lang = "en",
): { start: Date | null; end: Date | null } {
  if (!s || !s.trim()) return { start: null, end: null };
  const trimmed = s.trim();
  const parseOne = (str: string): Date | null => {
    const t = str.trim();
    if (!t) return null;
    const yyyymmdd = fromAnyDateFormat(t);
    if (!yyyymmdd) {
      throw new Error(
        i18n("error.invalidDateFormat", lang, { value: str }),
      );
    }
    return new Date(
      Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)),
    );
  };
  if (trimmed.includes(":")) {
    const [a, b] = trimmed.split(":", 2);
    const start = parseOne(a);
    const end = parseOne(b);
    if (start && end && end < start) {
      return { start: end, end: start };
    }
    return { start, end };
  }
  const d = parseOne(trimmed);
  return { start: d, end: d };
}
