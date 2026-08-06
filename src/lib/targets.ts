/**
 * Helpers para el endpoint /api/targets.
 *
 * Extraídos del endpoint para poder testearlos sin mockear el fetch
 * a MicroObservatory. El endpoint los importa desde aquí.
 *
 * Por qué son funciones puras testeables:
 *   - `isExoplanet` y `normalizeMoName` se aplican a los nombres
 *     parseados del HTML de MO. La fuente de datos (MO) es externa
 *     y no podemos controlarla, pero las reglas de filtrado y
 *     normalización son 100% nuestras y DEBEN tener tests de
 *     regresión.
 *   - Casos cubiertos: HAT-P-19 (MO: "HATP-19", NASA: "HAT-P-19"),
 *     KELT-23A (binario), TOI4145 (sin guion), TRES-3 (case
 *     insensitivity), etc.
 */

/**
 * Prefijos que identifican exoplanetas en el catálogo de
 * MicroObservatory.
 *
 * IMPORTANTE: añadir aquí un prefijo NO añade el target al
 * desplegable de MO. Solo le dice a nuestro parser que considere
 * exo a cualquier opción de MO cuyo nombre empiece por ese prefijo.
 * Si MO nunca ha tenido observaciones de un exoplaneta con ese
 * prefijo, simplemente no aparecerá en el desplegable y nuestro
 * filtro lo ignora. Es un cambio "free" (sin coste si MO no lo
 * tiene, y desbloquea el target si MO lo añade mañana).
 *
 * Caso HAT: MO escribe la familia HAT-P-NN como "HATP-NN" (sin
 * guion entre HAT y P). El prefijo "HAT" los captura; luego
 * `normalizeMoName` los reformatea a "HAT-P-NN" para que
 * coincidan con el formato canónico de NASA.
 */
export const EXO_PREFIXES: readonly string[] = [
  "CoRoT",
  "HAT", // HAT-P-1, HAT-P-11, HAT-P-19, etc. (formato MO: "HATP-NN")
  "K2-",
  "KELT",
  "Kepler",
  "Qatar",
  "TOI",
  "TRES",
  "WASP",
];

/**
 * Exoplanetas concretos que no encajan en los prefijos de arriba.
 * Por ahora ninguno, pero el hook queda para casos como "OGLE-TR-56"
 * o targets sin prefijo reconocible.
 */
export const EXO_EXACT: readonly string[] = [];

/**
 * Determina si un nombre del desplegable de MO es un exoplaneta
 * concreto. Match por prefijo (startsWith) o match exacto (lista
 * EXO_EXACT). El comodín de MO "All ExoPlanets" se excluye a
 * propósito: no es un target descargable.
 */
export function isExoplanet(name: string): boolean {
  if (name === "All ExoPlanets") return false;
  if (EXO_EXACT.includes(name)) return true;
  return EXO_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Normaliza el nombre de MicroObservatory al formato canónico de
 * NASA Exoplanet Archive.
 *
 * Caso estrella (ago-2026): MO escribe la familia HAT-P-NN como
 * "HATP-NN" (sin guion entre HAT y P), pero NASA usa "HAT-P-NN"
 * (con guion). Sin esta normalización:
 *   - El startsWith("HAT") SÍ captura "HATP-19" como exo.
 *   - Pero el value enviado al transit-check ("HATP-19") no
 *     matcheaba en la TAP query de NASA, que busca "HAT-P-19".
 *   - Resultado: el usuario veía HAT-P-19 en el desplegable,
 *     lo seleccionaba, y el transit-check decía "no encontrado"
 *     aunque la efeméride SÍ existe.
 *
 * Esta función se aplica a TODOS los nombres parseados (no solo
 * a los exos), porque es una transformación 1:1 segura. Si en el
 * futuro MO añade más targets con formato no canónico (e.g.
 * "TOI4145" ya lo manejamos en `normalizeTargetForNasa`, pero
 * "OGLETR56" sería un caso nuevo), basta con ampliar este switch.
 *
 * Mantenemos la lista de sustituciones EXPLÍCITA (vs. una regex
 * genérica tipo "HATP" → "HAT-P") para no romper:
 *   - WASP-NN  (NO debe transformarse: ya es el formato canónico)
 *   - Kepler-NN (idem)
 *   - KELT-NNA (idem, sistema binario)
 *   - TRES-NN   (idem)
 *   - Qatar-N   (idem)
 *
 * Si te encuentras añadiendo un caso "MATCHEA POR PREFIJO" en
 * lugar de por patrón estricto, considera si el prefijo entero
 * debe añadirse a `EXO_PREFIXES` directamente.
 */
export function normalizeMoName(name: string): string {
  // HATP-NN → HAT-P-NN (con guion). Bug ago-2026.
  if (/^HATP-\d/i.test(name)) {
    return name.replace(/^HATP-/, "HAT-P-");
  }
  return name;
}
