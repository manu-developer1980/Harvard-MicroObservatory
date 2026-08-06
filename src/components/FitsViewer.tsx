/**
 * FitsViewer: modal visor de FITS.
 *
 * Renderiza un FITS individual (PNG) + metadatos + navegación
 * prev/next entre todas las imágenes actualmente SELECCIONADAS.
 * El botón "Descartar" desmarca la imagen en el checklist principal
 * y avanza a la siguiente seleccionada.
 *
 * Datos:
 *   - El listado de archivos navegables se recibe como prop desde
 *     Downloader (es la lista de FITS actualmente SELECCIONADOS en
 *     el checklist). Si esa lista cambia (p.ej. tras un Descartar
 *     que eliminó la imagen actual), el índice se re-anchora a la
 *     nueva posición o se cierra el modal si no queda nada.
 *   - La imagen se carga vía `/api/fits-view/[file]?meta=1` para
 *     obtener metadatos (sin transferir el PNG entero), y luego vía
 *     la URL directa del endpoint con cache del navegador. Los
 *     metadatos se cachean en la CDN 1 día, igual que el PNG.
 *
 * Accesibilidad:
 *   - Esc cierra
 *   - ←/→ navega
 *   - El modal tiene role="dialog" + aria-modal
 *   - Focus trap básico (cerrar al click fuera también)
 */
import { useEffect, useRef, useState } from "react";
import { t as i18n, type Lang } from "@/lib/i18n";

export type FitsViewerMetadata = {
  ok: boolean;
  file: string;
  width: number;
  height: number;
  bitpix: number;
  bzero: number;
  bscale: number;
  object?: string;
  telescope?: string;
  filter?: string;
  exptime?: number;
  dateObs?: string;
  stats: { min: number; max: number; mean: number };
};

type FitsViewerProps = {
  /**
   * Lista de archivos navegables (FITS filenames), en el orden que
   * deben aparecer en el viewer. Típicamente la lista de archivos
   * actualmente SELECCIONADOS en el checklist.
   */
  orderedFiles: ReadonlyArray<string>;
  /** Archivo que se está visualizando ahora. Si no está en orderedFiles
   *  (p.ej. porque acaba de ser descartado), el modal se cierra. */
  currentFile: string;
  /** Cierra el modal. */
  onClose: () => void;
  /** Salta al anterior seleccionado (no-op si ya estamos en el primero). */
  onPrev: () => void;
  /** Salta al siguiente seleccionado (no-op si ya estamos en el último). */
  onNext: () => void;
  /** Descarta el archivo actual: lo quita del set de seleccionados
   *  Y avanza al siguiente (el padre decide cómo resolver el caso
   *  "último descartado"). */
  onDiscard: (file: string) => void;
  lang: Lang;
};

const VIEW_BASE = "/api/fits-view/";

export default function FitsViewer({
  orderedFiles,
  currentFile,
  onClose,
  onPrev,
  onNext,
  onDiscard,
  lang,
}: FitsViewerProps) {
  const [meta, setMeta] = useState<FitsViewerMetadata | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const currentIdx = orderedFiles.indexOf(currentFile);
  const position =
    currentIdx >= 0 ? currentIdx + 1 : 0;
  const total = orderedFiles.length;
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < total - 1;

  // Carga los metadatos del archivo actual cada vez que cambia.
  // Si abortamos por cambio rápido, no contaminamos el siguiente render.
  useEffect(() => {
    if (!currentFile) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setMeta(null);
    setMetaErr(null);
    setImgLoaded(false);
    setImgErr(null);
    (async () => {
      try {
        const r = await fetch(VIEW_BASE + encodeURIComponent(currentFile) + "?meta=1", {
          signal: ctrl.signal,
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(text || `HTTP ${r.status}`);
        }
        const data = (await r.json()) as FitsViewerMetadata;
        if (ctrl.signal.aborted) return;
        setMeta(data);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setMetaErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctrl.abort();
  }, [currentFile]);

  // Teclado: Esc / ← / →
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && hasPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && hasNext) {
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onClose, onPrev, onNext]);

  if (!currentFile || currentIdx < 0) {
    // Si el archivo actual ya no está en la lista (p.ej. fue
    // descartado y la lista de navegables se ha vaciado para esa
    // imagen), cerramos automáticamente al siguiente tick.
    // Hacemos esto en un effect para evitar setState durante render.
    useEffect(() => {
      onClose();
    }, [onClose]);
    return null;
  }

  const imgUrl = `${VIEW_BASE}${encodeURIComponent(currentFile)}?stretch=asinh`;
  const fmt = (v: number | undefined): string =>
    v === undefined || v === null || Number.isNaN(v)
      ? i18n("viewer.metadata.unknown", lang)
      : String(v);

  return (
    <div
      className="fits-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={i18n("viewer.title", lang, { file: currentFile })}
      onClick={(e) => {
        // Click fuera del contenido cierra
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fits-viewer" onClick={(e) => e.stopPropagation()}>
        <header className="fits-viewer-header">
          <h3>
            <code>{currentFile}</code>
            {total > 1 && (
              <span className="fits-viewer-position">
                {i18n("viewer.position", lang, {
                  current: position,
                  total,
                })}
              </span>
            )}
          </h3>
          <button
            type="button"
            className="fits-viewer-close"
            onClick={onClose}
            aria-label={i18n("viewer.closeAria", lang)}
            title={i18n("viewer.close", lang)}
          >
            ×
          </button>
        </header>

        <div className="fits-viewer-body">
          <div className="fits-viewer-image-wrap">
            {!imgLoaded && !imgErr && (
              <div className="fits-viewer-loading">
                {i18n("viewer.loading", lang)}
              </div>
            )}
            {imgErr && (
              <div className="error">
                {i18n("viewer.error", lang, { msg: imgErr })}
              </div>
            )}
            {/* La <img> siempre se renderiza para que el browser
                gestione la cache HTTP (Cache-Control 1 día) y los
                callbacks onLoad/onError. El placeholder loading se
                muestra encima hasta que carga. */}
            <img
              ref={imgRef}
              src={imgUrl}
              alt={currentFile}
              onLoad={() => setImgLoaded(true)}
              onError={() =>
                setImgErr(i18n("viewer.error", lang, { msg: "load failed" }))
              }
              style={{ display: imgLoaded ? "block" : "none" }}
            />
          </div>

          <aside className="fits-viewer-metadata">
            <h4>{i18n("viewer.metadata", lang)}</h4>
            {metaErr ? (
              <div className="error">
                {i18n("viewer.error", lang, { msg: metaErr })}
              </div>
            ) : !meta ? (
              <div className="hint">{i18n("viewer.loading", lang)}</div>
            ) : (
              <dl>
                <dt>{i18n("viewer.metadata.object", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.object ?? i18n("viewer.metadata.unknown", lang)}</dd>
                <dt>{i18n("viewer.metadata.telescope", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.telescope ?? i18n("viewer.metadata.unknown", lang)}</dd>
                <dt>{i18n("viewer.metadata.filter", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.filter ?? i18n("viewer.metadata.unknown", lang)}</dd>
                <dt>{i18n("viewer.metadata.exptime", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{i18n("viewer.metadata.exptime", lang, { value: fmt(meta.exptime) })}</dd>
                <dt>{i18n("viewer.metadata.dateObs", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.dateObs ?? i18n("viewer.metadata.unknown", lang)}</dd>
                <dt>{i18n("viewer.metadata.bitpix", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{i18n("viewer.metadata.bitpix", lang, { value: String(meta.bitpix) })}</dd>
                <dt>{i18n("viewer.metadata.dimensions", lang, { width: 0, height: 0 }).replace(/:\s*$/, "").replace(/0×0$/, "")}</dt>
                <dd>{i18n("viewer.metadata.dimensions", lang, { width: meta.width, height: meta.height })}</dd>
                <dt>{i18n("viewer.metadata.min", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.stats.min.toFixed(2)}</dd>
                <dt>{i18n("viewer.metadata.max", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.stats.max.toFixed(2)}</dd>
                <dt>{i18n("viewer.metadata.mean", lang, { value: "" }).replace(/:\s*$/, "")}</dt>
                <dd>{meta.stats.mean.toFixed(2)}</dd>
              </dl>
            )}
          </aside>
        </div>

        <footer className="fits-viewer-footer">
          <button
            type="button"
            onClick={onPrev}
            disabled={!hasPrev}
            aria-label={i18n("viewer.prevAria", lang)}
          >
            {i18n("viewer.prev", lang)}
          </button>
          <button
            type="button"
            className="fits-viewer-discard"
            onClick={() => onDiscard(currentFile)}
            aria-label={i18n("viewer.discardAria", lang)}
            title={i18n("viewer.discardAria", lang)}
          >
            {i18n("viewer.discard", lang)}
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext}
            aria-label={i18n("viewer.nextAria", lang)}
          >
            {i18n("viewer.next", lang)}
          </button>
        </footer>
      </div>
    </div>
  );
}
