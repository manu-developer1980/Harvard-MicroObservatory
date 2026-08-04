/**
 * Helpers de UI para la tabla de secuencias multi-noche.
 *
 * Separados del componente React para poder testearlos sin DOM
 * (vitest). Siguen el mismo patrón que `transit-match.ts` /
 * `filters.ts` — toda lógica de matching/parsing vive aquí, el
 * componente solo compone.
 */
import { parseDt, type ImageRecord } from "@/lib/filters";

/** Una sesión con sus imágenes de tránsito y darks. Réplica de `DateGroup` en
 *  `preview.ts`. El campo `folderName` es el nombre REAL de la carpeta dentro
 *  del ZIP / Google Drive (incluye sufijo `-N` cuando hay multi-secuencia
 *  el mismo día, p.ej. `20260729-2`). El campo `date` es la fecha UTC
 *  estable (YYYYMMDD) que la UI muestra. */
export type DateGroupLite = {
  date: string;             // "20260725" — fecha UTC (sin sufijo)
  folderName: string;       // "20260725" o "20260725-2" si hay multi-sesión
  sessionIndex: number;     // 1-based
  sessionCount: number;     // total de sesiones en este día
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
 *   <folderName>/<fits>           para tránsitos
 *   <folderName>/darks/<fits>     para darks
 *
 * El `folderName` se usa en lugar de `date` para que, cuando hay
 * multi-secuencia el mismo día, cada sesión acabe en su propia
 * carpeta (`20260729-1`, `20260729-2`) y no se mezclen al
 * descomprimir. Ver `preview.ts` para la lógica de asignación de
 * sufijos.
 *
 * Si se pasa `selectedFolderNames` (Set de folderNames), solo se
 * incluyen los grupos cuyo folderName esté en el Set. Si no se pasa
 * (o es undefined), se incluyen todos los grupos — útil para
 * mantener compatibilidad cuando aún no hay UI de selección.
 */
export function buildAllFiles(
  groups: ReadonlyArray<DateGroupLite>,
  selectedFolderNames?: ReadonlySet<string>,
): DriveFile[] {
  const all: DriveFile[] = [];
  for (const g of groups) {
    if (selectedFolderNames && !selectedFolderNames.has(g.folderName)) continue;
    for (const r of g.transit) {
      all.push({ path: `${g.folderName}/${r.fits}`, file: r.fits });
    }
    for (const r of g.darks) {
      all.push({ path: `${g.folderName}/darks/${r.fits}`, file: r.fits });
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

/**
 * Variante de `groupContainsTransit` que además devuelve el OFFSET en
 * minutos contra el borde más cercano del grupo:
 *   - `0` si el midpoint cae dentro (mismo criterio inclusivo que
 *     `groupContainsTransit`).
 *   - Positivo si el midpoint está ANTES del inicio del grupo (en
 *     minutos). Convención consistente con el resto del código:
 *     positivo = "te has quedado corto por X min", negativo =
 *     "te has pasado por X min".
 *   - Negativo si el midpoint está DESPUÉS del fin del grupo.
 *
 * Devuelve `null` si no se puede calcular (grupo sin imágenes de
 * tránsito, tránsito null, datetime inválido).
 *
 * Caso de uso clave (multi-sesión): el endpoint `/api/transit-check`
 * se llama con el rango global de TODAS las imágenes, por lo que su
 * `offsetMin` puede ser 0 (dentro del rango global) cuando en
 * realidad el tránsito está 16 min después del fin de la sesión 1 y
 * 3 días antes de la sesión 2. El frontend usa esta función para
 * recalcular el offset contra cada sesión y mostrar el más
 * relevante. Así, un tránsito asociado a la sesión 1 se reporta
 * correctamente como "16 min después de la sesión 1", no como
 * "dentro del rango global".
 */
export function transitOffsetVsGroup(
  g: DateGroupLite,
  transit: TransitHitLike | null,
): number | null {
  if (!transit || g.transit.length === 0) return null;
  const midMs = Date.parse(transit.midtimeIso);
  if (Number.isNaN(midMs)) return null;
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const r of g.transit) {
    const t = parseDt(r.datetime).getTime();
    if (t < firstMs) firstMs = t;
    if (t > lastMs) lastMs = t;
  }
  if (midMs < firstMs) return Math.round((firstMs - midMs) / 60000);
  if (midMs > lastMs) return -Math.round((midMs - lastMs) / 60000);
  return 0; // dentro
}
