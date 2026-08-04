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
  clusterSessions,
  type ImageRecord,
  type DiscardedRecord,
  type Session,
} from "@/lib/filters";
import { t, getReqLang, type Lang } from "@/lib/i18n";
import { PreviewRequestSchema, parseBody } from "@/lib/schemas";

export const prerender = false;

export type DateGroup = {
  /** YYYYMMDD (UTC) del primer frame del grupo. Estable entre sesiones
   *  del mismo día. La UI lo usa para mostrar la fecha legible y para
   *  agrupar visualmente. NO se usa como nombre de carpeta del ZIP —
   *  ver `folderName` más abajo. */
  date: string;
  /**
   * Nombre REAL de la carpeta dentro del ZIP / Google Drive. Por
   * defecto es igual a `date` (compatibilidad con herramientas
   * externas que esperan `Target/YYYYMMDD/`). Si hay más de una
   * sesión el mismo día, las subsiguientes llevan sufijo `-N`
   * (ej. `20260729-1`, `20260729-2`) para que cada sesión tenga su
   * propia carpeta y no se mezclen al descomprimir.
   *
   * El sufijo es estable entre requests (basado en el orden
   * cronológico de las sesiones) y consistente con la UI (la tabla
   * muestra `DD-MM-YYYY` o `DD-MM-YYYY-N` según corresponda).
   */
  folderName: string;
  /** Índice 1-based de la sesión dentro de su día (1 si es la única
   *  de ese día). Útil para la UI pero NO se usa en nombres de
   *  carpeta. */
  sessionIndex: number;
  /** Total de sesiones en el mismo `date`. 1 si es la única; >1
   *  cuando hay multi-secuencia y por tanto se aplican sufijos. */
  sessionCount: number;
  /** Imágenes de tránsito que pasan los filtros. */
  transit: ImageRecord[];
  /** Darks del telescopio elegido en esa fecha. */
  darks: ImageRecord[];
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
    selectedTelescope: string;      // telescopio elegido por el usuario
    inRange: number;               // darks (de cualquier scope) dentro del rango
    byDate: Array<{                // detalle por fecha en el rango
      date: string;                // YYYYMMDD
      count: number;
      telescopes: string[];
      filters: string[];
      times: string[];             // HH:MM:SS de cada dark
      matchedScope: boolean;       // true si hay dark del telescopio elegido
    }>;
  };
  // Ventana temporal de la secuencia final (imágenes que pasan los filtros
  // de weather + gap + darks). Vacío si no hay imágenes válidas.
  sequenceStart: string;           // "27-Jul-2026 04:18:42" (UTC)
  sequenceEnd: string;             // "27-Jul-2026 08:55:12" (UTC)
  sequenceMinutes: number;         // duración en minutos
  /**
   * Sesiones detectadas en la secuencia final. Sustituye al agrupamiento
   * por fecha UTC que teníamos antes: ahora una sesión de 22:00 a 02:00
   * que cruza medianoche se reporta como UNA sola sesión. La UI puede
   * mostrar la lista de sesiones y avisar si hay más de una.
   */
  sessions: Session[];
  /**
   * IDs de las imágenes de la primera y última sesión, para que la UI
   * pueda enlazar a cada bloque sin tener que buscar por timestamp.
   */
  sessionWindows: Array<{
    start: string;       // MO format
    end: string;         // MO format
    durationMinutes: number;
    imageCount: number;
    crossesMidnight: boolean;
  }>;
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
  // 1. Determinamos el idioma ANTES de cualquier respuesta de error
  // para que TODOS los mensajes vuelvan traducidos.
  const reqLang: Lang = getReqLang(request);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ ok: false, error: t("error.invalidJson", reqLang) }, 400);
  }

  const parsed = parseBody(PreviewRequestSchema, rawBody);
  if (!parsed.ok) {
    return json({ ok: false, error: parsed.error }, 400);
  }
  const body = parsed.data;

  // El body puede sobreescribir el lang (caso típico: el cliente forzó
  // un idioma distinto al de Accept-Language con el switcher).
  const finalLang: Lang = body.lang ?? reqLang;

  const target = body.target; // ya viene trimeado por Zod

  const threshold = body.threshold ?? 85;
  const inclusiveWeather = body.inclusiveWeather !== false; // default true
  const requireDarks = body.requireDarks !== false;          // default true
  const badGapMid = body.badGapMid ?? 10;                     // Zod ya acotó 4-30

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
      sequenceStart: "",
      sequenceEnd: "",
      sequenceMinutes: 0,
      sessions: [],
      sessionWindows: [],
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
      sequenceStart: "",
      sequenceEnd: "",
      sequenceMinutes: 0,
      sessions: [],
      sessionWindows: [],
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
    lang: finalLang,
  });

  // 4. Fetch Dark-C.
  // CRÍTICO: los darks deben ser del MISMO telescopio que las lights.
  // "Dark-C" en MO es solo el nombre del target; la "C" es la inicial del
  // telescopio (p.ej. "Telescope-C" o "C"). Mezclar darks de un scope con
  // lights de otro produce calibración incorrecta (diferente temperatura
  // de sensor, respuesta distinta, etc.). El campo `telescope` de cada
  // fila (parseado del CSV, índice 17) es la fuente de verdad.
  // NO filtramos por filtro de captura: el filtro afecta a la transmitancia
  // óptica, no a la corriente de oscuridad del sensor, así que el mismo
  // dark sirve para V, R, I, etc. (el script Python original tampoco
  // filtraba por filtro).
  const darkHtml = await fetchHtml({ target: "Dark-C-", sortRange: "500" });
  let allDarkRows: ImageRecord[] = [];
  if (darkHtml && darkHtml !== "") {
    allDarkRows = parseRows(darkHtml);
  }
  // Aplicamos solo el filtro de telescopio (NO capture filter, NO fecha aún).
  const darkForScope = filterByTelescope(allDarkRows, telescope);
  // Ahora sí: rango de fechas.
  const darkRows = filterByDateRange(darkForScope, { start, end });

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
        reasons: [t("reason.noDarks", finalLang)],
        gapPrev: null,
        gapNext: null,
      });
    }
  }

  // 6. Agrupar por SESIÓN (no por fecha) y asignar sufijos de carpeta.
  // Por qué por sesión y no por fecha: si hay >1 sesión en el mismo día
  // (p.ej. 08:10-09:27 y 10:00-10:30 con un gap de 33 min), el agrupamiento
  // por fecha las fusionaría en un solo grupo y el ZIP contendría una sola
  // carpeta mezclando ambas sesiones. Aquí las separamos en grupos
  // independientes y, si comparten `date` (YYYYMMDD), añadimos sufijo
  // `-N` al `folderName` (1, 2, 3...) para que el ZIP/Drive tenga
  // carpetas distintas. La UI muestra el sufijo para que el usuario
  // distinga las sesiones visualmente.
  //
  // Caso especial: sesiones que cruzan medianoche. Una sesión 22:00-02:00
  // tendría `startDate != endDate`; aquí usamos `startDate` como `date`
  // y le asignamos darks de ESA fecha (mantiene el comportamiento previo).
  const finalSessions = clusterSessions(finalKept);

  // Asignar índice y total por día
  const sessionsByDate = new Map<string, number>();
  for (const s of finalSessions) {
    sessionsByDate.set(s.startDate, (sessionsByDate.get(s.startDate) ?? 0) + 1);
  }
  const sessionIndexByDate = new Map<string, number>();

  const transitByDate: DateGroup[] = [];
  for (const session of finalSessions) {
    const date = session.startDate;
    const sessionCount = sessionsByDate.get(date) ?? 1;
    // sessionIndex: 1 si es la única, 1..N si hay varias
    const sessionIndex = (sessionIndexByDate.get(date) ?? 0) + 1;
    sessionIndexByDate.set(date, sessionIndex);

    // Imágenes de ESTA sesión (no de todas las del día, que es lo que
    // hacía el código antiguo). Usamos el rango temporal de la sesión
    // para filtrar, igual que en `applyGapFilter`.
    const sessionStartMs = parseDt(session.start).getTime();
    const sessionEndMs = parseDt(session.end).getTime();
    const transit = finalKept
      .filter((r) => {
        const t = parseDt(r.datetime).getTime();
        return t >= sessionStartMs && t <= sessionEndMs;
      })
      .sort(
        (a, b) => parseDt(a.datetime).getTime() - parseDt(b.datetime).getTime(),
      );

    // Darks de la fecha de la sesión. Mantenemos `requireDarks` como
    // estaba: si requireDarks=true, darkByDateMap solo tiene fechas
    // con darks; si no, podría venir vacío.
    const darks = darkByDateMap.get(date) ?? [];

    // folderName: sufijo -N si hay multi-secuencia en este día
    const folderName = sessionCount > 1 ? `${date}-${sessionIndex}` : date;

    transitByDate.push({
      date,
      folderName,
      sessionIndex,
      sessionCount,
      transit,
      darks,
    });
  }
  // Ya vienen ordenadas cronológicamente por clusterSessions, pero por
  // seguridad las reordenamos por date+sessionIndex para que la tabla
  // sea estable entre requests.
  transitByDate.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.sessionIndex - b.sessionIndex,
  );

  // Solo reportamos descartados del tránsito (no de darks)
  const transitDiscarded = finalDiscarded
    .filter((d) => transitRows.some((r) => r.fits === d.record.fits))
    .slice(0, 50);

  // Ventana temporal de la secuencia final: del primer al último frame
  // que pasa todos los filtros (weather + gap + darks). Ordenamos por
  // datetime UTC para que la duración sea correcta aunque la secuencia
  // cruce medianoche. Si no hay frames válidos, devolvemos strings vacíos.
  let sequenceStart = "";
  let sequenceEnd = "";
  let sequenceMinutes = 0;
  if (finalKept.length > 0) {
    const sortedByTime = [...finalKept].sort(
      (a, b) => parseDt(a.datetime).getTime() - parseDt(b.datetime).getTime(),
    );
    sequenceStart = sortedByTime[0].datetime;
    sequenceEnd = sortedByTime[sortedByTime.length - 1].datetime;
    sequenceMinutes = Math.round(
      (parseDt(sequenceEnd).getTime() -
        parseDt(sequenceStart).getTime()) /
        60000,
    );
  }

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
  // un dark concreto podría no estar matcheando. Marca también qué fechas
  // tienen dark del telescopio elegido (matchedScope) frente a las que
  // solo tienen darks de otros telescopios (no usables para calibración).
  const allDarkByDateMap = new Map<
    string,
    { telescopes: Set<string>; filters: Set<string>; times: string[] }
  >();
  for (const r of allDarkRows) {
    const k = dateKey(parseDt(r.datetime));
    let entry = allDarkByDateMap.get(k);
    if (!entry) {
      entry = { telescopes: new Set(), filters: new Set(), times: [] };
      allDarkByDateMap.set(k, entry);
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
  const telescopeLower = telescope.toLowerCase();
  const darkDebug = {
    totalParsed: allDarkRows.length,
    selectedTelescope: telescope,
    inRange: darkRows.length,
    byDate: Array.from(allDarkByDateMap.entries())
      .filter(([date]) => {
        // Solo fechas en el rango solicitado
        if (start && date < dateKey(start)) return false;
        if (end && date > dateKey(end)) return false;
        return true;
      })
      .map(([date, e]) => ({
        date,
        count: e.times.length,
        telescopes: Array.from(e.telescopes).sort(),
        filters: Array.from(e.filters).sort(),
        times: e.times.sort(),
        matchedScope: Array.from(e.telescopes).some(
          (tt) => tt.toLowerCase() === telescopeLower,
        ),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };

  // Reutilizamos `finalSessions` (calculado en la sección 6) para
  // reportar las ventanas de sesión. Esto es lo que se muestra al
  // usuario: si después de descartar imágenes la secuencia queda
  // partida en 2 sesiones (p.ej. porque se eliminó el bloque central
  // por nubosidad), eso debe verse.
  const sessionWindows = finalSessions.map((s) => ({
    start: s.start,
    end: s.end,
    durationMinutes: s.durationMinutes,
    imageCount: s.imageCount,
    crossesMidnight: s.crossesMidnight,
  }));

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
    sequenceStart,
    sequenceEnd,
    sequenceMinutes,
    sessions: finalSessions,
    sessionWindows,
  } satisfies PreviewResponse);
};
