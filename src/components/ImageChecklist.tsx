/**
 * ImageChecklist: checklist expandible por sesión.
 *
 * Renderiza las imágenes de tránsito de UNA sesión (DateGroup) en
 * formato checklist interactivo:
 *   - Cabecera con checkbox maestro que sincroniza con todos los
 *     individuales. Refleja tres estados visuales:
 *       · ninguno seleccionado  → ☐
 *       · todos seleccionados    → ☑
 *       · selección parcial      → ▣ (aria-checked="mixed")
 *   - Cada fila: checkbox individual + filename + fecha/hora + weather% +
 *     filtro + telescopio + botón "Ver"
 *   - Click en el nombre del archivo abre el visor modal (lo gestiona
 *     el padre: `onView(file)`).
 *
 * El padre (Downloader) mantiene un Set GLOBAL de archivos
 * seleccionados (`selectedFiles`) y pasa la prop `selected` con el
 * subset que pertenece a este grupo. Los handlers de toggle/selectAll
 * notifican al padre, que es quien decide cómo mutar el Set.
 *
 * El botón "Descartar" del visor modal es el que se encarga de
 * desmarcar la imagen Y avanzar a la siguiente (no este componente).
 */
import { t as i18n, type Lang } from "@/lib/i18n";
import type { ImageRecord } from "@/lib/filters";

type ImageChecklistProps = {
  /** Records de tránsito de este grupo (excluye darks; el viewer
   *  está pensado para tránsito, los darks no son visualmente
   *  informativos). */
  records: ReadonlyArray<ImageRecord>;
  /** Carpeta de la sesión, para la aria-label del expandible. */
  folderLabel: string;
  /** FITS filenames actualmente seleccionados en este grupo. */
  selected: ReadonlySet<string>;
  /** Toggle individual. */
  onToggle: (fits: string) => void;
  /** Seleccionar todos los de este grupo. */
  onSelectAll: () => void;
  /** Deseleccionar todos los de este grupo. */
  onSelectNone: () => void;
  /** Click sobre el nombre → abrir visor modal. */
  onView: (fits: string) => void;
  lang: Lang;
};

export default function ImageChecklist({
  records,
  folderLabel,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  onView,
  lang,
}: ImageChecklistProps) {
  // Recortamos records al shape que necesitamos (FITs filename +
  // datetime + weather + filter + telescope). Si records está vacío,
  // mostramos el placeholder.
  if (records.length === 0) {
    return (
      <div className="image-checklist image-checklist-empty">
        <small className="hint">{i18n("imageTable.empty", lang)}</small>
      </div>
    );
  }

  const total = records.length;
  const selectedInGroup = records.filter((r) => selected.has(r.fits)).length;
  // Tres estados: none, all, partial. CSS muestra el icono adecuado
  // con el atributo data-checked.
  const checkedState: "none" | "all" | "mixed" =
    selectedInGroup === 0 ? "none" : selectedInGroup === total ? "all" : "mixed";

  return (
    <div className="image-checklist">
      <table className="image-checklist-table">
        <thead>
          <tr>
            <th className="col-sel">
              {/* El checkbox "maestro" usa un <input type="checkbox">
                  para heredar la accesibilidad nativa del navegador
                  (click, space, etc.) y exponer el estado
                  indeterminate a AT. El atributo `indeterminate` no
                  se refleja en el HTML serializado, así que lo
                  seteamos imperativamente en un ref. */}
              <input
                type="checkbox"
                className="master-checkbox"
                checked={checkedState === "all"}
                ref={(el) => {
                  if (el) el.indeterminate = checkedState === "mixed";
                }}
                onChange={() => {
                  if (checkedState === "all") onSelectNone();
                  else onSelectAll();
                }}
                aria-label={i18n("imageTable.toggleAllAria", lang)}
                aria-checked={
                  checkedState === "mixed" ? "mixed" : checkedState === "all"
                }
                title={
                  checkedState === "all"
                    ? i18n("imageTable.selectNone", lang)
                    : i18n("imageTable.selectAll", lang)
                }
              />
            </th>
            <th>{i18n("imageTable.colFile", lang)}</th>
            <th>{i18n("imageTable.colDate", lang)}</th>
            <th>{i18n("imageTable.colWeather", lang)}</th>
            <th>{i18n("imageTable.colFilter", lang)}</th>
            <th>{i18n("imageTable.colTelescope", lang)}</th>
            <th className="col-action">{}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const isSelected = selected.has(r.fits);
            return (
              <tr
                key={r.fits}
                className={isSelected ? "" : "is-deselected"}
                data-checked={isSelected ? "true" : "false"}
              >
                <td className="col-sel">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(r.fits)}
                    aria-label={i18n("imageTable.toggleAria", lang, {
                      file: r.fits,
                    })}
                  />
                </td>
                <td>
                  {/* El filename es clickable → abre el viewer.
                      Usamos <button> en lugar de <a> para que no se
                      active el comportamiento de "open in new tab"
                      con Cmd+click. */}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onView(r.fits)}
                    aria-label={i18n("imageTable.viewAria", lang, {
                      file: r.fits,
                    })}
                  >
                    <code>{r.fits}</code>
                  </button>
                </td>
                <td><code>{r.datetime}</code></td>
                <td>{r.weather}%</td>
                <td><code>{r.filter || "—"}</code></td>
                <td><code>{r.telescope || "—"}</code></td>
                <td className="col-action">
                  <button
                    type="button"
                    onClick={() => onView(r.fits)}
                    className="link-button"
                    aria-label={i18n("imageTable.viewAria", lang, {
                      file: r.fits,
                    })}
                  >
                    {i18n("imageTable.viewButton", lang)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <small className="hint image-checklist-count">
        {i18n("imageTable.selectedCount", lang, {
          selected: selectedInGroup,
          total,
        })}
        {" · "}
        {folderLabel}
      </small>
    </div>
  );
}
