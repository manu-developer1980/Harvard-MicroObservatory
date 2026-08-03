/**
 * POST /api/preview
 *
 * Body: { target: string, date?: string, threshold?: number, telescope?: string }
 *
 * Aplica los mismos filtros que download_mo.py:
 *  1. Fetch HTML de MicroObservatory para el target.
 *  2. Filtra por telescopio y rango de fechas.
 *  3. Aplica applyGapFilter con weather_sensitive=true.
 *  4. Fetch HTML de Dark-C.
 *  5. Filtra darks por telescopio y rango de fechas (sin filtros adicionales).
 *  6. Devuelve JSON con la lista final por fecha, los descartados y los
 *     motivos. NO descarga los FITS (eso lo hace el cliente después).
 */
import type { APIRoute } from "astro";
import { fetchHtml, parseRows } from "@/lib/mo-client";
import {
  applyGapFilter,
  filterByDateRange,
  filterByTelescope,
  filterByCaptureFilter,
  discoverFilters,
  pickMostCommonFilter,
  parseDateArg,
  parseDt,
  dateKey,
  toDDMMYYYY,
  type ImageRecord,
  type DiscardedRecord,
} from "@/lib/filters";

export const prerender = false;

type PreviewRequest = {
  target?: string;
  date?: string;
  threshold?: number;
  telescope?: string;
  filter?: string;                  // "" o ausente = autodetect (el más común)
  badGapMid?: number;               // frontera small/medium gap (minutos)
  inclusiveWeather?: boolean;
  requireDarks?: boolean;
};

type DateGroup = {
  date: string;             // "20260725"
  transit: ImageRecord[];   // imágenes que pasan
  darks: ImageRecord[];     // darks de esa fecha
};

type PreviewResponse = {
  ok: boolean;
  error?: string;
  target: string;
  telescope: string;
  threshold: number;
  badGapMid: number;               // min: frontera small/medium gap usada
  rangeLabel: string;
  telescopes?: string[];           // cuando no se pasa telescopio
  filters?: string[];              // cuando no se pasa filtro
  usedFilter?: string;             // filtro realmente usado (post-autodetect)
  filterAuto?: boolean;            // true si usedFilter fue autodetect
  transitByDate: DateGroup[];
  transitDiscarded: DiscardedRecord[];
  darkCount: number;
  darkByTelescope: number;
  transitTotal: number;
  transitKept: number;
  darkDebug?: {
    totalParsed: number;           // todos los darks parseados (sin filtro de fecha)
    inRange: number;               // darks dentro del rango solicitado
    byDate: Array<{                // detalle por fecha en el rango
      date: string;                // YYYYMMDD
      count: number;
      telescopes: string[];
      filters: string[];
      times: string[];             // HH:MM:SS de cada dark
    }>;
  };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  let body: PreviewRequest;
  try {
    body = (await request.json()) as PreviewRequest;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }

  const target = (body.target ?? "").trim();
  if (!target) return json({ ok: false, error: "Falta target" }, 400);

  const threshold = typeof body.threshold === "number" ? body.threshold : 85;
  const inclusiveWeather = body.inclusiveWeather !== false; // default true
  const requireDarks = body.requireDarks !== false;          // default true
  const badGapMid =
    typeof body.badGapMid === "number" && body.badGapMid >= 4 && body.badGapMid <= 30
      ? body.badGapMid
      : 10;

  let start: Date | null;
  let end: Date | null;
  try {
    ({ start, end } = parseDateArg(body.date ?? ""));
  } catch (e) {
    return json(
      { ok: false, error: e instanceof Error ? e.message : "Fecha inválida" },
      400,
    );
  }

  // 1. Fetch HTML del target
  const targetHtml = await fetchHtml({ target, sortRange: "500" });
  if (targetHtml === null) {
    return json({ ok: false, error: "No se pudo obtener el listado del target" }, 502);
  }
  if (targetHtml === "") {
    return json({ ok: false, error: `El target '${target}' no tiene imágenes` }, 404);
  }
  const allRows = parseRows(targetHtml);
  if (allRows.length === 0) {
    return json({ ok: false, error: `No se parsearon filas de ${target}` }, 502);
  }

  // Descubrir telescopios disponibles
  const telescopes = Array.from(
    new Set(allRows.map((r) => r.telescope).filter((t) => t.length > 0)),
  ).sort();

  // 2. Si no nos pasan telescopio, devolvemos la lista y paramos
  const telescope = (body.telescope ?? "").trim();
  if (!telescope) {
    return json({
      ok: true,
      target,
      telescope: "",
      threshold,
      badGapMid,
      rangeLabel: "",
      telescopes,
      transitByDate: [],
      transitDiscarded: [],
      darkCount: 0,
      darkByTelescope: 0,
      transitTotal: allRows.length,
      transitKept: 0,
    } satisfies PreviewResponse);
  }

  // 2b. Filtros disponibles para este telescopio + rango de fechas.
  // Lo computamos desde las filas que ya matchean telescopio+fecha,
  // porque el filtro puede depender del telescopio (no todos los scopes
  // tienen todos los filtros).
  const scopedRows = filterByDateRange(
    filterByTelescope(allRows, telescope),
    { start, end },
  );
  const availableFilters = discoverFilters(scopedRows);

  // Si no nos pasan filtro, paramos aquí con la lista para que la UI
  // muestre el selector. Igual que con telescopes.
  const filterArg = (body.filter ?? "").trim();
  if (!filterArg) {
    return json({
      ok: true,
      target,
      telescope,
      threshold,
      badGapMid,
      rangeLabel: "",
      telescopes,
      filters: availableFilters,
      transitByDate: [],
      transitDiscarded: [],
      darkCount: 0,
      darkByTelescope: 0,
      transitTotal: scopedRows.length,
      transitKept: 0,
    } satisfies PreviewResponse);
  }

  // 2c. Resolver el filtro: si la UI manda "" o un filtro que no está
  // disponible, hacemos fallback al más común. Marcamos `filterAuto` para
  // que la UI pueda avisar al usuario de que se autodetectó.
  let usedFilter = filterArg;
  let filterAuto = false;
  if (usedFilter === "__auto__" || !availableFilters.includes(usedFilter)) {
    usedFilter = pickMostCommonFilter(scopedRows);
    filterAuto = true;
  }

  // 3. Filtrar tránsito
  let transitRows = filterByCaptureFilter(scopedRows, usedFilter);
  const { kept, discarded } = applyGapFilter(transitRows, {
    threshold,
    inclusiveWeather,
    badGapMid,
    weatherSensitive: true,
  });

  // 4. Fetch Dark-C.
  // IMPORTANTE: NO filtramos por telescopio ni por filtro de captura, solo
  // por fecha. Razón: el script Python original (download_mo.py) hacía
  // match solo por "mismo telescopio + misma fecha", y aun así fallaba en
  // algunos casos porque MO rota telescopios entre observaciones. Si el
  // usuario eligió un telescopio para el tránsito pero los darks de esa
  // noche los tomó otro, descartar todos los darks es demasiado estricto.
  // Por transparencia, el campo `darkDebug` lista los darks que SÍ existen
  // en el rango, para que el usuario pueda verificar la calibración.
  const darkHtml = await fetchHtml({ target: "Dark-C-", sortRange: "500" });
  let allDarkRows: ImageRecord[] = [];
  if (darkHtml && darkHtml !== "") {
    allDarkRows = parseRows(darkHtml);
  }
  // Subconjunto: solo los del rango consultado (lo que se usará de verdad)
  const darkRows = filterByDateRange(allDarkRows, { start, end });

  // 5. Intersección de fechas (tránsito válido + darks existentes)
  const transitDates = new Set(kept.map((r) => dateKey(parseDt(r.datetime))));
  const darkByDateMap = new Map<string, ImageRecord[]>();
  for (const r of darkRows) {
    const k = dateKey(parseDt(r.datetime));
    const arr = darkByDateMap.get(k);
    if (arr) arr.push(r);
    else darkByDateMap.set(k, [r]);
  }
  const darkDates = new Set(darkByDateMap.keys());

  let finalKept = kept;
  let finalDiscarded: DiscardedRecord[] = [...discarded];
  if (requireDarks) {
    finalKept = kept.filter((r) => darkDates.has(dateKey(parseDt(r.datetime))));
    const removed = kept.filter(
      (r) => !darkDates.has(dateKey(parseDt(r.datetime))),
    );
    for (const r of removed) {
      finalDiscarded.push({
        record: r,
        reasons: ["sin darks disponibles en esta fecha"],
        gapPrev: null,
        gapNext: null,
      });
    }
  }

  // 6. Agrupar por fecha para la respuesta
  const byDateMap = new Map<string, ImageRecord[]>();
  for (const r of finalKept) {
    const k = dateKey(parseDt(r.datetime));
    const arr = byDateMap.get(k);
    if (arr) arr.push(r);
    else byDateMap.set(k, [r]);
  }
  const transitByDate: DateGroup[] = [];
  for (const [date, transit] of byDateMap) {
    const darks = requireDarks ? (darkByDateMap.get(date) ?? []) : (darkByDateMap.get(date) ?? []);
    transitByDate.push({ date, transit, darks });
  }
  transitByDate.sort((a, b) => a.date.localeCompare(b.date));

  // Solo reportamos descartados del tránsito (no de darks)
  const transitDiscarded = finalDiscarded
    .filter((d) => transitRows.some((r) => r.fits === d.record.fits))
    .slice(0, 50);

  // Etiqueta de rango (formato DD-MM-YYYY para mostrar al usuario;
  // el ZIP sigue usando YYYYMMDD para la estructura de carpetas).
  let rangeLabel: string;
  const label = (d: Date) => toDDMMYYYY(dateKey(d));
  if (start === null && end === null) rangeLabel = "todas las fechas";
  else if (start && end && start.getTime() === end.getTime())
    rangeLabel = label(start);
  else if (start && end)
    rangeLabel = `${label(start)} → ${label(end)}`;
  else rangeLabel = "(rango parcial)";

  // Debug de darks: lista por fecha, con telescopios/filtros/horas presentes.
  // Sirve para que el usuario vea qué hay realmente disponible y por qué
  // un dark concreto podría no estar matcheando.
  const darkByDateDebugMap = new Map<
    string,
    { telescopes: Set<string>; filters: Set<string>; times: string[] }
  >();
  for (const r of darkRows) {
    const k = dateKey(parseDt(r.datetime));
    let entry = darkByDateDebugMap.get(k);
    if (!entry) {
      entry = { telescopes: new Set(), filters: new Set(), times: [] };
      darkByDateDebugMap.set(k, entry);
    }
    if (r.telescope) entry.telescopes.add(r.telescope);
    if (r.filter) entry.filters.add(r.filter);
    const t = parseDt(r.datetime);
    entry.times.push(
      `${String(t.getUTCHours()).padStart(2, "0")}:${String(
        t.getUTCMinutes(),
      ).padStart(2, "0")}:${String(t.getUTCSeconds()).padStart(2, "0")}`,
    );
  }
  const darkDebug = {
    totalParsed: allDarkRows.length,
    inRange: darkRows.length,
    byDate: Array.from(darkByDateDebugMap.entries())
      .map(([date, e]) => ({
        date,
        count: e.times.length,
        telescopes: Array.from(e.telescopes).sort(),
        filters: Array.from(e.filters).sort(),
        times: e.times.sort(),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };

  return json({
    ok: true,
    target,
    telescope,
    threshold,
    badGapMid,
    rangeLabel,
    usedFilter,
    filterAuto,
    transitByDate,
    transitDiscarded,
    darkCount: darkRows.length,
    darkByTelescope: darkByDateMap.size,
    transitTotal: transitRows.length,
    transitKept: finalKept.length,
    darkDebug,
  } satisfies PreviewResponse);
};
