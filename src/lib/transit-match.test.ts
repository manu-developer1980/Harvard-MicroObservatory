/**
 * Tests de regresión para `transit-match.ts`.
 *
 * Caso estrella: WASP-67 b del 2026-07-29. La secuencia observada fue
 * 08:10:10 → 10:30:15 UTC (2h 20min). El tránsito predicho por NASA
 * cae a las 20:09:36 UTC — 9h 39min DESPUÉS del fin de la ventana.
 *
 * Con el margen antiguo (0.5 días = 12h) el sistema marcaba este
 * tránsito como "found" porque la ventana expandida
 * (20:10 día anterior → 22:30 día siguiente) lo contenía. Ese fue el
 * bug.
 *
 * Con el margen correcto (0.01 días = 14.4 min):
 *   - `transitsInWindow` no debe devolver el tránsito (queda excluido).
 *   - `findNearest` debe devolverlo con `offsetMin ≈ -579` (~9h 39min
 *     después del fin).
 */
import { describe, it, expect } from "vitest";
import { utcIsoToJd } from "@/lib/jd";
import {
  transitsInWindow,
  findNearest,
  propagatedUncertainty,
  stripHtml,
  matchAllEphemerides,
  TRANSIT_MATCH_TOLERANCE_DAYS,
  type PlanetEph,
} from "@/lib/transit-match";

// Efeméride inventada pero consistente con WASP-67 b:
//   P = 4.61442 d, t0 = 2455230.5 (época arbitraria)
//   Calculamos n para que el tránsito n caiga a 2026-07-29 20:09:36
//   desde una t_0 cualquiera.
const wasp67b: PlanetEph = {
  pl_name: "WASP-67 b",
  hostname: "WASP-67",
  pl_orbper: 4.61442,
  pl_orbpererr1: 0,
  pl_tranmid: 2455230.5,
  pl_tranmiderr1: 0.0001,
  pl_tranmiderr2: -0.0001,
  pl_trandur: 0.18, // horas
  pl_refname: '<a href="x">Test 2024</a>',
};

// Ventana observada por el usuario: 29-Jul-2026 08:10:10 → 10:30:15 UTC
const startJd = utcIsoToJd("2026-07-29T08:10:10.000Z");
const endJd = utcIsoToJd("2026-07-29T10:30:15.000Z");

// Tránsito predicho: 2026-07-29 20:09:36 UTC (9h 39min después del fin)
const predictedJd = utcIsoToJd("2026-07-29T20:09:36.000Z");

describe("transit-match: WASP-67 b regression", () => {
  it("sanity: el tránsito predicho está 9h 39min después del fin", () => {
    const diffMin = (predictedJd - endJd) * 24 * 60;
    expect(diffMin).toBeGreaterThan(579);
    expect(diffMin).toBeLessThan(580);
  });

  it("REGRESIÓN: el tránsito NO debe aparecer en transitsInWindow (estaba antes con margen 0.5 días)", () => {
    // Construimos una efeméride sintética que predice EXACTAMENTE
    // a predictedJd en algún n. Para que t0 + n*P == predictedJd,
    // tomamos t0 = predictedJd, n = 0. Eso da un único tránsito
    // en todo el rango que cae fuera de la ventana.
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmid: predictedJd, // t_0 = momento del tránsito predicho
    };
    const hits = transitsInWindow(eph, startJd, endJd);
    expect(hits).toHaveLength(0);
  });

  it("findNearest SÍ debe devolver el tránsito, con offsetMin negativo (~-579)", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmid: predictedJd,
    };
    const nearest = findNearest(eph, startJd, endJd);
    expect(nearest).not.toBeNull();
    // offsetMin negativo = tránsito DESPUÉS del fin (terminaste antes)
    expect(nearest!.offsetMin).toBeLessThan(-500);
    expect(nearest!.offsetMin).toBeGreaterThan(-700);
  });

  it("el margen documentado es 0.01 días (14.4 min), no 0.5 (12h)", () => {
    // Si alguien sube este valor sin querer, este test lo pilla.
    expect(TRANSIT_MATCH_TOLERANCE_DAYS).toBe(0.01);
    expect(TRANSIT_MATCH_TOLERANCE_DAYS * 24 * 60).toBeCloseTo(14.4, 1);
  });
});

describe("transit-match: matching dentro de la ventana", () => {
  it("un tránsito exactamente al inicio de la ventana SÍ se incluye", () => {
    const eph: PlanetEph = { ...wasp67b, pl_tranmid: startJd };
    const hits = transitsInWindow(eph, startJd, endJd);
    expect(hits).toHaveLength(1);
    expect(hits[0].offsetMin).toBe(0);
  });

  it("un tránsito 10 min antes del inicio SÍ se incluye (dentro del margen)", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmid: startJd - 10 / (24 * 60),
    };
    const hits = transitsInWindow(eph, startJd, endJd);
    expect(hits).toHaveLength(1);
    // offsetMin positivo = tránsito ANTES del inicio (llegaste tarde)
    expect(hits[0].offsetMin).toBeGreaterThan(0);
  });

  it("un tránsito 30 min después del fin NO se incluye (fuera del margen)", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmid: endJd + 30 / (24 * 60),
    };
    const hits = transitsInWindow(eph, startJd, endJd);
    expect(hits).toHaveLength(0);
  });

  it("un tránsito 30 min después del fin SÍ aparece en findNearest", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmid: endJd + 30 / (24 * 60),
    };
    const nearest = findNearest(eph, startJd, endJd);
    expect(nearest).not.toBeNull();
    expect(nearest!.offsetMin).toBe(-30);
  });
});

describe("propagatedUncertainty", () => {
  it("con n=0, σ = σ_t0", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmiderr1: 0.001,
      pl_tranmiderr2: -0.001,
      pl_orbpererr1: 0,
    };
    expect(propagatedUncertainty(eph, 0)).toBeCloseTo(0.001, 6);
  });

  it("a n grande, el término del periodo domina", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_orbpererr1: 0.000001,
    };
    // n=1e6: 1e6 * 1e-6 = 1 día, vs σ_t0 = 1e-4 → domina el periodo
    const sigma = propagatedUncertainty(eph, 1_000_000);
    expect(sigma).toBeCloseTo(1.0, 3);
  });

  it("no falla con campos undefined/0", () => {
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmiderr1: 0,
      pl_tranmiderr2: 0,
      pl_orbpererr1: 0,
    };
    expect(propagatedUncertainty(eph, 100)).toBe(0);
  });
});

describe("stripHtml", () => {
  it("limpia tags y decodifica entidades", () => {
    expect(stripHtml('<a href="x">Ivshina &amp; Winn 2022</a>')).toBe(
      "Ivshina & Winn 2022",
    );
  });

  it("devuelve undefined para entradas vacías", () => {
    expect(stripHtml("")).toBeUndefined();
    expect(stripHtml(undefined)).toBeUndefined();
    expect(stripHtml(null)).toBeUndefined();
    expect(stripHtml("   ")).toBeUndefined();
  });

  it("preserva texto sin tags", () => {
    expect(stripHtml("Simple text")).toBe("Simple text");
  });
});

/**
 * Bug histórico (WASP-67 b 2026-07-29): el código seleccionaba UNA
 * efeméride "más precisa" por planeta y la usaba sola. Para WASP-67 b
 * eso apuntaba a Mancini 2014, que predecía el tránsito a 20:09:36
 * UTC (9h 39min después del fin de la ventana), y reportaba
 * "✗ ningún tránsito encontrado" cuando las 6 efemérides de NASA
 * TransitView predecían 10:03–10:22 UTC (dentro de la ventana).
 *
 * El fix: usar TODAS las efemérides y preguntar "¿alguna predice un
 * tránsito dentro de la ventana?".
 */
describe("matchAllEphemerides: WASP-67 b multi-ephemeris regression", () => {
  // 6 efemérides simuladas, todas prediciendo ~10:16 UTC (la "correcta")
  // más una que predice 20:09:36 UTC (la "errónea" que se elegía antes).
  // En la realidad las 6 convergen en 10:03–10:22; aquí las sintetizo
  // para el test usando pl_tranmid = midtime objetivo en JD.
  const tenSixteen = utcIsoToJd("2026-07-29T10:16:00.000Z");
  const twentyOhNine = utcIsoToJd("2026-07-29T20:09:36.000Z");
  const start = utcIsoToJd("2026-07-29T08:10:10.000Z");
  const end = utcIsoToJd("2026-07-29T10:30:15.000Z");

  const ephemerides: PlanetEph[] = [
    {
      pl_name: "WASP-67 b",
      hostname: "WASP-67",
      pl_orbper: 4.61442,
      pl_orbpererr1: 0.0000001,
      pl_tranmid: tenSixteen,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_trandur: 0.18,
      pl_refname: "Paper A 2020",
    },
    {
      pl_name: "WASP-67 b",
      hostname: "WASP-67",
      pl_orbper: 4.61443,
      pl_orbpererr1: 0.0000001,
      pl_tranmid: tenSixteen,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_trandur: 0.18,
      pl_refname: "Paper B 2021",
    },
    {
      pl_name: "WASP-67 b",
      hostname: "WASP-67",
      pl_orbper: 4.61441,
      pl_orbpererr1: 0.0000001,
      pl_tranmid: tenSixteen,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_trandur: 0.18,
      pl_refname: "Paper C 2022",
    },
    {
      pl_name: "WASP-67 b",
      hostname: "WASP-67",
      pl_orbper: 4.61442,
      pl_orbpererr1: 0.0000001,
      pl_tranmid: tenSixteen,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_trandur: 0.18,
      pl_refname: "Paper D 2023",
    },
    {
      pl_name: "WASP-67 b",
      hostname: "WASP-67",
      pl_orbper: 4.61442,
      pl_orbpererr1: 0.0000001,
      pl_tranmid: tenSixteen,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_trandur: 0.18,
      pl_refname: "Paper E 2024",
    },
    // La "Mancini 2014" que apuntaba a 20:09:36 (12h después de la
    // correcta) y que el código anterior seleccionaba por error.
    {
      pl_name: "WASP-67 b",
      hostname: "WASP-67",
      pl_orbper: 4.61442,
      pl_orbpererr1: 0.0000001,
      pl_tranmid: twentyOhNine,
      pl_tranmiderr1: 0.0001,
      pl_tranmiderr2: -0.0001,
      pl_trandur: 0.18,
      pl_refname: "Mancini et al. 2014",
    },
  ];

  it("REGRESIÓN: con 5 efemérides correctas + 1 errónea, el match debe ser 'found'", () => {
    // Con la lógica antigua (selección de 1 efeméride), el sistema
    // habría cogido la "Mancini 2014" y reportado "✗ no encontrado".
    const result = matchAllEphemerides(ephemerides, start, end);
    expect(result.transits.length).toBeGreaterThan(0);
    // Las 5 primeras predecen 10:16 UTC (en ventana)
    expect(result.transits.length).toBe(5);
  });

  it("el 'nearest' debe ser el tránsito a 10:16 (en ventana, offset 0), no el de 20:09:36", () => {
    const result = matchAllEphemerides(ephemerides, start, end);
    expect(result.nearest).not.toBeNull();
    // offsetMin = 0 porque el tránsito está dentro de la ventana
    expect(result.nearest!.offsetMin).toBe(0);
    // Y NO debe ser el de Mancini
    expect(result.nearest!.reference).not.toBe("Mancini et al. 2014");
  });

  it("matchedPlanets contiene el planeta único (deduplicado)", () => {
    const result = matchAllEphemerides(ephemerides, start, end);
    expect(result.matchedPlanets).toEqual(["WASP-67 b"]);
  });

  it("references incluye TODOS los papers (no solo la 'mejor')", () => {
    const result = matchAllEphemerides(ephemerides, start, end);
    expect(result.references).toContain("Paper A 2020");
    expect(result.references).toContain("Mancini et al. 2014");
    expect(result.references.length).toBe(6);
  });
});