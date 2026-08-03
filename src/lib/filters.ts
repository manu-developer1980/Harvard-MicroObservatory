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
 */

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
};

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

  // Agrupar por fecha (UTC)
  const byDate = new Map<string, ImageRecord[]>();
  for (const r of rows) {
    const d = parseDt(r.datetime);
    const key = dateKey(d);
    const arr = byDate.get(key);
    if (arr) arr.push(r);
    else byDate.set(key, [r]);
  }

  const kept: ImageRecord[] = [];
  const discarded: DiscardedRecord[] = [];

  for (const [, items] of byDate) {
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
            ? `weather ${r.weather}%<${threshold}%`
            : `weather ${r.weather}%<=${threshold}%`,
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
              `gap ${label}=${gap.toFixed(1)}min (rango 4-${BAD_GAP_MID}) + vecino nuboso (${neighbor.weather}%)`,
            );
          } else if (BAD_GAP_MID < gap && gap < badGapHigh!) {
            reasons.push(
              `gap ${label}=${gap.toFixed(1)}min (rango ${BAD_GAP_MID}-${badGapHigh})`,
            );
          }
        } else {
          if (BAD_GAP_MID < gap && gap < badGapHigh!) {
            reasons.push(
              `gap ${label}=${gap.toFixed(1)}min (modo dark)`,
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

  return { kept, discarded };
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
export function parseDateArg(s: string): { start: Date | null; end: Date | null } {
  if (!s || !s.trim()) return { start: null, end: null };
  const trimmed = s.trim();
  const parseOne = (str: string): Date | null => {
    const t = str.trim();
    if (!t) return null;
    const yyyymmdd = fromAnyDateFormat(t);
    if (!yyyymmdd) {
      throw new Error(
        `Fecha inválida: ${str} (esperado DD-MM-YYYY o YYYY-MM-DD)`,
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
