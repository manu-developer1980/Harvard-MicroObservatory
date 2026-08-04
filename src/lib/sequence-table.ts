/**
 * Helpers de UI para la tabla de secuencias multi-noche.
 *
 * Separados del componente React para poder testearlos sin DOM
 * (vitest). Siguen el mismo patrón que `transit-match.ts` /
 * `filters.ts` — toda lógica de matching/parsing vive aquí, el
 * componente solo compone.
 */
import { parseDt, type ImageRecord } from "@/lib/filters";

/** Una fecha con sus tránsitos y darks. Réplica de `DateGroup` en `preview.ts`. */
export type DateGroupLite = {
  date: string;             // "20260725"
  transit: ImageRecord[];   // imágenes que pasan
  darks: ImageRecord[];     // darks de esa fecha
};

/** Subset mínimo de TransitHit que necesitamos para `groupContainsTransit`. */
export type TransitHitLike = {
  /** ISO 8601, e.g. "2026-08-02T08:16:00.000Z". Se parsea con `Date.parse`. */
  midtimeIso: string;
};

/** { path, file } usado por handleDownload y handleDriveUpload. */
export type DriveFile = { path: string; file: string };

/**
 * Construye la lista de archivos a descargar/subir a partir del preview,
 * replicando exactamente la estructura de carpetas que usa el ZIP:
 *   <date>/<fits>           para tránsitos
 *   <date>/darks/<fits>     para darks
 *
 * Si se pasa `selectedDates`, solo se incluyen los grupos cuya fecha
 * esté en el Set. Si no se pasa (o es undefined), se incluyen todos
 * los grupos — útil para mantener compatibilidad cuando aún no hay UI
 * de selección (p.ej. una sola secuencia).
 */
export function buildAllFiles(
  groups: ReadonlyArray<DateGroupLite>,
  selectedDates?: ReadonlySet<string>,
): DriveFile[] {
  const all: DriveFile[] = [];
  for (const g of groups) {
    if (selectedDates && !selectedDates.has(g.date)) continue;
    for (const r of g.transit) {
      all.push({ path: `${g.date}/${r.fits}`, file: r.fits });
    }
    for (const r of g.darks) {
      all.push({ path: `${g.date}/darks/${r.fits}`, file: r.fits });
    }
  }
  return all;
}

/**
 * Determina si el midpoint predicho por NASA cae dentro de la ventana
 * temporal de un grupo de imágenes. Se usa para marcar con tick verde
 * la fila de la tabla que contiene el tránsito.
 *
 * Criterio: el midpoint (transit.midtimeIso) debe estar entre la
 * primera y la última imagen de tránsito del grupo, ambos lados
 * inclusive. Se compara por timestamp (ms) para evitar problemas de
 * timezone con el formato "20-Jul-2026 06:12:15" (UTC implícito).
 *
 * Devuelve false si no hay tránsito, si el grupo no tiene imágenes,
 * o si el grupo solo contiene darks (no es candidato a contener un
 * tránsito exoplanetario).
 */
export function groupContainsTransit(
  g: DateGroupLite,
  transit: TransitHitLike | null,
): boolean {
  if (!transit || g.transit.length === 0) return false;
  const midMs = Date.parse(transit.midtimeIso);
  if (Number.isNaN(midMs)) return false;
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const r of g.transit) {
    const t = parseDt(r.datetime).getTime();
    if (t < firstMs) firstMs = t;
    if (t > lastMs) lastMs = t;
  }
  return midMs >= firstMs && midMs <= lastMs;
}
