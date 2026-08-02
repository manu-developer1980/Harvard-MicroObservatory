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
  parseDateArg,
  parseDt,
  dateKey,
  toDDMMYYYY,
  type ImageRecord,
} from "@/lib/filters";

export const prerender = false;

type PreviewRequest = {
  target?: string;
  date?: string;
  threshold?: number;
  telescope?: string;
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
  rangeLabel: string;
  telescopes?: string[];           // cuando no se pasa telescopio
  transitByDate: DateGroup[];
  transitDiscarded: Array<{ record: ImageRecord; reason: string }>;
  darkCount: number;
  darkByTelescope: number;
  transitTotal: number;
  transitKept: number;
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

  // 3. Filtrar tránsito
  let transitRows = filterByTelescope(allRows, telescope);
  transitRows = filterByDateRange(transitRows, { start, end });
  const { kept, discarded } = applyGapFilter(transitRows, {
    threshold,
    inclusiveWeather,
    weatherSensitive: true,
  });

  // 4. Fetch Dark-C
  const darkHtml = await fetchHtml({ target: "Dark-C-", sortRange: "500" });
  let darkRows: ImageRecord[] = [];
  if (darkHtml && darkHtml !== "") {
    darkRows = parseRows(darkHtml);
    darkRows = filterByTelescope(darkRows, telescope);
    darkRows = filterByDateRange(darkRows, { start, end });
  }

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
  let finalDiscarded = [...discarded];
  if (requireDarks) {
    finalKept = kept.filter((r) => darkDates.has(dateKey(parseDt(r.datetime))));
    const removed = kept.filter(
      (r) => !darkDates.has(dateKey(parseDt(r.datetime))),
    );
    for (const r of removed) {
      finalDiscarded.push({ record: r, reason: "sin darks disponibles en esta fecha" });
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

  return json({
    ok: true,
    target,
    telescope,
    threshold,
    rangeLabel,
    transitByDate,
    transitDiscarded,
    darkCount: darkRows.length,
    darkByTelescope: darkByDateMap.size,
    transitTotal: transitRows.length,
    transitKept: finalKept.length,
  } satisfies PreviewResponse);
};
