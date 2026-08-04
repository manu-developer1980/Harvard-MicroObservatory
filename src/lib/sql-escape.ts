/**
 * Escape de strings para uso seguro en queries ADQL / SQL.
 *
 * Esta función existe para centralizar el contrato de seguridad:
 *  - Escapa comillas simples (SQL string literal)
 *  - Escapa wildcards de LIKE (`%`, `_`)
 *  - Escapa el propio carácter de escape (`\`) PRIMERO
 *
 * El orden importa: el backslash se duplica ANTES de añadir los
 * prefijos `\%` y `\_`, para no acabar con `\\%` cuando el input
 * traía un `\` real.
 *
 * Devuelve un string listo para inyectar en una cláusula WHERE
 * con `ESCAPE '\\'` (convención PostgreSQL/SQL estándar; el
 * backend TAP de NASA está basado en PostgreSQL).
 *
 * USO:
 *   const safe = sqlEscapeLike(userInput);
 *   const q = `... WHERE col LIKE '${safe}%' ESCAPE '\\'`;
 *
 * @param s  String arbitrario (incluye input del usuario).
 * @returns  String escapado, seguro para ADQL.
 */
export function sqlEscapeLike(s: string): string {
  return s
    .replace(/\\/g, "\\\\")  // 1. backslash PRIMERO
    .replace(/'/g, "''")     // 2. comilla simple SQL
    .replace(/%/g, "\\%")    // 3. wildcard LIKE
    .replace(/_/g, "\\_");   // 4. wildcard LIKE
}
