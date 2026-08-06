/**
 * Tests para el módulo de helpers del endpoint /api/targets.
 *
 * Cubre los casos reales que se han dado (y que pueden volver a
 * darse) con MicroObservatory + NASA:
 *
 *   - Bug ago-2026 HAT-P-NN: MO escribe "HATP-19" sin guion, NASA
 *     usa "HAT-P-19" con guion. Sin la normalización, el matching
 *     contra la tabla `ps` fallaba y el transit-check decía "no
 *     encontrado" para un target que SÍ estaba en el archivo.
 *
 *   - Bug ago-2026 SortRange=10: el HTML de MO por defecto solo
 *     mostraba targets con observaciones de los últimos 10 días.
 *     Al pedir `SortRange=30` (documentado en el endpoint), el
 *     desplegable pasa de 17 a 33 exoplanetas. Estos tests no
 *     validan el parámetro HTTP directamente (eso es un test E2E
 *     con `curl` que se hace a mano), pero SÍ validan que las
 *     funciones puras que filtran el resultado funcionan bien
 *     para targets que solo aparecen con SortRange=30 (HAT-P-19,
 *     KELT-20, Kepler-12, Qatar-9, etc.).
 */
import { describe, it, expect } from "vitest";
import {
  isExoplanet,
  normalizeMoName,
  EXO_PREFIXES,
  EXO_EXACT,
} from "@/lib/targets";

describe("isExoplanet: prefijos básicos del catálogo MO", () => {
  it('"All ExoPlanets" se excluye (no es un target descargable)', () => {
    expect(isExoplanet("All ExoPlanets")).toBe(false);
  });

  it("WASP-2, WASP-67, WASP-80 → exo (prefijo WASP)", () => {
    expect(isExoplanet("WASP-2")).toBe(true);
    expect(isExoplanet("WASP-67")).toBe(true);
    expect(isExoplanet("WASP-80")).toBe(true);
    expect(isExoplanet("WASP-135")).toBe(true);
  });

  it("TRES-1, TRES-3, TRES-5 → exo (prefijo TRES)", () => {
    expect(isExoplanet("TRES-1")).toBe(true);
    expect(isExoplanet("TRES-3")).toBe(true);
    expect(isExoplanet("TRES-5")).toBe(true);
  });

  it("CoRoT-2 → exo (prefijo CoRoT)", () => {
    expect(isExoplanet("CoRoT-2")).toBe(true);
  });

  it("KELT-23A, KELT-20 → exo (prefijo KELT, incluye binarios)", () => {
    expect(isExoplanet("KELT-23A")).toBe(true);
    expect(isExoplanet("KELT-20")).toBe(true);
  });

  it("Kepler-12 → exo (prefijo Kepler)", () => {
    expect(isExoplanet("Kepler-12")).toBe(true);
  });

  it("Qatar-1, Qatar-4, Qatar-9 → exo (prefijo Qatar)", () => {
    expect(isExoplanet("Qatar-1")).toBe(true);
    expect(isExoplanet("Qatar-4")).toBe(true);
    expect(isExoplanet("Qatar-9")).toBe(true);
  });

  it("K2-237 → exo (prefijo K2-)", () => {
    expect(isExoplanet("K2-237")).toBe(true);
  });

  it("TOI1516, TOI4145 → exo (prefijo TOI, sin guion en MO)", () => {
    expect(isExoplanet("TOI1516")).toBe(true);
    expect(isExoplanet("TOI4145")).toBe(true);
  });

  it("objetos NO exoplaneta NO se filtran", () => {
    expect(isExoplanet("Andromeda Galaxy M31")).toBe(false);
    expect(isExoplanet("Crab Nebula M1")).toBe(false);
    expect(isExoplanet("Saturn")).toBe(false);
    expect(isExoplanet("Mars")).toBe(false);
    expect(isExoplanet("Sun")).toBe(false);
    expect(isExoplanet("Moon")).toBe(false);
    expect(isExoplanet("Pleiades")).toBe(false);
  });

  it("Dark-* NO se filtra como exo (son dark frames, no planetas)", () => {
    expect(isExoplanet("Dark-B-")).toBe(false);
    expect(isExoplanet("Dark-C-")).toBe(false);
    expect(isExoplanet("Dark-E-")).toBe(false);
  });

  it("case-sensitive: 'Kepler' con K mayúscula matchea, 'kepler' no", () => {
    // Los prefijos en EXO_PREFIXES tienen la capitalización canónica.
    // Si MO cambiase la capitalización, habría que ajustar aquí.
    expect(isExoplanet("Kepler-12")).toBe(true);
    expect(isExoplanet("kepler-12")).toBe(false);
  });
});

describe("isExoplanet: prefijo HAT (caso ago-2026)", () => {
  it('"HATP-19" se reconoce como exo (prefijo HAT matchea "HATP-")', () => {
    // HATP-19 empieza por "HAT" (3 letras), así que startsWith("HAT") = true.
    // Esto permite que aparezca en el desplegable. Luego `normalizeMoName`
    // lo reformatea a "HAT-P-19" para que matchee con NASA.
    expect(isExoplanet("HATP-19")).toBe(true);
  });

  it("todos los HAT-P del catálogo MO se reconocen", () => {
    expect(isExoplanet("HATP-19")).toBe(true);
    expect(isExoplanet("HATP-27")).toBe(true);
    expect(isExoplanet("HATP-55")).toBe(true);
    expect(isExoplanet("HATP-63")).toBe(true);
  });

  it("'HAT' (prefijo solo, sin números) SÍ matchea por startsWith", () => {
    // Edge case: el prefijo "HAT" es tan genérico que el string
    // literal "HAT" también matchea. En la práctica MO no envía
    // "HAT" como option (siempre viene con sufijo numérico), así
    // que este caso es solo documental. Si en el futuro MO añadiese
    // "HAT" como target, tendríamos que refinar el filtro (e.g. con
    // una regex que requiera `\d` después del prefijo).
    expect(isExoplanet("HAT")).toBe(true);
  });
});

describe("normalizeMoName: HATP-NN → HAT-P-NN", () => {
  it('"HATP-19" → "HAT-P-19"', () => {
    expect(normalizeMoName("HATP-19")).toBe("HAT-P-19");
  });

  it("todos los HAT-P del catálogo MO se normalizan correctamente", () => {
    expect(normalizeMoName("HATP-27")).toBe("HAT-P-27");
    expect(normalizeMoName("HATP-55")).toBe("HAT-P-55");
    expect(normalizeMoName("HATP-63")).toBe("HAT-P-63");
  });

  it("NORMALIZACIÓN IDEMPOTENTE: aplicar dos veces da el mismo resultado", () => {
    // Si el usuario selecciona "HAT-P-19" y la normalización se vuelve
    // a aplicar, no debe corromper el nombre.
    expect(normalizeMoName(normalizeMoName("HATP-19"))).toBe("HAT-P-19");
  });

  it('"HAT-P-19" (ya en formato canónico) NO se modifica', () => {
    // Caso edge: si MO algún día envía "HAT-P-19" directamente
    // (sin la "HATP-" pegada), la función debe ser no-op.
    expect(normalizeMoName("HAT-P-19")).toBe("HAT-P-19");
  });

  it("otros exoplanetas NO se ven afectados (regresión)", () => {
    // Defense in depth: si alguien añade una regex genérica tipo
    // "HATP" → "HAT-P", no debe romper WASP, Kepler, KELT, etc.
    expect(normalizeMoName("WASP-2")).toBe("WASP-2");
    expect(normalizeMoName("WASP-67")).toBe("WASP-67");
    expect(normalizeMoName("Kepler-12")).toBe("Kepler-12");
    expect(normalizeMoName("KELT-23A")).toBe("KELT-23A");
    expect(normalizeMoName("KELT-20")).toBe("KELT-20");
    expect(normalizeMoName("Qatar-1")).toBe("Qatar-1");
    expect(normalizeMoName("Qatar-9")).toBe("Qatar-9");
    expect(normalizeMoName("TRES-3")).toBe("TRES-3");
    expect(normalizeMoName("TOI1516")).toBe("TOI1516");
    expect(normalizeMoName("TOI4145")).toBe("TOI4145");
    expect(normalizeMoName("CoRoT-2")).toBe("CoRoT-2");
    expect(normalizeMoName("K2-237")).toBe("K2-237");
  });

  it("objetos no-exo NO se ven afectados", () => {
    expect(normalizeMoName("Andromeda Galaxy M31")).toBe(
      "Andromeda Galaxy M31",
    );
    expect(normalizeMoName("Crab Nebula M1")).toBe("Crab Nebula M1");
    expect(normalizeMoName("All ExoPlanets")).toBe("All ExoPlanets");
  });

  it("string vacío se devuelve vacío (sin crash)", () => {
    expect(normalizeMoName("")).toBe("");
  });
});

describe("EXO_PREFIXES: integridad", () => {
  it("contiene los prefijos principales del catálogo MO", () => {
    // Si alguien borra un prefijo por error, este test lo pilla.
    // Añadir aquí un prefijo es seguro aunque MO no lo tenga: el
    // filtro no añade nada, solo excluye si empieza por el prefijo.
    for (const p of [
      "CoRoT",
      "HAT",
      "K2-",
      "KELT",
      "Kepler",
      "Qatar",
      "TOI",
      "TRES",
      "WASP",
    ]) {
      expect(EXO_PREFIXES).toContain(p);
    }
  });

  it("EXO_EXACT está vacío por ahora (es un hook para el futuro)", () => {
    // Si se añade algo, los tests de arriba lo cubrirán. Por ahora
    // no debe contener nada porque todo se maneja con prefijos.
    expect(EXO_EXACT).toEqual([]);
  });
});
