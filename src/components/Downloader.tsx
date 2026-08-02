import { useEffect, useRef, useState } from "react";
import { AVAILABLE_TARGETS } from "@/lib/targets";
import {
  fromAnyDateFormat,
  toDDMMYYYY,
  type ImageRecord,
} from "@/lib/filters";

// Importamos JSZip solo en el cliente (dentro del handler) para que el SSR
// de Astro no intente evaluar el CJS de jszip (su entry usa `require()`).
type JSZipLike = {
  file: (path: string, data: Blob) => void;
  generateAsync: (opts: { type: "blob" }) => Promise<Blob>;
};

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
  rangeLabel: string;
  telescopes?: string[];
  transitByDate: DateGroup[];
  transitDiscarded: Array<{ record: ImageRecord; reason: string }>;
  darkCount: number;
  darkByTelescope: number;
  transitTotal: number;
  transitKept: number;
};

type DownloadProgress = {
  total: number;
  done: number;
  current: string;
  phase: "idle" | "downloading" | "zipping" | "done" | "error";
  errorMsg?: string;
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

function thresholdLabel(t: number): string {
  if (t < 50) return "muy permisivo";
  if (t < 75) return "permisivo";
  if (t < 85) return "estándar";
  if (t < 95) return "recomendado";
  return "muy estricto";
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

export default function Downloader() {
  const [target, setTarget] = useState("Qatar-6");
  const [date, setDate] = useState("");
  const [threshold, setThreshold] = useState(85);
  const [telescope, setTelescope] = useState("");
  const [requireDarks, setRequireDarks] = useState(true);
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  const [telescopes, setTelescopes] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [progress, setProgress] = useState<DownloadProgress>({
    total: 0,
    done: 0,
    current: "",
    phase: "idle",
  });

  const dateStartRef = useRef<HTMLInputElement>(null);
  const dateEndRef = useRef<HTMLInputElement>(null);

  // Resetea los inputs nativos de fecha cuando cambia el target
  // (así los iconos siempre abren el calendario limpio).
  useEffect(() => {
    if (dateStartRef.current) dateStartRef.current.value = "";
    if (dateEndRef.current) dateEndRef.current.value = "";
  }, [target]);

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

  // Paso 1: descubrir telescopios cuando cambia el target
  useEffect(() => {
    let cancelled = false;
    setTelescopes(null);
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

  // Paso 2: preview
  const handlePreview = async () => {
    if (!telescope) {
      setErrMsg("Selecciona un telescopio");
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
        telescope,
        inclusiveWeather: true,
        requireDarks,
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
    const allFiles: Array<{ path: string; file: string }> = [];
    for (const g of preview.transitByDate) {
      for (const r of g.transit) {
        allFiles.push({ path: `${g.date}/${r.fits}`, file: r.fits });
      }
      for (const r of g.darks) {
        allFiles.push({ path: `${g.date}/darks/${r.fits}`, file: r.fits });
      }
    }
    if (allFiles.length === 0) {
      setErrMsg("No hay archivos para descargar");
      return;
    }

    setProgress({
      total: allFiles.length,
      done: 0,
      current: "",
      phase: "downloading",
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
  const totalFiles = totalTransit + totalDarks;

  return (
    <div className="downloader">
      <h1>MicroObservatory Downloader</h1>
      <p className="lead">
        Descarga imágenes FITS de exoplanetas y Dark-C de calibración desde
        MicroObservatory (Harvard CFA), con filtros de weather y continuidad
        temporal.
      </p>

      <fieldset disabled={progress.phase === "downloading" || progress.phase === "zipping"}>
        <div className="row">
          <label>
            <span>Exoplaneta</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {AVAILABLE_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="date-range">
            <span>Rango de fechas</span>
            <div className="date-range-row">
              <div className="date-field">
                <div className="date-row">
                  <input
                    type="text"
                    value={dateStart}
                    onChange={(e) => setDateStart(e.target.value)}
                    placeholder="Inicio (DD-MM-YYYY)"
                    className="date-text"
                    aria-label="Fecha de inicio"
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
                    aria-label="Calendario de inicio"
                    title="Seleccionar fecha de inicio"
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
                    placeholder="Fin (DD-MM-YYYY)"
                    className="date-text"
                    aria-label="Fecha de fin"
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
                    aria-label="Calendario de fin"
                    title="Seleccionar fecha de fin"
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
              Deja un campo vacío para no aplicar ese límite.
            </small>
          </label>

          <label className="threshold">
            <span>
              Umbral clear % (≥) — <span className="hint">recomendado 85</span>
            </span>
            <div className="threshold-row">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
                aria-label="Umbral de cielo despejado"
                className="threshold-slider"
              />
              <div
                className={`threshold-badge tier-${thresholdTier(threshold)}`}
                aria-live="polite"
              >
                <strong>{threshold}%</strong>
                <small>{thresholdLabel(threshold)}</small>
              </div>
            </div>
            
          </label>

          <label>
            <span>Telescopio</span>
            {telescopes === null ? (
              <input type="text" disabled value="cargando..." />
            ) : telescopes.length === 0 ? (
              <input
                type="text"
                value={telescope}
                onChange={(e) => setTelescope(e.target.value)}
                placeholder="sin datos"
              />
            ) : (
              <select
                value={telescope}
                onChange={(e) => setTelescope(e.target.value)}
              >
                <option value="">-- elige --</option>
                {telescopes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={requireDarks}
              onChange={(e) => setRequireDarks(e.target.checked)}
            />
            <span>Requerir darks en cada fecha</span>
          </label>
        </div>

        <div className="actions">
          <button
            type="button"
            onClick={handlePreview}
            disabled={loading || !telescope}
          >
            {loading ? "..." : "Previsualizar"}
          </button>
          {preview && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={
                progress.phase === "downloading" ||
                progress.phase === "zipping" ||
                totalFiles === 0
              }
              className="primary"
            >
              Descargar ZIP ({totalFiles} FITS)
            </button>
          )}
        </div>
      </fieldset>

      {errMsg && <div className="error">{errMsg}</div>}

      {preview && (
        <div className="preview">
          <h2>Resumen</h2>
          <ul>
            <li>
              <strong>Target:</strong> {preview.target} ({preview.telescope})
            </li>
            <li>
              <strong>Rango:</strong> {preview.rangeLabel}
            </li>
            <li>
              <strong>Tránsito total analizado:</strong> {preview.transitTotal}
            </li>
            <li>
              <strong>Trántico que pasa filtros:</strong> {preview.transitKept}
            </li>
            <li>
              <strong>Dark-C del telescopio:</strong> {preview.darkCount} (en{" "}
              {preview.darkByTelescope} fechas)
            </li>
          </ul>

          {preview.transitByDate.length === 0 ? (
            <p className="warn">
              No hay fechas que cumplan los filtros. Prueba a relajar el umbral
              o el rango de fechas.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tránsito</th>
                  <th>Darks</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {preview.transitByDate.map((g) => (
                  <tr key={g.date}>
                    <td>{toDDMMYYYY(g.date)}</td>
                    <td>{g.transit.length}</td>
                    <td>{g.darks.length}</td>
                    <td>{g.transit.length + g.darks.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.transitDiscarded.length > 0 && (
            <details>
              <summary>
                {preview.transitDiscarded.length} imágenes descartadas (primeras)
              </summary>
              <table>
                <thead>
                  <tr>
                    <th>Fecha UT</th>
                    <th>Clear%</th>
                    <th>Short</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.transitDiscarded.map((d, i) => (
                    <tr key={i}>
                      <td>{d.record.datetime}</td>
                      <td>{d.record.weather}%</td>
                      <td>{d.record.short}</td>
                      <td>{d.reason}</td>
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
              Descargando {progress.done}/{progress.total} — {progress.current}
              <progress
                value={progress.done}
                max={progress.total}
              />
            </>
          )}
          {progress.phase === "zipping" && "Comprimiendo ZIP..."}
          {progress.phase === "done" && "✅ ZIP descargado"}
          {progress.phase === "error" && `❌ ${progress.errorMsg}`}
        </div>
      )}
    </div>
  );
}
