import { useEffect, useRef, useState } from "react";
import {
  fromAnyDateFormat,
  toDDMMYYYY,
  type ImageRecord,
} from "@/lib/filters";
import {
  buildAllFiles,
  groupContainsTransit,
  type DateGroupLite,
} from "@/lib/sequence-table";
import {
  t as i18n,
  getStoredLang,
  setStoredLang,
  type Lang,
} from "@/lib/i18n";
import {
  getValidToken,
  signIn as driveSignIn,
  signOut as driveSignOut,
  uploadSequenceToDrive,
  type DriveFile,
} from "@/lib/google-drive";

// Importamos JSZip solo en el cliente (dentro del handler) para que el SSR
// de Astro no intente evaluar el CJS de jszip (su entry usa `require()`).
type JSZipLike = {
  file: (path: string, data: Blob) => void;
  generateAsync: (opts: { type: "blob" }) => Promise<Blob>;
};

// Logo de Google Drive (triángulo oficial, no el "G" de Google).
// Lo usamos inline para no añadir un asset binario al bundle.
// Los colores coinciden con el branding público de Drive.
function GoogleDriveIcon() {
  return (
    <svg
      viewBox="0 0 87.3 78"
      width="18"
      height="16"
      aria-hidden="true"
      style={{ verticalAlign: "-3px", marginRight: "0.5rem" }}
    >
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-20.45 35.4c-.8 1.4-1.2 2.95-1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        fill="#ea4335"
      />
      <path
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  );
}

type DateGroup = {
  date: string;
  transit: ImageRecord[];
  darks: ImageRecord[];
};

type PreviewResponse = {
  ok: boolean;
  error?: string;
  target: string;
  telescope: string;
  threshold: number;
  badGapMid: number;
  rangeLabel: string;
  telescopes?: string[];
  filters?: string[];
  usedFilter?: string;
  filterAuto?: boolean;
  transitByDate: DateGroup[];
  transitDiscarded: Array<{
    record: ImageRecord;
    reasons: string[];
    gapPrev: number | null;
    gapNext: number | null;
  }>;
  darkCount: number;
  darkByTelescope: number;
  transitTotal: number;
  transitKept: number;
  darkDebug?: {
    totalParsed: number;
    selectedTelescope: string;
    inRange: number;
    byDate: Array<{
      date: string;
      count: number;
      telescopes: string[];
      filters: string[];
      times: string[];
      matchedScope: boolean;
    }>;
  };
  sequenceStart: string;
  sequenceEnd: string;
  sequenceMinutes: number;
  // Sesiones detectadas en la secuencia final (post-filtros). Sustituye
  // al agrupamiento por fecha UTC: una sesión de 22:00 a 02:00 que
  // cruza medianoche se reporta como UNA sola sesión. Ver
  // `lib/filters.ts → clusterSessions`.
  sessions: Array<{
    id: number;
    start: string;
    end: string;
    startDate: string;
    endDate: string;
    imageCount: number;
    durationMinutes: number;
    crossesMidnight: boolean;
  }>;
};

// Respuesta de /api/transit-check (NASA Exoplanet Archive cross-check).
// El endpoint usa TAP query a la tabla `ps` + cálculo propio de tránsitos
// (t_n = t0 + n*P) en vez de la Transit Service API, que ignora bJD/eJD
// y solo devuelve el "next transit".
//
// Desde la migración a "most precise" (réplica del TransitView de NASA),
// el endpoint devuelve UNA sola predicción: la de la efeméride con
// menor σ(t_n) propagada en la fecha de la consulta. `transit` está
// siempre presente (puede estar dentro o fuera de la ventana); su
// `offsetMin` indica la desviación (0 = dentro, ±X = minutos de
// diferencia con el borde más cercano).
type TransitCheckResponse = {
  ok: boolean;
  error?: string;
  target: string;
  matchedName?: string;     // pl_name que matcheó (e.g. "WASP-135 b")
  matchedHost?: string;     // hostname (e.g. "WASP-135" o "WASP-135 A")
  startJd: number;
  endJd: number;
  found: boolean;           // la predicción cae dentro de la ventana
  transit: TransitHit | null; // UNA sola predicción (la de la "most precise")
  source: string;
};

type TransitHit = {
  pl_name: string;
  hostname: string;
  midtimeJd: number;
  midtimeUtc: string;
  midtimeIso: string;
  period: number;
  duration?: number;        // horas
  uncertaintyJd: number;    // 1σ en días
  // Referencia bibliográfica usada para predecir este tránsito
  // (e.g. "Ivshina & Winn 2022"). Útil para verificar la predicción
  // contra el paper original si el resultado sorprende.
  reference?: string;
  // Minutos de diferencia con el borde más cercano de la ventana.
  // 0 si el midpoint está dentro. Positivo = tránsito ANTES del inicio
  // (empezaste tarde). Negativo = tránsito DESPUÉS del fin (terminaste
  // antes).
  offsetMin: number;
};

type TransitCheckState =
  | { state: "loading" }
  | { state: "found"; data: TransitCheckResponse }
  | { state: "nearMiss"; data: TransitCheckResponse; offsetMin: number }
  | { state: "notFound"; data: TransitCheckResponse }
  | { state: "error"; errorMsg: string };

// Umbral para considerar un tránsito como "near miss" en vez de "no
// transit". Lo razonable es la mitad de un tránsito típico: 2h.
const NEAR_MISS_THRESHOLD_MIN = 120;

type DownloadProgress = {
  total: number;
  done: number;
  current: string;
  phase:
    | "idle"
    | "downloading"
    | "zipping"
    | "preparing"
    | "uploading"
    | "done"
    | "error";
  errorMsg?: string;
  operation?: "zip" | "drive";
};

const FITS_PROXY = "/api/fits/";

// Tiers cualitativos para colorear el badge según el umbral.
// < 50%: muy permisivo (cielo mayormente cubierto)
// 50-74%: permisivo
// 75-84%: exigente pero habitual
// 85-94%: estricto (recomendado para EXOTIC)
// ≥ 95%: muy estricto
function thresholdTier(t: number): "loose" | "mild" | "strict" | "extreme" {
  if (t < 50) return "loose";
  if (t < 75) return "mild";
  if (t < 85) return "strict";
  return "extreme";
}

function thresholdLabelKey(t: number): string {
  if (t < 50) return "threshold.veryPermissive";
  if (t < 75) return "threshold.permissive";
  if (t < 85) return "threshold.standard";
  if (t < 95) return "threshold.recommended";
  return "threshold.veryStrict";
}

function thresholdLabel(t: number, lang: Lang): string {
  return i18n(thresholdLabelKey(t), lang);
}

// Tier cualitativo del umbral de gap entre frames (BAD_GAP_MID).
// Mientras MÁS BAJO el valor, más estricto: gaps cortos ya descartan.
// 5-8: estricto; 9-12: recomendado (10); 13-20: permisivo; 21-30: laxo
function gapTier(g: number): "strict" | "balanced" | "permissive" | "loose" {
  if (g <= 8) return "strict";
  if (g <= 12) return "balanced";
  if (g <= 20) return "permissive";
  return "loose";
}

function gapLabelKey(g: number): string {
  if (g <= 8) return "gap.strict";
  if (g <= 12) return "gap.recommended";
  if (g <= 20) return "gap.permissive";
  return "gap.loose";
}

function gapLabel(g: number, lang: Lang): string {
  return i18n(gapLabelKey(g), lang);
}

// Formatea una duración en minutos a un string compacto legible:
//   0      -> "—"
//   < 60   -> "Ymin"
//   exacto -> "Xh"
//   mixto  -> "Xh Ymin"
// Sirve para mostrar de un vistazo la ventana temporal de la secuencia
// y compararla con la duración típica de un tránsito exoplanetario (1-4h).
function formatDuration(min: number): string {
  if (!min || min <= 0) return "—";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min - h * 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

async function fetchPreview(body: object): Promise<PreviewResponse> {
  const r = await fetch("/api/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as PreviewResponse;
  if (!r.ok || !data.ok) {
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return data;
}

async function downloadFits(file: string): Promise<Blob> {
  const r = await fetch(FITS_PROXY + encodeURIComponent(file));
  if (!r.ok) throw new Error(`FITS ${file}: HTTP ${r.status}`);
  return r.blob();
}

// buildAllFiles y groupContainsTransit están en `@/lib/sequence-table`
// (testables aisladas, sin React). Las importamos arriba.

type DownloaderProps = {
  /**
   * Idioma detectado en el servidor (Accept-Language) y pasado a la isla
   * para evitar un flash de español/inglés en el primer render.
   * El cliente luego puede sobrescribirlo si hay una preferencia en
   * localStorage o si el usuario cambia el idioma manualmente.
   */
  initialLang?: Lang;
};

// ---------------------------------------------------------------------------
// Tabla de secuencias con selección + tick verde de tránsito
// ---------------------------------------------------------------------------

type SequenceTableProps = {
  preview: PreviewResponse;
  /** TransitHit predicho por NASA (null si no hay tránsito aún o no se encontró). */
  transitHit: TransitHit | null;
  /** Fechas (YYYYMMDD) marcadas por el usuario. */
  selectedDates: ReadonlySet<string>;
  onToggleDate: (date: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  lang: Lang;
};

/**
 * Tabla de secuencias detectadas en el preview, con:
 *   - Columna "Sel." con checkbox por fila (solo si hay >1 secuencia)
 *   - Tick verde en la fila que contiene el tránsito predicho
 *   - Barra de selección rápida (todo / ninguno) sobre la tabla
 *
 * Si hay UNA sola secuencia, la columna "Sel." y la barra rápida se
 * omiten (no hay nada que seleccionar). El tick verde sí se muestra
 * porque sigue siendo útil como indicador visual de "esta fila es
 * la que tiene el tránsito".
 */
function SequenceTable({
  preview,
  transitHit,
  selectedDates,
  onToggleDate,
  onSelectAll,
  onSelectNone,
  lang,
}: SequenceTableProps) {
  const groups = preview.transitByDate;
  const multiSelect = groups.length > 1;

  return (
    <>
      {multiSelect && (
        <div className="sequence-table-toolbar">
          <span className="sequence-table-toolbar-label">
            {i18n("sequenceTable.selectedCount", lang, {
              selected: selectedDates.size,
              total: groups.length,
            })}
          </span>
          <div className="sequence-table-toolbar-actions">
            <button
              type="button"
              className="link-button"
              onClick={onSelectAll}
              disabled={
                selectedDates.size === groups.length ||
                groups.length === 0
              }
            >
              {i18n("sequenceTable.selectAll", lang)}
            </button>
            <span className="dot-sep">·</span>
            <button
              type="button"
              className="link-button"
              onClick={onSelectNone}
              disabled={selectedDates.size === 0}
            >
              {i18n("sequenceTable.selectNone", lang)}
            </button>
          </div>
        </div>
      )}
      <table className="sequence-table">
        <thead>
          <tr>
            {multiSelect && <th className="col-sel">{i18n("sequenceTable.colSel", lang)}</th>}
            <th>{i18n("sequenceTable.colDate", lang)}</th>
            <th>{i18n("sequenceTable.colTransit", lang)}</th>
            <th>{i18n("sequenceTable.colDarks", lang)}</th>
            <th>{i18n("sequenceTable.colTotal", lang)}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const containsTransit = groupContainsTransit(g, transitHit);
            const selected = selectedDates.has(g.date);
            return (
              <tr
                key={g.date}
                className={
                  (containsTransit ? "contains-transit" : "") +
                  (!selected && multiSelect ? " is-deselected" : "")
                }
              >
                {multiSelect && (
                  <td className="col-sel">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggleDate(g.date)}
                      aria-label={i18n("sequenceTable.toggleAria", lang, {
                        date: toDDMMYYYY(g.date),
                      })}
                    />
                  </td>
                )}
                <td>
                  {toDDMMYYYY(g.date)}
                  {containsTransit && (
                    <span
                      className="transit-tick"
                      title={i18n("sequenceTable.transitTickTitle", lang)}
                      aria-label={i18n(
                        "sequenceTable.transitTickTitle",
                        lang,
                      )}
                    >
                      {" "}✓
                    </span>
                  )}
                </td>
                <td>{g.transit.length}</td>
                <td>{g.darks.length}</td>
                <td>{g.transit.length + g.darks.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export default function Downloader({ initialLang }: DownloaderProps = {}) {
  // IMPORTANTE: el initial state debe coincidir EXACTAMENTE con el SSR
  // para que la hidratación de React no falle (#425/#418/#423). El SSR
  // siempre usa `initialLang` (derivado de Accept-Language en index.astro),
  // así que el cliente hace lo mismo en su primer render. La preferencia
  // de localStorage se aplica DESPUÉS, en un useEffect, para evitar
  // mismatch cuando el usuario cambió el idioma en una visita previa.
  const [lang, setLangState] = useState<Lang>(initialLang ?? "en");
  // Tras montar, sincronizamos con la preferencia persistida. Si difiere
  // del valor SSR, forzamos un re-render con el idioma guardado. Esto
  // se ejecuta UNA sola vez (deps []) y solo en cliente.
  useEffect(() => {
    const stored = getStoredLang();
    if (stored && stored !== lang) {
      setLangState(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cuando cambia lang, persistirlo y reflejarlo en <html lang="...">.
  // También emitimos un CustomEvent `mo:lang` para que el Footer (que
  // vive como componente hermano) re-renderice con el nuevo idioma.
  // (No podemos levantar el estado a un Context sin refactor mayor, y
  // un evento es lo más simple para sincronizar dos islas React
  // independientes en la misma página.)
  useEffect(() => {
    setStoredLang(lang);
    document.documentElement.lang = lang;
    window.dispatchEvent(new CustomEvent<Lang>("mo:lang", { detail: lang }));
  }, [lang]);

  function setLang(next: Lang) {
    setLangState(next);
  }

  const [target, setTarget] = useState("Qatar-6");
  const [date, setDate] = useState("");
  const [threshold, setThreshold] = useState(85);
  const [badGapMid, setBadGapMid] = useState(10);
  const [telescope, setTelescope] = useState("");
  const [requireDarks, setRequireDarks] = useState(true);
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  // Lista de targets: SIEMPRE viene de /api/targets (que parsea el
  // desplegable oficial de MO en tiempo real). No hay lista fija.
  // - targets = [] hasta que el primer fetch termine
  // - targetsState controla el badge junto a la label
  // - lastUpdate se muestra para que el usuario sepa cuán fresca es la lista
  const [targets, setTargets] = useState<string[]>([]);
  const [targetsState, setTargetsState] = useState<
    "loading" | "live" | "error"
  >("loading");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const [telescopes, setTelescopes] = useState<string[] | null>(null);
  const [filters, setFilters] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Selección de secuencias para descargar/subir. Solo se muestra la
  // UI (checkbox por fila) cuando hay más de UNA secuencia. Por
  // defecto, todas las secuencias están seleccionadas (Set con todas
  // las fechas). Se re-inicializa automáticamente cuando llega un
  // preview nuevo (ver useEffect más abajo) para evitar arrastrar
  // selecciones obsoletas entre requests.
  const [selectedDates, setSelectedDates] = useState<Set<string>>(
    () => new Set(),
  );

  // Cuando llega un preview nuevo, marcamos todas sus fechas como
  // seleccionadas. Esto cubre dos casos:
  //   (a) primer preview: Set estaba vacío
  //   (b) preview regenerado: el usuario podría tener fechas que ya
  //       no existen; las limpiamos y volvemos a seleccionar las
  //       nuevas. Sin esto, una fecha descartada pero previamente
  //       seleccionada quedaría "huérfana" en el Set.
  useEffect(() => {
    if (preview) {
      setSelectedDates(new Set(preview.transitByDate.map((g) => g.date)));
    } else {
      setSelectedDates(new Set());
    }
  }, [preview]);

  const [progress, setProgress] = useState<DownloadProgress>({
    total: 0,
    done: 0,
    current: "",
    phase: "idle",
  });

  // Cross-check con NASA Exoplanet Archive: ¿hay un midpoint de tránsito
  // predicho dentro de la ventana de la secuencia? Token anti-race: si el
  // usuario cambia target/fecha y vuelve a pedir preview, descartamos la
  // respuesta de la consulta anterior.
  const [transitCheck, setTransitCheck] = useState<TransitCheckState | null>(
    null,
  );
  const transitCheckTokenRef = useRef(0);

  // Anti auto-fetch en el mount: el target arranca con un valor por
  // defecto ("Qatar-6") y el useEffect de "Paso 1" tiene [target] como
  // dependencia, lo que dispara un fetchPreview automático al cargar la
  // página — antes de que el usuario haya hecho nada. Eso generaba un
  // error/loading state no deseado al primer render. Marcamos el primer
  // ciclo como "skip" para que solo se ejecute cuando el usuario cambie
  // el target interactivamente.
  const targetChangeSkipRef = useRef(true);

  // Google Drive: el token se persiste en localStorage desde
  // google-drive.ts. Al montar comprobamos si sigue válido (1h de
  // expiry) y lo reflejamos en estado. El token REAL usado al subir
  // se vuelve a leer de storage en cada click de "Subir" para evitar
  // carrera si expiró mientras el usuario leía el preview.
  const [driveToken, setDriveToken] = useState<string | null>(null);
  // URL a la carpeta raíz `EXOTIC/<target>/` tras una subida exitosa.
  // null = no hemos subido nada en esta sesión.
  const [driveDoneUrl, setDriveDoneUrl] = useState<string | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);

  const dateStartRef = useRef<HTMLInputElement>(null);
  const dateEndRef = useRef<HTMLInputElement>(null);

  // Resetea los inputs nativos de fecha cuando cambia el target
  // (así los iconos siempre abren el calendario limpio).
  useEffect(() => {
    if (dateStartRef.current) dateStartRef.current.value = "";
    if (dateEndRef.current) dateEndRef.current.value = "";
  }, [target]);

  // Restaura la sesión de Google Drive al montar, si el token
  // persistido en localStorage sigue siendo válido. Si está caducado,
  // google-drive.ts lo borra y devuelve null.
  useEffect(() => {
    setDriveToken(getValidToken());
  }, []);

  function openDatePicker(ref: React.RefObject<HTMLInputElement>) {
    const el = ref.current;
    if (!el) return;
    // showPicker() es Chrome/Edge/Firefox/Safari modernos.
    // Si no existe (viejos), hacemos focus() y el navegador
    // abrirá su UI nativa al recibir foco en un <input type="date">.
    const anyEl = el as HTMLInputElement & {
      showPicker?: () => void;
    };
    if (typeof anyEl.showPicker === "function") {
      try {
        anyEl.showPicker();
        return;
      } catch {
        /* fallback abajo */
      }
    }
    el.focus();
    el.click();
  }

  // Aplica la fecha del calendario al text input como DD-MM-YYYY.
  // El calendario entrega YYYY-MM-DD; nosotros lo normalizamos y
  // almacenamos en formato legible.
  function applyDatePick(
    yyyy_mm_dd: string,
    setter: (v: string) => void,
  ) {
    const picked = fromAnyDateFormat(yyyy_mm_dd);
    if (picked) setter(toDDMMYYYY(picked));
  }

  // Compone el argumento `date` que espera la API a partir de los dos
  // text inputs. Vacío = sin límite en ese extremo.
  //   ""                -> todos los datos
  //   "29-07-2026"      -> solo ese día
  //   ":29-07-2026"     -> desde el inicio hasta ese día
  //   "19-07-2026:"     -> desde ese día en adelante
  //   "19-07-2026:25-07-2026" -> rango
  function buildDateArg(): string {
    const s = dateStart.trim();
    const e = dateEnd.trim();
    if (!s && !e) return "";
    if (s && e) return `${s}:${e}`;
    if (s) return s;
    return `:${e}`;
  }

  // Refresca la lista de targets al montar y cada 60 s. Sin fallback
  // estático: si MO no responde, mostramos error + botón de reintento.
  // Si ya teníamos una lista cargada y un refresh falla, conservamos la
  // lista anterior pero marcamos el estado como "error" para que el
  // usuario sepa que está viendo datos potencialmente obsoletos.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const res = await fetch("/api/targets");
        const data = await res.json();
        if (cancelled) return;
        if (data?.ok && Array.isArray(data.targets) && data.targets.length > 0) {
          setTargets(data.targets);
          setTargetsState("live");
          setLastUpdate(new Date());
        } else {
          setTargetsState("error");
        }
      } catch {
        if (!cancelled) setTargetsState("error");
      }
    }

    refresh();
    timer = setInterval(refresh, 60 * 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Refresco manual disparado por el botón al lado del select.
  const handleTargetsRefresh = async () => {
    setTargetsState("loading");
    try {
      const res = await fetch("/api/targets");
      const data = await res.json();
      if (data?.ok && Array.isArray(data.targets) && data.targets.length > 0) {
        setTargets(data.targets);
        setTargetsState("live");
        setLastUpdate(new Date());
      } else {
        setTargetsState("error");
      }
    } catch {
      setTargetsState("error");
    }
  };

  // Paso 1: descubrir telescopios cuando cambia el target
  useEffect(() => {
    // Saltamos la primera ejecución: es la del mount inicial con el
    // target por defecto. No queremos lanzar un fetchPreview antes de
    // que el usuario haya interactuado con la página.
    if (targetChangeSkipRef.current) {
      targetChangeSkipRef.current = false;
      return;
    }
    let cancelled = false;
    setTelescopes(null);
    setFilters(null);
    setFilter("");
    setPreview(null);
    if (!target) return;
    setLoading(true);
    setErrMsg(null);
    fetchPreview({ target })
      .then((data) => {
        if (cancelled) return;
        setTelescopes(data.telescopes ?? []);
        if (data.telescopes && data.telescopes.length === 1) {
          setTelescope(data.telescopes[0]);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Paso 1b: descubrir filtros cuando cambia el telescopio
  useEffect(() => {
    if (!telescope) {
      setFilters(null);
      setFilter("");
      return;
    }
    let cancelled = false;
    setFilters(null);
    setFilter("");
    setPreview(null);
    setLoading(true);
    fetchPreview({ target, telescope, threshold })
      .then((data) => {
        if (cancelled) return;
        const list = data.filters ?? [];
        setFilters(list);
        // Si hay un solo filtro, lo seleccionamos automáticamente.
        // Si hay varios, dejamos en "__auto__" para autodetect en backend.
        if (list.length === 1) {
          setFilter(list[0]);
        } else {
          setFilter("__auto__");
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [telescope, target, threshold]);

  // Paso 2: preview
  const handlePreview = async () => {
    if (!telescope) {
      setErrMsg(i18n("error.noTelescope", lang));
      return;
    }
    setLoading(true);
    setErrMsg(null);
    setPreview(null);
    try {
      const data = await fetchPreview({
        target,
        date: buildDateArg(),
        threshold,
        badGapMid,
        telescope,
        filter,
        inclusiveWeather: true,
        requireDarks,
        lang,
      });
      setPreview(data);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Paso 3: descargar ZIP
  const handleDownload = async () => {
    if (!preview) return;
    // Usamos la selección del usuario (Set de fechas marcadas). Si
    // hay una sola secuencia, el Set contiene su única fecha y
    // buildAllFiles devuelve lo mismo que antes — sin overhead.
    const allFiles = buildAllFiles(preview.transitByDate, selectedDates);
    if (allFiles.length === 0) {
      setErrMsg(i18n("error.noFiles", lang));
      return;
    }

    setProgress({
      total: allFiles.length,
      done: 0,
      current: "",
      phase: "downloading",
      operation: "zip",
    });

    // Import dinámico: jszip solo se carga en el navegador, no en SSR.
    const { default: JSZipCtor } = (await import("jszip")) as {
      default: new () => JSZipLike;
    };
    const zip: JSZipLike = new JSZipCtor();
    const concurrency = 4;
    let done = 0;

    async function worker(queue: typeof allFiles) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        setProgress((p) => ({ ...p, current: next.file }));
        try {
          const blob = await downloadFits(next.file);
          zip.file(next.path, blob);
        } catch (e) {
          console.error("FITS download failed:", next.file, e);
        }
        done++;
        setProgress((p) => ({ ...p, done }));
      }
    }

    const queues: typeof allFiles[] = Array.from({ length: concurrency }, () => []);
    allFiles.forEach((f, i) => queues[i % concurrency].push(f));
    await Promise.all(queues.map(worker));

    setProgress((p) => ({ ...p, phase: "zipping", current: "" }));
    try {
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${target}_${preview.transitByDate[0]?.date ?? "all"}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setProgress((p) => ({ ...p, phase: "done" }));
    } catch (e) {
      setProgress((p) => ({
        ...p,
        phase: "error",
        errorMsg: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  const totalTransit =
    preview?.transitByDate.reduce((acc, g) => acc + g.transit.length, 0) ?? 0;
  const totalDarks =
    preview?.transitByDate.reduce((acc, g) => acc + g.darks.length, 0) ?? 0;
  // FITS totales (todas las secuencias, independiente de la selección).
  // Se usa para el resumen "Tránsito que pasa filtros" del summary ul.
  const totalFiles = totalTransit + totalDarks;

  // FITS de las secuencias SELECCIONADAS. Es lo que realmente se
  // descarga/sube cuando el usuario pulsa el botón. Cuando hay una
  // sola secuencia, selectedDates contiene su única fecha y este
  // conteo es igual a totalFiles. Cuando hay varias, refleja la
  // suma de las filas marcadas.
  const selectedFilesCount = preview
    ? preview.transitByDate.reduce(
        (acc, g) =>
          selectedDates.has(g.date)
            ? acc + g.transit.length + g.darks.length
            : acc,
        0,
      )
    : 0;

  // Abre el popup de Google para autorizar `drive.file` scope. Tras
  // éxito, persiste el token (con su expiry) en localStorage y refleja
  // el estado en memoria.
  const handleDriveSignIn = async () => {
    setErrMsg(null);
    setDriveBusy(true);
    try {
      const tok = await driveSignIn();
      setDriveToken(tok);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "Sign-in cancelled" no es un error de cara al usuario.
      if (!/cancelled/i.test(msg)) {
        setErrMsg(i18n("drive.signInError", lang, { errorMsg: msg }));
      }
    } finally {
      setDriveBusy(false);
    }
  };

  const handleDriveSignOut = async () => {
    setDriveBusy(true);
    try {
      await driveSignOut();
    } catch {
      /* si falla la revocación en Google, al menos limpiamos local */
    }
    setDriveToken(null);
    setDriveDoneUrl(null);
    setDriveBusy(false);
  };

  // Sube la misma lista de archivos que handleDownload a
  // EXOTIC/<target>/.../ replicando la estructura del ZIP.
  const handleDriveUpload = async () => {
    if (!preview) return;
    // Releemos el token del storage: podría haber expirado entre
    // el sign-in y este click (1h). Si no hay token válido, pedimos
    // re-auth silenciosamente.
    let token = getValidToken();
    if (!token) {
      try {
        token = await driveSignIn();
        setDriveToken(token);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/cancelled/i.test(msg)) {
          setErrMsg(i18n("drive.signInError", lang, { errorMsg: msg }));
        }
        return;
      }
    }
    const allFiles = buildAllFiles(preview.transitByDate, selectedDates);
    if (allFiles.length === 0) {
      setErrMsg(i18n("error.noFiles", lang));
      return;
    }
    setErrMsg(null);
    setDriveDoneUrl(null);
    setDriveBusy(true);
    setProgress({
      total: allFiles.length,
      done: 0,
      current: "",
      phase: "preparing",
      operation: "drive",
    });
    try {
      const { rootFolderUrl } = await uploadSequenceToDrive(
        token,
        preview.target,
        allFiles,
        (p) => setProgress({ ...p, operation: "drive" }),
      );
      setDriveDoneUrl(rootFolderUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProgress({
        total: allFiles.length,
        done: 0,
        current: "",
        phase: "error",
        operation: "drive",
        errorMsg: msg,
      });
    } finally {
      setDriveBusy(false);
    }
  };

  // Cuando el usuario tiene un preview con ventana temporal válida, lanzamos
  // una consulta al endpoint de NASA para ver si hay un tránsito predicho
  // dentro de la ventana. Token anti-race: si el usuario cambia el target
  // y vuelve a pedir preview mientras la consulta anterior sigue en vuelo,
  // descartamos su respuesta.
  useEffect(() => {
    if (!preview?.sequenceStart || !preview.sequenceEnd) {
      setTransitCheck(null);
      return;
    }
    const myToken = ++transitCheckTokenRef.current;
    setTransitCheck({ state: "loading" });
    fetch("/api/transit-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: preview.target,
        start: preview.sequenceStart,
        end: preview.sequenceEnd,
      }),
    })
      .then((r) => r.json() as Promise<TransitCheckResponse>)
      .then((data) => {
        if (myToken !== transitCheckTokenRef.current) return;
        if (!data.ok) {
          setTransitCheck({
            state: "error",
            errorMsg: data.error ?? "?",
          });
        } else if (data.found) {
          setTransitCheck({ state: "found", data });
        } else if (
          data.transit &&
          Math.abs(data.transit.offsetMin) <= NEAR_MISS_THRESHOLD_MIN
        ) {
          // La predicción de la "most precise" cae fuera pero cerca
          // (dentro de NEAR_MISS_THRESHOLD_MIN). Avisamos al usuario
          // de que se perdió por poco.
          setTransitCheck({
            state: "nearMiss",
            data,
            offsetMin: data.transit.offsetMin,
          });
        } else {
          setTransitCheck({ state: "notFound", data });
        }
      })
      .catch((e) => {
        if (myToken !== transitCheckTokenRef.current) return;
        setTransitCheck({
          state: "error",
          errorMsg: e instanceof Error ? e.message : String(e),
        });
      });
  }, [preview?.sequenceStart, preview?.sequenceEnd, preview?.target]);

  return (
    <div className="downloader">
      <div className="downloader-header">
        <h1>{i18n("app.title", lang)}</h1>
        <div
          className="lang-switcher"
          role="group"
          aria-label={i18n("app.lang.label", lang)}
        >
          <button
            type="button"
            className={lang === "es" ? "active" : ""}
            onClick={() => setLang("es")}
            aria-pressed={lang === "es"}
            title="Español"
          >
            ES
          </button>
          <span className="lang-sep">|</span>
          <button
            type="button"
            className={lang === "en" ? "active" : ""}
            onClick={() => setLang("en")}
            aria-pressed={lang === "en"}
            title="English"
          >
            EN
          </button>
        </div>
      </div>
      <p className="lead">{i18n("app.lead", lang)}</p>

      <fieldset disabled={progress.phase === "downloading" || progress.phase === "zipping"}>
        <div className="row">
          <label className="targets-field">
            <span>
              {i18n("field.exoplanet", lang)}{" "}
              {targetsState === "live" ? (
                <small className="source-tag source-live">{i18n("status.live", lang)}</small>
              ) : targetsState === "error" ? (
                <small className="source-tag source-fallback">{i18n("status.error", lang)}</small>
              ) : (
                <small className="source-tag source-loading">{i18n("status.loading", lang)}</small>
              )}
            </span>
            {targets.length === 0 ? (
              <div className="targets-empty">
                {targetsState === "error" ? (
                  <>
                    <span>{i18n("targets.errorLoad", lang)}</span>
                    <button
                      type="button"
                      className="targets-retry"
                      onClick={handleTargetsRefresh}
                    >
                      {i18n("targets.retry", lang)}
                    </button>
                  </>
                ) : (
                  <span>{i18n("targets.loadingMsg", lang)}</span>
                )}
              </div>
            ) : (
              <div className="targets-row">
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={targetsState === "error"}
                >
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="targets-refresh"
                  onClick={handleTargetsRefresh}
                  disabled={targetsState === "loading"}
                  aria-label={i18n("targets.refreshAria", lang)}
                  title={i18n("targets.refreshTitle", lang)}
                >
                  ⟳
                </button>
              </div>
            )}
            {lastUpdate && targetsState === "live" ? (
              <small className="last-update">
                {i18n("targets.lastUpdate", lang, {
                  time: lastUpdate.toLocaleTimeString(),
                })}
              </small>
            ) : null}
          </label>

          <label className="date-range">
            <span>{i18n("field.dateRange", lang)}</span>
            <div className="date-range-row">
              <div className="date-field">
                <div className="date-row">
                  <input
                    type="text"
                    value={dateStart}
                    onChange={(e) => setDateStart(e.target.value)}
                    placeholder={i18n("field.dateStart", lang)}
                    className="date-text"
                    aria-label={i18n("field.dateStart", lang)}
                  />
                  <input
                    type="date"
                    ref={dateStartRef}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      applyDatePick(v, setDateStart);
                      e.target.value = "";
                    }}
                    className="date-native"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  <button
                    type="button"
                    className="date-icon"
                    onClick={() => openDatePicker(dateStartRef)}
                    aria-label={i18n("field.dateStart", lang)}
                    title={i18n("field.dateStart", lang)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="5" width="18" height="16" rx="2" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                      <line x1="8" y1="3" x2="8" y2="7" />
                      <line x1="16" y1="3" x2="16" y2="7" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="date-field">
                <div className="date-row">
                  <input
                    type="text"
                    value={dateEnd}
                    onChange={(e) => setDateEnd(e.target.value)}
                    placeholder={i18n("field.dateEnd", lang)}
                    className="date-text"
                    aria-label={i18n("field.dateEnd", lang)}
                  />
                  <input
                    type="date"
                    ref={dateEndRef}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      applyDatePick(v, setDateEnd);
                      e.target.value = "";
                    }}
                    className="date-native"
                    aria-hidden="true"
                    tabIndex={-1}
                  />
                  <button
                    type="button"
                    className="date-icon"
                    onClick={() => openDatePicker(dateEndRef)}
                    aria-label={i18n("field.dateEnd", lang)}
                    title={i18n("field.dateEnd", lang)}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="5" width="18" height="16" rx="2" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                      <line x1="8" y1="3" x2="8" y2="7" />
                      <line x1="16" y1="3" x2="16" y2="7" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            <small className="hint date-range-hint">
              {i18n("field.dateRangeHint", lang)}
            </small>
          </label>

          <label className="threshold">
            <span>
              {i18n("field.threshold", lang)}{" "}
              <span className="hint">{i18n("field.thresholdRec", lang)}</span>
            </span>
            <div className="threshold-row">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
                aria-label={i18n("field.threshold", lang)}
                className="threshold-slider"
              />
              <div
                className={`threshold-badge tier-${thresholdTier(threshold)}`}
                aria-live="polite"
              >
                <strong>{threshold}%</strong>
                <small>{thresholdLabel(threshold, lang)}</small>
              </div>
            </div>

          </label>

          <label className="gap">
            <span>
              {i18n("field.gap", lang)}{" "}
              <span className="hint">{i18n("field.gapRec", lang)}</span>
            </span>
            <div className="gap-row">
              <input
                type="range"
                min={5}
                max={30}
                step={1}
                value={badGapMid}
                onChange={(e) => setBadGapMid(parseInt(e.target.value, 10))}
                aria-label={i18n("field.gap", lang)}
                className="gap-slider"
              />
              <div
                className={`threshold-badge tier-${gapTier(badGapMid)}`}
                aria-live="polite"
              >
                <strong>{badGapMid} min</strong>
                <small>{gapLabel(badGapMid, lang)}</small>
              </div>
            </div>
            <small className="hint">
              {i18n("field.gapHint", lang, { gap: badGapMid })}
            </small>
          </label>

          <label>
            <span>{i18n("field.telescope", lang)}</span>
            {telescopes === null ? (
              <input
                type="text"
                disabled
                value={i18n("field.telescopeLoading", lang)}
              />
            ) : telescopes.length === 0 ? (
              <input
                type="text"
                value={telescope}
                onChange={(e) => setTelescope(e.target.value)}
                placeholder={i18n("field.telescopeEmpty", lang)}
              />
            ) : (
              <select
                value={telescope}
                onChange={(e) => setTelescope(e.target.value)}
              >
                <option value="">{i18n("field.telescopeChoose", lang)}</option>
                {telescopes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label>
            <span>
              {i18n("field.captureFilter", lang)}{" "}
              <span className="hint">{i18n("field.captureFilterHint", lang)}</span>
            </span>
            {filters === null ? (
              <input
                type="text"
                disabled
                value={i18n("field.telescopeLoading", lang)}
              />
            ) : filters.length === 0 ? (
              <input type="text" disabled value={i18n("field.filterEmpty", lang)} />
            ) : filters.length === 1 ? (
              <div className="filter-locked">
                <code>{filters[0]}</code>
                <small>{i18n("field.filterLocked", lang)}</small>
              </div>
            ) : (
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="__auto__">{i18n("field.filterAuto", lang)}</option>
                {filters.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="checkbox checkbox-warn">
            <input
              type="checkbox"
              checked={!requireDarks}
              onChange={(e) => setRequireDarks(!e.target.checked)}
            />
            <span>{i18n("field.allowWithoutDarks", lang)}</span>
            <small className="hint">
              {i18n("field.allowWithoutDarksHint", lang)}
            </small>
          </label>
        </div>

        <div className="actions">
          <button
            type="button"
            onClick={handlePreview}
            disabled={loading || !telescope}
          >
            {loading
              ? i18n("action.loading", lang)
              : i18n("action.preview", lang)}
          </button>
        </div>
      </fieldset>

      {errMsg && <div className="error">{errMsg}</div>}

      {preview && (
        <div className="preview">
          <h2>{i18n("summary.title", lang)}</h2>
          <ul>
            <li>
              {i18n("summary.target", lang, {
                target: preview.target,
                telescope: preview.telescope,
              })}
            </li>
            <li>
              {i18n("summary.range", lang, { range: preview.rangeLabel })}
            </li>
            <li>
              {i18n("summary.filter", lang, { filter: preview.usedFilter ?? "—" })}{" "}
              {preview.filterAuto ? (
                <em className="badge-auto">{i18n("summary.filterAuto", lang)}</em>
              ) : null}
            </li>
            <li>
              {i18n("summary.threshold", lang, { threshold: preview.threshold })}
            </li>
            <li>
              {i18n("summary.gap", lang, { gap: preview.badGapMid })}
            </li>
            <li>
              {i18n("summary.transitTotal", lang, { count: preview.transitTotal })}
            </li>
            <li>
              {i18n("summary.transitKept", lang, { count: preview.transitKept })}
            </li>
            <li>
              {i18n("summary.darks", lang, {
                count: preview.darkCount,
                dates: preview.darkByTelescope,
              })}
            </li>
            {preview.sequenceStart && (
              <li>
                {i18n("summary.sequence", lang, {
                  start: preview.sequenceStart,
                  end: preview.sequenceEnd,
                  duration: formatDuration(preview.sequenceMinutes),
                })}
                {(preview.sequenceMinutes < 60 ||
                  preview.sequenceMinutes > 480) && (
                  <small className="hint">
                    {" "}
                    {i18n("summary.sequenceHint", lang)}
                  </small>
                )}
              </li>
            )}
            {preview.sessions.length > 1 ||
            (preview.sessions.length === 1 &&
              preview.sessions[0].crossesMidnight) ? (
              <li className="sessions-summary">
                <strong>
                  {preview.sessions.length === 1
                    ? i18n("summary.sessions.one", lang)
                    : i18n("summary.sessions.other", lang, {
                        count: preview.sessions.length,
                      })}
                </strong>
                <ul className="sessions-list">
                  {preview.sessions.map((s) => (
                    <li key={s.id} className="session-item">
                      {i18n("summary.session", lang, {
                        id: s.id + 1,
                        start: s.start,
                        end: s.end,
                        duration: formatDuration(s.durationMinutes),
                        images: s.imageCount,
                      })}
                      {s.crossesMidnight && (
                        <small className="hint midnight">
                          {" "}
                          ⚠ {i18n("summary.crossesMidnight", lang)}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ) : null}
            {transitCheck && (
              <li className={`transit-check transit-${transitCheck.state}`}>
                <span className="transit-icon" aria-hidden="true">
                  {transitCheck.state === "loading" && "⏳"}
                  {transitCheck.state === "found" && "✓"}
                  {transitCheck.state === "nearMiss" && "△"}
                  {transitCheck.state === "notFound" && "✗"}
                  {transitCheck.state === "error" && "⚠"}
                </span>
                <span className="transit-label">
                  {transitCheck.state === "loading" &&
                    i18n("transit.loading", lang)}
                  {transitCheck.state === "found" &&
                    i18n("transit.foundOne", lang)}
                  {transitCheck.state === "nearMiss" &&
                    i18n("transit.nearMiss", lang, {
                      minutes: Math.abs(transitCheck.offsetMin),
                      sign: i18n(
                        transitCheck.offsetMin > 0
                          ? "transit.nearMissBefore"
                          : "transit.nearMissAfter",
                        lang,
                      ),
                    })}
                  {transitCheck.state === "notFound" &&
                    (transitCheck.data.matchedName
                      ? i18n("transit.notFound", lang)
                      : i18n("transit.notFoundTarget", lang))}
                  {transitCheck.state === "error" &&
                    i18n("transit.error", lang, {
                      errorMsg: transitCheck.errorMsg,
                    })}
                </span>
              </li>
            )}
          </ul>

          {preview.transitByDate.length === 0 ? (
            <p className="warn">{i18n("summary.empty", lang)}</p>
          ) : (
            <>
              <SequenceTable
                preview={preview}
                transitHit={
                  transitCheck && "data" in transitCheck
                    ? transitCheck.data.transit
                    : null
                }
                selectedDates={selectedDates}
                onToggleDate={(d: string) => {
                  setSelectedDates((prev) => {
                    const next = new Set(prev);
                    if (next.has(d)) next.delete(d);
                    else next.add(d);
                    return next;
                  });
                }}
                onSelectAll={() => {
                  setSelectedDates(
                    new Set(preview.transitByDate.map((g) => g.date)),
                  );
                }}
                onSelectNone={() => setSelectedDates(new Set())}
                lang={lang}
              />
              <div className="download-actions">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={
                    progress.phase === "downloading" ||
                    progress.phase === "zipping" ||
                    progress.phase === "uploading" ||
                    progress.phase === "preparing" ||
                    selectedFilesCount === 0
                  }
                  className="primary"
                >
                  {i18n("action.download", lang, {
                    count: selectedFilesCount,
                  })}
                </button>
                {driveToken ? (
                  <>
                    <button
                      type="button"
                      onClick={handleDriveUpload}
                      disabled={
                        driveBusy ||
                        progress.phase === "uploading" ||
                        progress.phase === "preparing" ||
                        progress.phase === "downloading" ||
                        progress.phase === "zipping" ||
                        selectedFilesCount === 0
                      }
                      className="primary"
                      title={i18n("action.drive.signInTitle", lang)}
                    >
                      ↑ {i18n("action.drive.upload", lang)}
                    </button>
                    <button
                      type="button"
                      onClick={handleDriveSignOut}
                      disabled={driveBusy}
                      className="link-button"
                      title={i18n("action.drive.signedInAs", lang)}
                    >
                      {i18n("action.drive.signOut", lang)}
                    </button>
                    {driveDoneUrl && (
                      <a
                        href={driveDoneUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="drive-link"
                      >
                        {i18n("action.drive.openFolder", lang)}
                      </a>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleDriveSignIn}
                    disabled={driveBusy}
                    className="drive-signin"
                    title={i18n("action.drive.signInTitle", lang)}
                  >
                    <GoogleDriveIcon />
                    {driveBusy
                      ? i18n("action.loading", lang)
                      : i18n("action.drive.signIn", lang)}
                  </button>
                )}
              </div>
              {transitCheck &&
                (transitCheck.state === "found" ||
                  transitCheck.state === "notFound" ||
                  transitCheck.state === "nearMiss") && (
                  <div
                    className={`transit-legend transit-${transitCheck.state}`}
                  >
                    <p>
                      {transitCheck.state === "found" &&
                        i18n("transit.legendFound", lang, {
                          matchedName: transitCheck.data.matchedName ?? "",
                        })}
                      {transitCheck.state === "notFound" &&
                        (transitCheck.data.matchedName
                          ? i18n("transit.legendNotFound", lang)
                          : i18n("transit.notFoundTarget", lang))}
                      {transitCheck.state === "nearMiss" &&
                        i18n("transit.legendNearMiss", lang, {
                          minutes: Math.abs(
                            "offsetMin" in transitCheck
                              ? transitCheck.offsetMin
                              : 0,
                          ),
                        })}
                    </p>
                    {transitCheck.state === "found" &&
                      transitCheck.data.transit && (
                        <>
                          <p className="hint">
                            {i18n("transit.midpoint", lang)}
                          </p>
                          <ul className="transit-midpoints">
                            <li>
                              <code>
                                {transitCheck.data.transit.midtimeUtc}
                              </code>
                              {transitCheck.data.transit.uncertaintyJd !=
                                null && (
                                <>
                                  {" "}
                                  — {i18n("transit.uncertainty", lang, {
                                    minutes: (
                                      transitCheck.data.transit.uncertaintyJd *
                                      24 *
                                      60
                                    ).toFixed(1),
                                  })}
                                </>
                              )}
                              {transitCheck.data.transit.duration != null &&
                                transitCheck.data.transit.period != null && (
                                  <>
                                    {" "}
                                    <span className="hint">
                                      (T ={" "}
                                      {transitCheck.data.transit.duration.toFixed(
                                        2,
                                      )}{" "}
                                      h, P ={" "}
                                      {transitCheck.data.transit.period.toFixed(
                                        4,
                                      )}{" "}
                                      d)
                                    </span>
                                  </>
                                )}
                            </li>
                          </ul>
                        </>
                      )}
                    {(transitCheck.state === "notFound" ||
                      transitCheck.state === "nearMiss") &&
                      transitCheck.data.transit && (
                        <>
                          <p className="hint">
                            {i18n("transit.nearest", lang)}
                          </p>
                          <ul className="transit-midpoints">
                            <li>
                              <code>
                                {transitCheck.data.transit.midtimeUtc}
                              </code>
                              {" "}
                              — {i18n("transit.nearestOffset", lang, {
                                minutes: Math.abs(
                                  transitCheck.data.transit.offsetMin,
                                ),
                                sign: i18n(
                                  transitCheck.data.transit.offsetMin > 0
                                    ? "transit.nearMissBefore"
                                    : "transit.nearMissAfter",
                                  lang,
                                ),
                              })}
                              {transitCheck.data.transit.duration != null && (
                                <>
                                  {" "}
                                  <span className="hint">
                                    (T ={" "}
                                    {transitCheck.data.transit.duration.toFixed(
                                      2,
                                    )}{" "}
                                    h)
                                  </span>
                                </>
                              )}
                            </li>
                          </ul>
                        </>
                      )}
                    {transitCheck.data.transit?.reference && (
                      <p className="hint transit-ephemeris">
                        {i18n("transit.ephemeris", lang, {
                          reference: transitCheck.data.transit.reference,
                        })}
                      </p>
                    )}
                    <p className="hint transit-source">
                      {i18n("transit.legendSource", lang)} ·{" "}
                      <a
                        href={`https://exoplanetarchive.ipac.caltech.edu/cgi-bin/TransitView/nph-visibletbls?dataset=transits&sname=${encodeURIComponent(transitCheck.data.matchedHost ?? preview.target)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {i18n("transit.viewInArchive", lang)} ↗
                      </a>
                    </p>
                  </div>
                )}
            </>
          )}

          {preview.transitDiscarded.length > 0 && (
            <details>
              <summary>
                {i18n("discarded.title", lang, {
                  count: preview.transitDiscarded.length,
                })}
              </summary>
              <table className="discarded">
                <thead>
                  <tr>
                    <th>{i18n("discarded.headers.date", lang)}</th>
                    <th>{i18n("discarded.headers.weather", lang)}</th>
                    <th>{i18n("discarded.headers.gapPrev", lang)}</th>
                    <th>{i18n("discarded.headers.gapNext", lang)}</th>
                    <th>{i18n("discarded.headers.filter", lang)}</th>
                    <th>{i18n("discarded.headers.telescope", lang)}</th>
                    <th>{i18n("discarded.headers.short", lang)}</th>
                    <th>{i18n("discarded.headers.reasons", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.transitDiscarded.map((d, i) => (
                    <tr key={i}>
                      <td><code>{d.record.datetime}</code></td>
                      <td>{d.record.weather}%</td>
                      <td>{d.gapPrev === null ? "—" : `${d.gapPrev.toFixed(1)}m`}</td>
                      <td>{d.gapNext === null ? "—" : `${d.gapNext.toFixed(1)}m`}</td>
                      <td><code>{d.record.filter || "—"}</code></td>
                      <td><code>{d.record.telescope || "—"}</code></td>
                      <td><code>{d.record.short}</code></td>
                      <td>
                        <ul className="reasons">
                          {d.reasons.map((r, j) => (
                            <li key={j}>{r}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {preview.darkDebug && preview.darkDebug.byDate.length > 0 && (
            <details>
              <summary>
                {i18n("darkDebug.title", lang, {
                  inRange: preview.darkDebug.inRange,
                  totalParsed: preview.darkDebug.totalParsed,
                  telescope: preview.darkDebug.selectedTelescope || "—",
                })}
              </summary>
              <p className="hint">{i18n("darkDebug.hint", lang)}</p>
              <table className="dark-debug">
                <thead>
                  <tr>
                    <th>{i18n("darkDebug.headers.date", lang)}</th>
                    <th>{i18n("darkDebug.headers.count", lang)}</th>
                    <th>{i18n("darkDebug.headers.match", lang)}</th>
                    <th>{i18n("darkDebug.headers.telescopes", lang)}</th>
                    <th>{i18n("darkDebug.headers.filters", lang)}</th>
                    <th>{i18n("darkDebug.headers.times", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.darkDebug.byDate.map((d) => (
                    <tr
                      key={d.date}
                      className={d.matchedScope ? "ok" : "mismatch"}
                    >
                      <td>{toDDMMYYYY(d.date)}</td>
                      <td>{d.count}</td>
                      <td>{d.matchedScope ? "✓" : "✗"}</td>
                      <td>
                        {d.telescopes.length === 0
                          ? "—"
                          : d.telescopes.map((t, i) => {
                              const isMatch =
                                t.toLowerCase() ===
                                preview.darkDebug!.selectedTelescope.toLowerCase();
                              return (
                                <span key={i}>
                                  {i > 0 ? ", " : ""}
                                  {isMatch ? <strong>{t}</strong> : t}
                                </span>
                              );
                            })}
                      </td>
                      <td>
                        {d.filters.length === 0 ? "—" : d.filters.join(", ")}
                      </td>
                      <td><code>{d.times.join(", ")}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}

      {progress.phase !== "idle" && (
        <div className={`progress phase-${progress.phase}`}>
          {progress.phase === "downloading" && (
            <>
              {i18n("progress.downloading", lang, {
                done: progress.done,
                total: progress.total,
                current: progress.current,
              })}
              <progress
                value={progress.done}
                max={progress.total}
              />
            </>
          )}
          {progress.phase === "zipping" && i18n("progress.zipping", lang)}
          {progress.phase === "preparing" && i18n("drive.preparing", lang)}
          {progress.phase === "uploading" && (
            <>
              {i18n("drive.uploading", lang, {
                done: progress.done,
                total: progress.total,
                current: progress.current,
              })}
              <progress
                value={progress.done}
                max={progress.total}
              />
            </>
          )}
          {progress.phase === "done" &&
            (progress.operation === "drive"
              ? i18n("drive.done", lang)
              : i18n("progress.done", lang))}
          {progress.phase === "error" &&
            (progress.operation === "drive"
              ? i18n("drive.error", lang, { errorMsg: progress.errorMsg ?? "" })
              : i18n("progress.error", lang, { errorMsg: progress.errorMsg ?? "" }))}
        </div>
      )}
    </div>
  );
}
