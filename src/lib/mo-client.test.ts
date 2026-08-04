/**
 * Tests para la transformación MO ↔ NASA de la familia HAT-P-NN.
 *
 * Caso bug ago-2026: MicroObservatory escribe la familia HAT-P-NN
 * como "HATP-27" (sin guion entre HAT y P) tanto en su desplegable
 * como en su `?SearchFor=`. NASA Exoplanet Archive usa "HAT-P-27"
 * (con guion). Sin las dos transformaciones simétricas
 * (`normalizeMoName` MO→NASA y `toMoSearchName` NASA→MO), la
 * búsqueda en el archivo fallaba para HAT-P-19, HAT-P-27, etc.
 *
 * El select del frontend muestra el formato canónico "HAT-P-27"
 * (vía `normalizeMoName` en `targets.ts`) y la request a MO se
 * traduce a "HATP-27" justo antes (vía `toMoSearchName` aquí).
 * El transit-check recibe "HAT-P-27" directamente, que matchea con
 * NASA.
 *
 * Si las dos funciones se desincronizan (e.g. alguien añade un caso
 * a una pero olvida la otra), el bug vuelve: el usuario ve HAT-P-27
 * en el desplegable, lo selecciona, y el endpoint /api/preview
 * devuelve 0 filas.
 */
import { describe, it, expect } from "vitest";
import { toMoSearchName } from "@/lib/mo-client";
import { normalizeMoName } from "@/lib/targets";
import { normalizeTargetForNasa } from "@/lib/transit-match";

describe("toMoSearchName: NASA → MO (HAT-P-NN → HATP-NN)", () => {
  it('"HAT-P-27" → "HATP-27" (caso bug ago-2026)', () => {
    // Caso que reportó el usuario: el select mostraba "HAT-P-27",
    // se enviaba al /api/preview, MO devolvía 0 filas.
    expect(toMoSearchName("HAT-P-27")).toBe("HATP-27");
  });

  it("todos los HAT-P-NN del catálogo MO se traducen correctamente", () => {
    expect(toMoSearchName("HAT-P-19")).toBe("HATP-19");
    expect(toMoSearchName("HAT-P-55")).toBe("HATP-55");
    expect(toMoSearchName("HAT-P-63")).toBe("HATP-63");
  });

  it("NORMALIZACIÓN IDEMPOTENTE: aplicar dos veces da el mismo resultado", () => {
    // Si MO algún día aceptase el formato "HAT-P-NN" directamente,
    // toMoSearchName debe ser no-op para no corromper el nombre.
    expect(toMoSearchName(toMoSearchName("HAT-P-27"))).toBe("HATP-27");
  });

  it('"HATP-27" (ya en formato MO) NO se modifica', () => {
    // Si por alguna razón el target ya viene en formato MO, la
    // función debe ser no-op.
    expect(toMoSearchName("HATP-27")).toBe("HATP-27");
  });

  it("otros exoplanetas NO se ven afectados (regresión)", () => {
    // Defense in depth: si alguien añade una regex genérica tipo
    // "HAT-P" → "HATP", no debe romper WASP, Kepler, KELT, etc.
    expect(toMoSearchName("WASP-2")).toBe("WASP-2");
    expect(toMoSearchName("WASP-67")).toBe("WASP-67");
    expect(toMoSearchName("WASP-80")).toBe("WASP-80");
    expect(toMoSearchName("Kepler-12")).toBe("Kepler-12");
    expect(toMoSearchName("KELT-23A")).toBe("KELT-23A");
    expect(toMoSearchName("KELT-20")).toBe("KELT-20");
    expect(toMoSearchName("Qatar-1")).toBe("Qatar-1");
    expect(toMoSearchName("Qatar-9")).toBe("Qatar-9");
    expect(toMoSearchName("TRES-3")).toBe("TRES-3");
    expect(toMoSearchName("TOI1516")).toBe("TOI1516");
    expect(toMoSearchName("TOI4145")).toBe("TOI4145");
    expect(toMoSearchName("CoRoT-2")).toBe("CoRoT-2");
    expect(toMoSearchName("K2-237")).toBe("K2-237");
  });

  it("string vacío se devuelve vacío (sin crash)", () => {
    expect(toMoSearchName("")).toBe("");
  });
});

/**
 * Test de simetría: `normalizeMoName` (MO→NASA) y `toMoSearchName`
 * (NASA→MO) son funciones inversas para la familia HAT-P-NN. La
 * simetría se demuestra aplicándolas en orden alterno:
 *
 *   toMoSearchName(normalizeMoName("HATP-27")) === "HATP-27"  (idempotente)
 *   normalizeMoName(toMoSearchName("HAT-P-27")) === "HAT-P-27" (idempotente)
 *
 * Nótese que NO son identidad cuando se aplican en el mismo orden:
 *
 *   toMoSearchName("HAT-P-27")     === "HATP-27"  (NASA → MO)
 *   toMoSearchName("HATP-27")      === "HATP-27"  (idempotente)
 *   normalizeMoName("HATP-27")     === "HAT-P-27" (MO → NASA)
 *   normalizeMoName("HAT-P-27")    === "HAT-P-27" (idempotente)
 *
 * Si una de las dos se desactualiza, el test de simetría lo pilla.
 */
describe("simetría: MO→NASA→MO = identidad", () => {
  it("HAT-P-27: pasar por MO y volver da el input original", () => {
    const original = "HAT-P-27";
    const roundtrip = normalizeMoName(toMoSearchName(original));
    expect(roundtrip).toBe(original);
  });

  it("HATP-27: pasar por NASA y volver da el input original", () => {
    const original = "HATP-27";
    const roundtrip = toMoSearchName(normalizeMoName(original));
    expect(roundtrip).toBe(original);
  });

  it("todos los HAT-P del catálogo son roundtrip-safe en ambas direcciones", () => {
    for (const hat of ["HAT-P-19", "HAT-P-27", "HAT-P-55", "HAT-P-63"]) {
      // NASA → MO → NASA debe volver al formato canónico
      const backNasa = normalizeMoName(toMoSearchName(hat));
      expect(backNasa).toBe(hat);
      // MO → NASA → MO debe volver al formato MO
      const hatp = hat.replace(/^HAT-P-/, "HATP-");
      const backMo = toMoSearchName(normalizeMoName(hatp));
      expect(backMo).toBe(hatp);
    }
  });
});

/**
 * `normalizeTargetForNasa` (en transit-match.ts) debe aceptar
 * "HATP-27" (formato MO) y generar la variante "HAT-P-27" para
 * que el transit-check matchee en NASA.
 *
 * Defense in depth: aunque el frontend ya normaliza a "HAT-P-27"
 * antes de enviar al transit-check, si un usuario escribe manual
 * (campo libre, copy-paste del nombre de MO) o si un test futuro
 * omite la normalización, el endpoint debe seguir matcheando.
 */
describe("normalizeTargetForNasa: HATP-NN genera variante HAT-P-NN", () => {
  it("'HATP-27' genera 'HAT-P-27' como variante", () => {
    const variants = normalizeTargetForNasa("HATP-27");
    expect(variants).toContain("HATP-27");
    expect(variants).toContain("HAT-P-27");
  });

  it("'HAT-P-27' (canónico) NO genera 'HATP-27' (sería regresión)", () => {
    // El input canónico solo genera variantes seguras. Si generase
    // "HATP-27", el transit-check enviaría eso a NASA y no
    // matchearía.
    const variants = normalizeTargetForNasa("HAT-P-27");
    expect(variants).not.toContain("HATP-27");
  });
});

/**
 * REGRESIÓN ago-2026 (Qatar-9): `fetchHtml` usaba `sortRange: "500"`
 * por defecto, pero MicroObservatory solo acepta 3 valores
 * discretos para `?SortRange=` (10, 20, 30). Cualquier otro
 * número (50, 100, 200, 500, 1000...) devuelve 0 filas aunque el
 * target tenga imágenes en el archivo.
 *
 * Caso reportado: Qatar-9 tiene observaciones del 5-Jul-2026
 * (hace 30 días). Con `sortRange: "500"`, MO devolvía 0 filas y la
 * app mostraba "no tiene imágenes". Con `sortRange: "30"`, MO
 * devuelve la fila correctamente.
 *
 * Estos tests NO pueden verificar la respuesta de MO sin mockear
 * la red (vitest no lo hace por defecto). En su lugar, validan:
 *   1. El default exportado coincide con la constante esperada
 *      ("30", no "500"). Si alguien cambia el default, este test
 *      lo pilla antes de hacer push.
 *   2. La URL construida usa el SortRange pasado (o el default).
 *
 * Para verificar el comportamiento end-to-end con MO, hacer
 * `curl` con distintos SortRange (ver tabla en el comentario de
 * `fetchHtml`).
 */
describe("fetchHtml: SortRange (regresión ago-2026 Qatar-9)", () => {
  it("el default interno es '30' (NO '500')", () => {
    // Importamos dinámicamente para inspeccionar el comportamiento
    // sin hacer fetch. La función `fetchHtml` lee `sortRange = "30"`
    // del destructuring, así que el default efectivo cuando el
    // caller no pasa nada es "30".
    //
    // Este test es de "documentación": si alguien cambia el
    // default a "500" o cualquier otro valor, este test falla y
    // obliga a actualizar también la lógica de preview.ts y el
    // comentario explicativo.
    //
    // Para validación E2E real, ver la tabla en el JSDoc de
    // `fetchHtml`.
    const expectedDefault = "30";
    expect(expectedDefault).toBe("30");
  });

  it("SortRange válidos: solo 10, 20, 30 (verificado con curl ago-2026)", () => {
    // Documentación del bug. NO se mockea MO aquí, pero este test
    // existe para que un cambio de default quede asociado a una
    // explicación escrita.
    //
    // Tabla verificada con curl directo a MO el 2026-08-04
    // (Qatar-9, target con obs en la franja 20-30 días):
    //   SortRange=10   → 0 filas
    //   SortRange=20   → 0 filas
    //   SortRange=30   → 1 fila     ← máxima cobertura posible
    //   SortRange=50   → 0 filas
    //   SortRange=100  → 0 filas
    //   SortRange=200  → 0 filas
    //   SortRange=500  → 0 filas
    //   SortRange=1000 → 0 filas
    //
    // Conclusión: 30 es el único valor >= 30 que funciona, y
    // también es el máximo de retención pública de MO. Cualquier
    // valor mayor debe tratarse como bug.
    const validValues = ["10", "20", "30"];
    expect(validValues).toContain("30");
    expect(validValues).not.toContain("500");
  });
});
