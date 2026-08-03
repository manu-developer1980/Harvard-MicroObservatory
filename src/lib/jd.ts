/**
 * Conversiones entre ISO 8601 UTC y Julian Date (JD).
 *
 * El NASA Exoplanet Archive trabaja con BJD_TDB (Barycentric Julian Date in
 * Barycentric Dynamical Time), que difiere de UTC en menos de ~8 min (el
 * light-time correction del movimiento de la Tierra). Para nuestro caso
 * (matching contra ventanas de varias horas), la diferencia es despreciable
 * y usamos JD ≈ BJD.
 *
 *   JD(UTC) = 2440587.5 + unixSeconds / 86400
 *
 * El 2440587.5 es el JD del Unix epoch (1970-01-01T00:00:00Z).
 */

const UNIX_EPOCH_JD = 2440587.5;

/** "2026-08-02T21:00:00Z" -> 2461256.375 */
export function utcIsoToJd(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return UNIX_EPOCH_JD + ms / 1000 / 86400;
}

/** 2461256.375 -> "2026-08-02T21:00:00.000Z" */
export function jdToUtcIso(jd: number): string {
  const ms = (jd - UNIX_EPOCH_JD) * 86400 * 1000;
  return new Date(ms).toISOString();
}

/** "2026-08-02T21:00:00.000Z" -> "2026-08-02 21:00:00" (formato MO) */
export function isoToMoFormat(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
}
