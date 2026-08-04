/**
 * Tests de `sqlEscapeLike`.
 *
 * El contrato de seguridad: dado un string arbitrario (incluyendo
 * input del usuario potencialmente hostil), el resultado debe ser
 * seguro de inyectar en una cláusula ADQL/SQL con `ESCAPE '\\'`.
 *
 * Casos cubiertos:
 *  - SQL injection básico via comilla simple (cierre de string).
 *  - Enumeración de la tabla `ps` via wildcards LIKE (`%`, `_`).
 *  - Backslashes (interacción con el carácter de escape).
 *  - Strings benignos (round-trip con `ESCAPE '\\'`).
 */
import { describe, it, expect } from "vitest";
import { sqlEscapeLike } from "@/lib/sql-escape";

describe("sqlEscapeLike", () => {
  it("escapa comilla simple duplicándola (estándar SQL)", () => {
    expect(sqlEscapeLike("O'Hara")).toBe("O''Hara");
  });

  it("escapa wildcard % para que no sea interpretado por LIKE", () => {
    // El % del usuario pasa a \% — con ESCAPE '\\' en la query,
    // LIKE ya no lo trata como "cualquier carácter".
    expect(sqlEscapeLike("WASP-1%")).toBe("WASP-1\\%");
  });

  it("escapa wildcard _ para que no sea interpretado por LIKE", () => {
    expect(sqlEscapeLike("WASP-1_")).toBe("WASP-1\\_");
  });

  it("escapa backslash duplicándolo (orden importa: primero \\)", () => {
    // Si escapamos los wildcards ANTES que el backslash, un input
    // con un solo `\` acabaría con `\\%` (incorrecto: el primer `\\`
    // es el escape del `\` y el `%` queda libre). Con el orden
    // correcto: `\\` se duplica primero -> `\\\\`, luego `%` se
    // escapa -> `\\\\%` (correcto: `\\` = un backslash literal,
    // `\%` = un % literal).
    expect(sqlEscapeLike("a\\b")).toBe("a\\\\b");
  });

  it("compone correctamente combinaciones de caracteres hostiles", () => {
    expect(sqlEscapeLike("O'Reilly_Wild%")).toBe("O''Reilly\\_Wild\\%");
  });

  it("devuelve string vacío sin tocar", () => {
    expect(sqlEscapeLike("")).toBe("");
  });

  it("no modifica caracteres benignos", () => {
    expect(sqlEscapeLike("WASP-135")).toBe("WASP-135");
    expect(sqlEscapeLike("TrES-3")).toBe("TrES-3");
    expect(sqlEscapeLike("KELT-9 b")).toBe("KELT-9 b");
  });

  it("round-trip con ESCAPE: el resultado en SQL solo matchea el input literal", () => {
    // Simulación: input "WASP-1%" debería, después de escape, NO
    // funcionar como wildcard en LIKE. Construimos la query igual
    // que en transit-check.ts y verificamos que el % está escapado.
    const userInput = "WASP-1%";
    const safe = sqlEscapeLike(userInput);
    const query = `LIKE '${safe}%' ESCAPE '\\'`;

    // El string contiene `\%` justo antes del `%` final del patrón.
    // Esto es lo que queremos: el primer % está escapado, el segundo
    // es el wildcard "cualquier cosa después".
    expect(query).toBe("LIKE 'WASP-1\\%%' ESCAPE '\\'");
  });
});
