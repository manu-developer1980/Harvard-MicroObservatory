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
  matchMostPreciseEphemeris,
  pickMostPreciseEphemeris,
  normalizeTargetForNasa,
  buildPsTapQuery,
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
    // 0 ≠ null → la incertidumbre SE PUEDE calcular (es 0, predicción
    // "perfecta" en este caso artificial). Antes del fix, los 0 se
    // confundían con null y se devolvía Infinity; ahora solo null/
    // undefined devuelven Infinity, 0 da 0.
    expect(propagatedUncertainty(eph, 100)).toBe(0);
  });

  it("FIX: con campos null, devuelve Infinity (no 0)", () => {
    // Caso real NASA: Stassun 2017 / Mancini 2014 para WASP-67 b
    // tienen pl_tranmiderr1, pl_tranmiderr2, pl_orbpererr1 como
    // null. Una incertidumbre desconocida NO es 0 (eso sería
    // "predicción perfecta") ni NaN, sino "infinita" = no usable
    // para elegir la "most precise".
    const eph: PlanetEph = {
      ...wasp67b,
      pl_tranmiderr1: null,
      pl_tranmiderr2: null,
      pl_orbpererr1: null,
    };
    expect(propagatedUncertainty(eph, 1000)).toBe(Infinity);
  });

  it("FIX: con UN solo campo null, ya devuelve Infinity (defense in depth)", () => {
    const e1: PlanetEph = { ...wasp67b, pl_orbpererr1: null };
    expect(propagatedUncertainty(e1, 1000)).toBe(Infinity);
    const e2: PlanetEph = { ...wasp67b, pl_tranmiderr1: null };
    expect(propagatedUncertainty(e2, 1000)).toBe(Infinity);
    const e3: PlanetEph = { ...wasp67b, pl_tranmiderr2: null };
    expect(propagatedUncertainty(e3, 1000)).toBe(Infinity);
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

/**
 * Cambio de UX: la web de NASA TransitView muestra UNA sola efeméride
 * (la "most precise"). Replicamos ese comportamiento con
 * `pickMostPreciseEphemeris` + `matchMostPreciseEphemeris`.
 *
 * Caso CoRoT-2 b: NASA escoge "Sodickson & Grunblatt 2025" (rojo en
 * TransitView). Esa predicción es la que queremos devolver.
 *
 * Caso WASP-67 b: 6 efemérides distintas. Con `matchAll` usábamos
 * todas y marcaba "found" si alguna caía en ventana. Con
 * `matchMostPrecise` usamos solo la "most precise" por σ(t_n) y
 * mostramos UNA predicción. Si NASA y nuestra σ(t_n) coinciden en
 * la elección, el resultado es el mismo (en este test, lo
 * garantizamos haciendo que la "most precise" sea claramente la de
 * menor σ_t0).
 */
describe("pickMostPreciseEphemeris", () => {
  it("devuelve la única efeméride si hay solo una", () => {
    const eph: PlanetEph = { ...wasp67b };
    expect(pickMostPreciseEphemeris([eph], 2460000)).toBe(eph);
  });

  it("escoge la de menor σ(t_0) cuando n=0 (fecha cercana a t_0)", () => {
    // A n=0, σ(t_n) = σ_t0 directamente.
    const e1: PlanetEph = { ...wasp67b, pl_refname: "High precision", pl_tranmiderr1: 0.0001, pl_tranmiderr2: -0.0001, pl_orbpererr1: 0 };
    const e2: PlanetEph = { ...wasp67b, pl_refname: "Low precision", pl_tranmiderr1: 0.01, pl_tranmiderr2: -0.01, pl_orbpererr1: 0 };
    // queryJd = t_0 → n=0 para todas (wasp67b.pl_tranmid es no-null en el fixture)
    const picked = pickMostPreciseEphemeris([e1, e2], wasp67b.pl_tranmid as number);
    expect(picked.pl_refname).toBe("High precision");
  });

  it("ignora efemérides con pl_orbper <= 0 (inválidas)", () => {
    const valid: PlanetEph = { ...wasp67b, pl_refname: "valid" };
    const invalid: PlanetEph = { ...wasp67b, pl_orbper: 0, pl_refname: "invalid" };
    const picked = pickMostPreciseEphemeris([invalid, valid], 2460000);
    expect(picked.pl_refname).toBe("valid");
  });

  it("en empate, devuelve la primera del array (orden estable)", () => {
    const a: PlanetEph = { ...wasp67b, pl_refname: "A" };
    const b: PlanetEph = { ...wasp67b, pl_refname: "B" };
    // Mismas σ → empate
    const picked = pickMostPreciseEphemeris([a, b], 2460000);
    expect(picked.pl_refname).toBe("A");
  });

  it("CASO CoRoT-2 b: la 'most precise' es la de menor σ(t_n) en queryJd", () => {
    // Simulamos 3 efemérides tipo CoRoT-2 b. La "Sodickson 2025" es
    // la más reciente y la de menor σ_t0. Las otras 2 son más antiguas
    // y/o con más incertidumbre.
    const sodickson: PlanetEph = {
      ...wasp67b,
      pl_refname: "Sodickson & Grunblatt 2025",
      pl_tranmiderr1: 0.00008,
      pl_tranmiderr2: -0.00008,
      pl_orbpererr1: 0.0000001,
    };
    const gillon: PlanetEph = {
      ...wasp67b,
      pl_refname: "Gillon et al. 2010",
      pl_tranmiderr1: 0.0005,
      pl_tranmiderr2: -0.0005,
      pl_orbpererr1: 0.000001,
    };
    const baluev: PlanetEph = {
      ...wasp67b,
      pl_refname: "Baluev et al. 2015",
      pl_tranmiderr1: 0.0003,
      pl_tranmiderr2: -0.0003,
      pl_orbpererr1: 0.0000005,
    };
    const query = utcIsoToJd("2026-08-02T08:16:00.000Z"); // CoRoT-2 b
    const picked = pickMostPreciseEphemeris(
      [gillon, baluev, sodickson],
      query,
    );
    expect(picked.pl_refname).toBe("Sodickson & Grunblatt 2025");
  });
});

describe("matchMostPreciseEphemeris", () => {
  it("found=true cuando la predicción cae dentro de la ventana", () => {
    const inWin = utcIsoToJd("2026-07-29T10:16:00.000Z");
    const start = utcIsoToJd("2026-07-29T08:10:10.000Z");
    const end = utcIsoToJd("2026-07-29T10:30:15.000Z");
    const eph: PlanetEph = { ...wasp67b, pl_tranmid: inWin };
    const r = matchMostPreciseEphemeris([eph], start, end);
    expect(r.found).toBe(true);
    expect(r.transit.offsetMin).toBe(0);
  });

  it("found=false + offsetMin≠0 cuando la predicción cae fuera", () => {
    const outOfWin = utcIsoToJd("2026-07-29T20:09:36.000Z");
    const start = utcIsoToJd("2026-07-29T08:10:10.000Z");
    const end = utcIsoToJd("2026-07-29T10:30:15.000Z");
    const eph: PlanetEph = { ...wasp67b, pl_tranmid: outOfWin };
    const r = matchMostPreciseEphemeris([eph], start, end);
    expect(r.found).toBe(false);
    expect(r.transit.offsetMin).toBeLessThan(-500); // ~9h 39min
  });

  it("CASO CoRoT-2 b: con 13 referencias, devuelve la 'Sodickson 2025' como fuente", () => {
    // Simulamos que la "Sodickson 2025" predice el tránsito dentro de
    // la ventana 08:00–08:30 UTC del 2026-08-02.
    const corot2 = utcIsoToJd("2026-08-02T08:16:00.000Z");
    const start = utcIsoToJd("2026-08-02T08:00:00.000Z");
    const end = utcIsoToJd("2026-08-02T08:30:00.000Z");

    // Generamos 13 efemérides con σ crecientes; la "Sodickson" es la
    // de menor σ_t0 (sería la "most precise" por nuestro algoritmo).
    const ephs: PlanetEph[] = [
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Sodickson & Grunblatt 2025", pl_tranmiderr1: 0.00008, pl_tranmiderr2: -0.00008, pl_orbpererr1: 0.0000001 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Gillon et al. 2010", pl_tranmiderr1: 0.0005, pl_tranmiderr2: -0.0005, pl_orbpererr1: 0.000001 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Alonso et al. 2008", pl_tranmiderr1: 0.001, pl_tranmiderr2: -0.001, pl_orbpererr1: 0.000002 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Baluev et al. 2015", pl_tranmiderr1: 0.0003, pl_tranmiderr2: -0.0003, pl_orbpererr1: 0.0000005 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Bonomo et al. 2017", pl_tranmiderr1: 0.0002, pl_tranmiderr2: -0.0002, pl_orbpererr1: 0.0000003 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Bruno et al. 2016", pl_tranmiderr1: 0.0004, pl_tranmiderr2: -0.0004, pl_orbpererr1: 0.0000008 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "ExoFOP", pl_tranmiderr1: 0.0001, pl_tranmiderr2: -0.0001, pl_orbpererr1: 0.0000002 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Ivshina & Winn 2022", pl_tranmiderr1: 0.00025, pl_tranmiderr2: -0.00025, pl_orbpererr1: 0.00000034 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Kokori et al. 2022", pl_tranmiderr1: 0.00019, pl_tranmiderr2: -0.00019, pl_orbpererr1: 0.00000039 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Kokori et al. 2023", pl_tranmiderr1: 0.00018, pl_tranmiderr2: -0.00018, pl_orbpererr1: 0.00000035 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Southworth 2011", pl_tranmiderr1: 0.0008, pl_tranmiderr2: -0.0008, pl_orbpererr1: 0.0000015 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Southworth 2012", pl_tranmiderr1: 0.0009, pl_tranmiderr2: -0.0009, pl_orbpererr1: 0.0000018 },
      { ...wasp67b, pl_tranmid: corot2, pl_refname: "Öztürk & Erdem 2019", pl_tranmiderr1: 0.0006, pl_tranmiderr2: -0.0006, pl_orbpererr1: 0.0000012 },
    ];

    const r = matchMostPreciseEphemeris(ephs, start, end);
    expect(r.found).toBe(true);
    expect(r.picked.pl_refname).toBe("Sodickson & Grunblatt 2025");
    // La predicción es 08:16:xx UTC (la que pusimos como pl_tranmid).
    // Permitimos ±1s por redondeo JD→ISO.
    expect(r.transit.midtimeUtc).toMatch(/2026-08-02 08:1[56]/);
  });

  it("REGRESIÓN WASP-67 b: con la 'most precise' cayendo en ventana, found=true", () => {
    // 5 efemérides que predicen 10:16 (en ventana) + 1 'Mancini 2014'
    // con σ mayor (sería descartada por nuestro algoritmo). El resultado
    // debe ser la 'most precise' (la de menor σ_t0) y found=true.
    const tenSixteen = utcIsoToJd("2026-07-29T10:16:00.000Z");
    const twentyOhNine = utcIsoToJd("2026-07-29T20:09:36.000Z");
    const start = utcIsoToJd("2026-07-29T08:10:10.000Z");
    const end = utcIsoToJd("2026-07-29T10:30:15.000Z");

    const ephs: PlanetEph[] = [
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Sodickson 2025", pl_tranmiderr1: 0.00008, pl_tranmiderr2: -0.00008, pl_orbpererr1: 0.0000001 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Gillon 2010", pl_tranmiderr1: 0.0005, pl_tranmiderr2: -0.0005, pl_orbpererr1: 0.000001 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Alonso 2008", pl_tranmiderr1: 0.001, pl_tranmiderr2: -0.001, pl_orbpererr1: 0.000002 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Baluev 2015", pl_tranmiderr1: 0.0003, pl_tranmiderr2: -0.0003, pl_orbpererr1: 0.0000005 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Bonomo 2017", pl_tranmiderr1: 0.0002, pl_tranmiderr2: -0.0002, pl_orbpererr1: 0.0000003 },
      // "Mancini 2014" con σ MUY alta (sería descartada por el algoritmo)
      { ...wasp67b, pl_tranmid: twentyOhNine, pl_refname: "Mancini et al. 2014", pl_tranmiderr1: 0.01, pl_tranmiderr2: -0.01, pl_orbpererr1: 0.0001 },
    ];

    const r = matchMostPreciseEphemeris(ephs, start, end);
    expect(r.found).toBe(true);
    expect(r.picked.pl_refname).toBe("Sodickson 2025");
    expect(r.transit.midtimeUtc).toMatch(/2026-07-29 10:1[56]/);
  });

  it("REGRESIÓN WASP-67 b: si la 'most precise' discrepa y cae fuera, found=false", () => {
    // Este es el caso PELIGROSO: 5 efemérides predicen 10:16 (dentro),
    // pero la "most precise" por σ(t_n) termina siendo la "Mancini 2014"
    // que predice 20:09:36 (fuera). Con `matchAll` sería found=true;
    // con `matchMostPrecise` (y nuestra σ discrepando de NASA) sería
    // found=false. Lo documentamos para que se sepa el trade-off.
    const tenSixteen = utcIsoToJd("2026-07-29T10:16:00.000Z");
    const twentyOhNine = utcIsoToJd("2026-07-29T20:09:36.000Z");
    const start = utcIsoToJd("2026-07-29T08:10:10.000Z");
    const end = utcIsoToJd("2026-07-29T10:30:15.000Z");

    const ephs: PlanetEph[] = [
      // 5 efemérides correctas con σ MAYOR que la Mancini
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Sodickson 2025", pl_tranmiderr1: 0.001, pl_tranmiderr2: -0.001, pl_orbpererr1: 0.00001 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Gillon 2010", pl_tranmiderr1: 0.002, pl_tranmiderr2: -0.002, pl_orbpererr1: 0.00002 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Alonso 2008", pl_tranmiderr1: 0.003, pl_tranmiderr2: -0.003, pl_orbpererr1: 0.00003 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Baluev 2015", pl_tranmiderr1: 0.0015, pl_tranmiderr2: -0.0015, pl_orbpererr1: 0.000015 },
      { ...wasp67b, pl_tranmid: tenSixteen, pl_refname: "Bonomo 2017", pl_tranmiderr1: 0.0012, pl_tranmiderr2: -0.0012, pl_orbpererr1: 0.000012 },
      // "Mancini 2014" con σ ARTIFICIALMENTE BAJA para que nuestro
      // algoritmo la escoja. En realidad NO es la most precise de
      // NASA, pero simulamos que nuestra σ discrepa.
      { ...wasp67b, pl_tranmid: twentyOhNine, pl_refname: "Mancini et al. 2014", pl_tranmiderr1: 0.0001, pl_tranmiderr2: -0.0001, pl_orbpererr1: 0.0000001 },
    ];

    const r = matchMostPreciseEphemeris(ephs, start, end);
    expect(r.found).toBe(false);
    expect(r.picked.pl_refname).toBe("Mancini et al. 2014");
    // El "nearest" se queda con la predicción de Mancini (20:09:xx)
    expect(r.transit.midtimeUtc).toMatch(/2026-07-29 20:09/);
    // Y reporta el offset (positivo = antes del inicio, negativo = después)
    expect(r.transit.offsetMin).toBeLessThan(-500);
  });
});

/**
 * REGRESIÓN WASP-67 b con ephemerides REALES de NASA (ago-2026).
 *
 * El usuario reportó que la predicción salía a 20:09:36 UTC cuando
 * NASA TransitView muestra 10:16. Causa raíz: dos de las 8
 * efemérides de la `ps` table (Stassun 2017 y Mancini 2014) tienen
 * `pl_tranmid = null` y/o `pl_orbpererr1 = null`. El código antiguo
 * trataba null como 0 en `propagatedUncertainty`, dando σ = 0 para
 * esas dos → se elegían como "most precise" con σ=0 y el matching
 * daba un resultado fuera de la ventana.
 *
 * Tras el fix (ago-2026), `propagatedUncertainty` devuelve Infinity
 * para nulls, y `pickMostPreciseEphemeris` filtra las inválidas. La
 * "most precise" real es Kokori 2022 con σ ≈ 4.1e-4 d, que predice
 * el tránsito a 10:16:16 UTC — DENTRO de la ventana del usuario
 * (08:10:10 → 10:30:15).
 *
 * Datos verificados contra la TAP query a la tabla `ps` de NASA
 * Exoplanet Archive el 2026-08-04.
 */
describe("WASP-67 b REAL ephemerides (NASA ps table, ago-2026)", () => {
  // Ventana observada por el usuario el 2026-07-29
  const start = utcIsoToJd("2026-07-29T08:10:10.000Z");
  const end = utcIsoToJd("2026-07-29T10:30:15.000Z");

  // 8 ephemerides tal cual las devuelve NASA. Los null son reales.
  const ephs: PlanetEph[] = [
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.6144109, pl_orbpererr1: 0.0000027,
      pl_tranmid: 2455824.374962, pl_tranmiderr1: 0.00022, pl_tranmiderr2: -0.00022,
      pl_trandur: null, pl_refname: "Bonomo et al. 2017",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.61441644, pl_orbpererr1: 6.9e-7,
      pl_tranmid: 2456650.35461, pl_tranmiderr1: 0.00013, pl_tranmiderr2: -0.00013,
      pl_trandur: null, pl_refname: "Kokori et al. 2023",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.6144166, pl_orbpererr1: 4e-7,
      pl_tranmid: 2456618.0537, pl_tranmiderr1: 0.00008, pl_tranmiderr2: -0.00008,
      pl_trandur: null, pl_refname: "Kokori et al. 2022",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.61444783554, pl_orbpererr1: 0.00023895898,
      pl_tranmid: 2460803.328685, pl_tranmiderr1: 0.00078733, pl_tranmiderr2: -0.00078733,
      pl_trandur: 1.8613266, pl_refname: "ExoFOP",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.61442, pl_orbpererr1: 0.00001,
      pl_tranmid: null, pl_tranmiderr1: null, pl_tranmiderr2: null, // <-- Stassun 2017: t_0 null
      pl_trandur: null, pl_refname: "Stassun et al. 2017",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.61, pl_orbpererr1: null,                              // <-- Mancini 2014: t_0 y σ_P null
      pl_tranmid: null, pl_tranmiderr1: null, pl_tranmiderr2: null,
      pl_trandur: null, pl_refname: "Mancini et al. 2014",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.6144086, pl_orbpererr1: 0.0000041,
      pl_tranmid: 2456082.78126, pl_tranmiderr1: 0.00018, pl_tranmiderr2: -0.00018,
      pl_trandur: null, pl_refname: "Ivshina & Winn 2022",
    },
    {
      pl_name: "WASP-67 b", hostname: "WASP-67",
      pl_orbper: 4.61442, pl_orbpererr1: 0.00001,
      pl_tranmid: 2455824.3742, pl_tranmiderr1: 0.0002, pl_tranmiderr2: -0.0002,
      pl_trandur: 1.896, pl_refname: "Hellier et al. 2012",
    },
  ];

  it("REGRESIÓN: con los datos reales, found=true (tránsito DENTRO de la ventana)", () => {
    // ANTES del fix: el código seleccionaba Mancini 2014 (σ=0 por null
    // → 0) como "most precise" y devolvía un TransitHit en 20:09:36 UTC,
    // 579 min después del fin. found=false, mensaje de error en UI.
    //
    // DESPUÉS del fix: la picked es Kokori 2022 con σ ≈ 4.1e-4 d, que
    // predice 10:16:16 UTC — DENTRO de la ventana. found=true.
    const r = matchMostPreciseEphemeris(ephs, start, end);
    expect(r.found).toBe(true);
    expect(r.transit.offsetMin).toBe(0);
    // La predicción está cerca de 10:16:xx (Kokori 2022 da 10:16:16).
    expect(r.transit.midtimeUtc).toMatch(/2026-07-29 10:1[56]/);
  });

  it("REGRESIÓN: la picked NO es Mancini 2014 (debe ser una con t_0 y σ_P válidos)", () => {
    const r = matchMostPreciseEphemeris(ephs, start, end);
    expect(r.picked.pl_refname).not.toBe("Mancini et al. 2014");
    expect(r.picked.pl_refname).not.toBe("Stassun et al. 2017");
  });

  it("REGRESIÓN: la picked es Kokori 2022 (la de menor σ(t_n) en queryJd)", () => {
    // La "most precise" por σ(t_n) propagada al centro de la ventana
    // (~2026-07-29 09:20 UTC) es Kokori 2022: σ_t0=8e-5 d, σ_P=4e-7 d,
    // n=1004 → σ(t_n) ≈ √(6.4e-9 + (1004·4e-7)²) = 4.1e-4 d. Las
    // demás son σ_P mayores o σ_t0 mayores.
    const r = matchMostPreciseEphemeris(ephs, start, end);
    expect(r.picked.pl_refname).toBe("Kokori et al. 2022");
  });

  it("Stassun 2017 (t_0 null) no afecta al matching", () => {
    // Aunque tuviera σ_P válida, sin t_0 no puede predecir.
    // `transitsInWindow` debe devolver [] para ella.
    const stassun = ephs.find((e) => e.pl_refname === "Stassun et al. 2017")!;
    expect(transitsInWindow(stassun, start, end)).toEqual([]);
    // `findNearest` también debe devolver null.
    expect(findNearest(stassun, start, end)).toBeNull();
  });

  it("Mancini 2014 (t_0 y σ_P null) no afecta al matching", () => {
    const mancini = ephs.find((e) => e.pl_refname === "Mancini et al. 2014")!;
    expect(transitsInWindow(mancini, start, end)).toEqual([]);
    expect(findNearest(mancini, start, end)).toBeNull();
  });

  it("las 5 efemérides válidas predicen todas el tránsito en 10:03–10:22 (en ventana)", () => {
    // Verificación cruzada: usando `matchAll` (que no pre-selecciona),
    // todas las ephs válidas deben predecir el tránsito dentro de la
    // ventana. Esto demuestra que NASA está en lo cierto: HAY un
    // tránsito en la ventana del usuario.
    const r = matchAllEphemerides(ephs, start, end);
    expect(r.transits.length).toBeGreaterThanOrEqual(5);
    for (const t of r.transits) {
      expect(t.offsetMin).toBe(0); // todas dentro
      expect(t.midtimeUtc).toMatch(/2026-07-29 10:0[3-9]|2026-07-29 10:1[0-9]|2026-07-29 10:2[0-2]/);
    }
  });
});

describe("normalizeTargetForNasa: casos reales reportados", () => {
  it("KELT-23A (sin espacio) debe producir 'KELT-23 A' (con espacio, sistema binario en NASA)", () => {
    const variants = normalizeTargetForNasa("KELT-23A");
    expect(variants).toContain("KELT-23 A");
  });

  it("TOI1516 (sin guion) debe producir 'TOI-1516'", () => {
    const variants = normalizeTargetForNasa("TOI1516");
    expect(variants).toContain("TOI-1516");
  });

  it("TOI 4145 (con espacio) debe producir 'TOI-4145'", () => {
    const variants = normalizeTargetForNasa("TOI 4145");
    expect(variants).toContain("TOI-4145");
  });

  it("regresión: WASP-135 (input en formato NASA) NO debe añadir transformaciones", () => {
    const variants = normalizeTargetForNasa("WASP-135");
    // La primera variante debe ser el input literal
    expect(variants[0]).toBe("WASP-135");
    // No debe duplicar ni inventar transformaciones que cambien el input
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("regresión: WASP-135 b (con letra de planeta) se mantiene tal cual", () => {
    const variants = normalizeTargetForNasa("WASP-135 b");
    expect(variants).toContain("WASP-135 b");
  });

  it("WASP-135A (sin espacio) produce 'WASP-135 A'", () => {
    const variants = normalizeTargetForNasa("WASP-135A");
    expect(variants).toContain("WASP-135 A");
  });

  it("input vacío o whitespace devuelve []", () => {
    expect(normalizeTargetForNasa("")).toEqual([]);
    expect(normalizeTargetForNasa("   ")).toEqual([]);
  });

  it("input con espacios al borde se trimea", () => {
    const variants = normalizeTargetForNasa("  KELT-23A  ");
    expect(variants[0]).toBe("KELT-23A");
    expect(variants).toContain("KELT-23 A");
  });

  it("idempotencia: aplicar el normalizador a un nombre ya en formato NASA produce un set estable", () => {
    const once = normalizeTargetForNasa("WASP-135");
    const twice = normalizeTargetForNasa(once[0]);
    expect(twice).toEqual(once);
  });

  it("no produce duplicados", () => {
    const variants = normalizeTargetForNasa("KELT-23A");
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("incluye el input literal como primera variante (cero overhead si ya matchea)", () => {
    const variants = normalizeTargetForNasa("KELT-23A");
    expect(variants[0]).toBe("KELT-23A");
  });
});

/**
 * REGRESIÓN ago-2026: la TAP query a la tabla `ps` con
 * `LIKE LOWER('WASP-2%')` (wildcard suelto al final) capturaba
 * 102 filas de 9 planetas distintos (WASP-2, WASP-20, WASP-21,
 * WASP-22, ..., WASP-29), no solo WASP-2 b. El
 * `pickMostPreciseEphemeris` mezclaba esas efemérides y elegía una
 * con periodo arbitrario (e.g. WASP-25 b, P=3.76 d) que predecía
 * un tránsito a las 13:54 UTC en vez de las 7:24 reales de
 * WASP-2 b (P=2.15 d).
 *
 * El fix es cambiar el patrón de `${safe}%` a `${safe} %` (espacio
 * LITERAL antes del wildcard), para que solo matchee pl_name que
 * empiece por el input seguido de un espacio: "WASP-2 b", "WASP-2 c",
 * "WASP-2 A b" — pero NO "WASP-20 b", "WASP-21 b", etc.
 *
 * Estos tests verifican la QUERY GENERADA por `buildPsTapQuery`
 * (no la respuesta de NASA, que requeriría mockear la TAP fetch).
 * El bug se reproduciría en cuanto alguien quitase el espacio del
 * LIKE — si ves uno de estos tests fallar, NO aceptes el cambio
 * sin entender por qué.
 */
describe("buildPsTapQuery: WASP-2 LIKE bug (regresión ago-2026)", () => {
  it("el LIKE usa ESPACIO LITERAL antes del wildcard (no wildcard suelto)", () => {
    const q = buildPsTapQuery("WASP-2");
    // El bug era: LIKE LOWER('WASP-2%')  (sin espacio)
    // El fix es:  LIKE LOWER('WASP-2 %') (con espacio)
    expect(q).toContain("LIKE LOWER('WASP-2 %')");
    expect(q).not.toContain("LIKE LOWER('WASP-2%')");
  });

  it("no aparece NINGÚN patrón LIKE con wildcard suelto al final", () => {
    // Defense in depth: revisar toda la query por el patrón
    // `<algo>%'` (comilla inmediatamente después de %).
    const q = buildPsTapQuery("WASP-2");
    // El % solo puede aparecer tras un espacio, un LOWER( o un \
    // (escape). Aquí nos aseguramos de que no haya `${algo}%'`
    // directo.
    expect(q).not.toMatch(/[A-Za-z0-9-]%'/);
  });

  it("combina hostname exacto + pl_name exacto + pl_name LIKE con espacio", () => {
    const q = buildPsTapQuery("WASP-2");
    expect(q).toContain("LOWER(hostname) = LOWER('WASP-2')");
    expect(q).toContain("LOWER(pl_name) = LOWER('WASP-2')");
    expect(q).toContain("LIKE LOWER('WASP-2 %')");
  });

  it("ESCAPE '\\\\' está presente para neutralizar wildcards del usuario", () => {
    const q = buildPsTapQuery("WASP-2");
    expect(q).toContain("ESCAPE '\\'");
  });

  it("escapa comillas y wildcards en el input del usuario", () => {
    // Si el usuario mete un apóstrofe o un %, debe escaparse.
    const q = buildPsTapQuery("WASP%2");
    // El % del usuario se escapa como \%, y el espacio+wildcard que
    // añadimos nosotros va DESPUÉS (sin escape porque es intencional).
    expect(q).toContain("LIKE LOWER('WASP\\%2 %')");
  });

  it("escapa comillas simples (defense contra SQL injection)", () => {
    const q = buildPsTapQuery("O'Brien");
    // Las comillas se duplican en SQL estándar.
    expect(q).toContain("'O''Brien'");
  });

  it("preserva guiones y dígitos (formato NASA estándar)", () => {
    const q = buildPsTapQuery("WASP-135");
    expect(q).toContain("LOWER('WASP-135')");
  });

  it("REGRESIÓN: la query para 'WASP-2' NO debe capturar WASP-20/21/25/etc", () => {
    // Verificación simbólica: el patrón LIKE termina en "WASP-2 %",
    // que en LIKE significa "WASP-2" + espacio + cualquier cosa. Por
    // lo tanto "WASP-20 b" no matchea (el carácter tras "WASP-2" es
    // "0", no espacio). Si alguien quita el espacio del fix, este
    // test sigue pasando (no comprueba NASA, solo el shape de la
    // query), por lo que es principalmente documentación.
    const q = buildPsTapQuery("WASP-2");
    // El wildcard intencional va precedido de espacio
    const likeMatch = q.match(/LIKE LOWER\('([^']+)'\)/);
    expect(likeMatch).not.toBeNull();
    const pattern = likeMatch![1];
    expect(pattern).toBe("WASP-2 %");
  });
});