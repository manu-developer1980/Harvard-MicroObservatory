import { describe, it, expect } from "vitest";
import {
  buildAllFiles,
  groupContainsTransit,
  transitOffsetVsGroup,
  type DateGroupLite,
} from "@/lib/sequence-table";
import type { ImageRecord } from "@/lib/filters";

const rec = (short: string, datetime: string): ImageRecord => ({
  short,
  datetime,
  fits: `${short}.FITS`,
  weather: 95,
  filter: "V",
  telescope: "MicroObservatory",
  site: "HarvardCfA",
});

/**
 * Helper de tests: crea un DateGroupLite con los campos nuevos
 * (folderName, sessionIndex, sessionCount). Por defecto asume
 * sesión única (sessionCount=1, sessionIndex=1, folderName=date).
 * Para multi-secuencia, pasar { sessionIndex, sessionCount }.
 */
const mkGroup = (
  date: string,
  transit: ImageRecord[],
  darks: ImageRecord[] = [],
  opts: { sessionIndex?: number; sessionCount?: number } = {},
): DateGroupLite => {
  const sessionIndex = opts.sessionIndex ?? 1;
  const sessionCount = opts.sessionCount ?? 1;
  const folderName = sessionCount > 1 ? `${date}-${sessionIndex}` : date;
  return { date, folderName, sessionIndex, sessionCount, transit, darks };
};

describe("groupContainsTransit", () => {
  it("devuelve true cuando el midpoint cae dentro del rango de imágenes", () => {
    const grp = mkGroup(
      "20260802",
      [
        rec("a", "02-Aug-2026 06:00:00"),
        rec("b", "02-Aug-2026 08:00:00"),
        rec("c", "02-Aug-2026 09:00:00"),
      ],
    );
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(grp, transit)).toBe(true);
  });

  it("devuelve true en el BORDE inferior (firstMs == midMs)", () => {
    const grp = mkGroup(
      "20260802",
      [
        rec("a", "02-Aug-2026 08:16:00"),
        rec("b", "02-Aug-2026 09:00:00"),
      ],
    );
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(grp, transit)).toBe(true);
  });

  it("devuelve true en el BORDE superior (lastMs == midMs)", () => {
    const grp = mkGroup(
      "20260802",
      [
        rec("a", "02-Aug-2026 06:00:00"),
        rec("b", "02-Aug-2026 08:16:00"),
      ],
    );
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(grp, transit)).toBe(true);
  });

  it("devuelve false cuando el midpoint cae ANTES del grupo", () => {
    const grp = mkGroup(
      "20260802",
      [
        rec("a", "02-Aug-2026 09:00:00"),
        rec("b", "02-Aug-2026 10:00:00"),
      ],
    );
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(grp, transit)).toBe(false);
  });

  it("devuelve false cuando el midpoint cae DESPUÉS del grupo", () => {
    const grp = mkGroup(
      "20260802",
      [
        rec("a", "02-Aug-2026 06:00:00"),
        rec("b", "02-Aug-2022 07:00:00"),
      ],
    );
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(grp, transit)).toBe(false);
  });

  it("devuelve false si no hay tránsito", () => {
    const grp = mkGroup(
      "20260802",
      [rec("a", "02-Aug-2026 06:00:00")],
    );
    expect(groupContainsTransit(grp, null)).toBe(false);
  });

  it("devuelve false si el grupo no tiene imágenes de tránsito", () => {
    const grp = mkGroup(
      "20260802",
      [],
      [rec("dark", "02-Aug-2026 06:00:00")],
    );
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(grp, transit)).toBe(false);
  });

  it("devuelve false si midtimeIso no es parseable", () => {
    const grp = mkGroup(
      "20260802",
      [rec("a", "02-Aug-2026 06:00:00")],
    );
    expect(groupContainsTransit(grp, { midtimeIso: "not-a-date" })).toBe(
      false,
    );
  });

  it("ignora los registros del grupo que no están en transit[] (e.g. darks)", () => {
    // grupo con 1 transit y 1 dark, donde el dark está fuera del rango
    const grp = mkGroup(
      "20260802",
      [rec("a", "02-Aug-2026 08:00:00")],
      [rec("dark", "02-Aug-2026 03:00:00")],
    );
    const transit = { midtimeIso: "2026-08-02T08:00:00.000Z" };
    // El rango se calcula SOLO sobre transit[], no sobre darks.
    expect(groupContainsTransit(grp, transit)).toBe(true);
  });
});

describe("buildAllFiles", () => {
  const groups = [
    mkGroup(
      "20260802",
      [rec("t1", "02-Aug-2026 06:00:00")],
      [rec("d1", "02-Aug-2026 06:00:00")],
    ),
    mkGroup(
      "20260803",
      [rec("t2", "03-Aug-2026 06:00:00")],
    ),
  ];

  it("sin selectedFolderNames: incluye todos los grupos (backward compatible)", () => {
    const files = buildAllFiles(groups);
    expect(files).toEqual([
      { path: "20260802/t1.FITS", file: "t1.FITS" },
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
      { path: "20260803/t2.FITS", file: "t2.FITS" },
    ]);
  });

  it("con selectedFolderNames: solo los grupos marcados", () => {
    const files = buildAllFiles(groups, new Set(["20260802"]));
    expect(files).toEqual([
      { path: "20260802/t1.FITS", file: "t1.FITS" },
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
    ]);
  });

  it("con selectedFolderNames vacío: lista vacía", () => {
    expect(buildAllFiles(groups, new Set())).toEqual([]);
  });

  it("preserva la estructura de carpetas Target/YYYYMMDD/", () => {
    const files = buildAllFiles(groups);
    // tránsitos van en <date>/<fits>, darks en <date>/darks/<fits>
    expect(files.find((f) => f.file === "t1.FITS")?.path).toBe(
      "20260802/t1.FITS",
    );
    expect(files.find((f) => f.file === "d1.FITS")?.path).toBe(
      "20260802/darks/d1.FITS",
    );
  });

  it("con selectedFits: excluye tránsitos no marcados; darks siempre", () => {
    const files = buildAllFiles(
      groups,
      undefined,
      new Set(["t2.FITS"]),
    );
    expect(files).toEqual([
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
      { path: "20260803/t2.FITS", file: "t2.FITS" },
    ]);
  });

  it("con selectedFolderNames + selectedFits: ambas capas de filtro", () => {
    const files = buildAllFiles(
      groups,
      new Set(["20260802"]),
      new Set(["t1.FITS"]),
    );
    expect(files).toEqual([
      { path: "20260802/t1.FITS", file: "t1.FITS" },
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
    ]);
  });

  it("con selectedFits vacío: solo darks de carpetas incluidas", () => {
    const files = buildAllFiles(groups, new Set(["20260802"]), new Set());
    expect(files).toEqual([
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
    ]);
  });
});

/**
 * REGRESIÓN: multi-secuencia el mismo día debe generar carpetas
 * separadas con sufijo `-N` en el ZIP / Google Drive. Caso real
 * reportado por el usuario (ago-2026): 2 sesiones el 29-Jul-2026
 * (08:10-09:27 y 10:00-10:30 UTC, 38 imágenes + 11 imágenes) se
 * mezclaban en una sola carpeta `20260729/` y al descomprimir el
 * ZIP quedaban indistinguibles. Tras el fix, cada sesión va a su
 * carpeta: `20260729-1/` y `20260729-2/`.
 */
describe("buildAllFiles: multi-secuencia mismo día (sufijo -N)", () => {
  const groups = [
    mkGroup(
      "20260729",
      [rec("t1", "29-Jul-2026 08:10:10")],
      [rec("d1", "29-Jul-2026 08:00:00")],
      { sessionIndex: 1, sessionCount: 2 },
    ),
    mkGroup(
      "20260729",
      [rec("t2", "29-Jul-2026 10:00:16")],
      [],
      { sessionIndex: 2, sessionCount: 2 },
    ),
  ];

  it("cada sesión va a su propia carpeta con sufijo", () => {
    const files = buildAllFiles(groups);
    expect(files).toEqual([
      { path: "20260729-1/t1.FITS", file: "t1.FITS" },
      { path: "20260729-1/darks/d1.FITS", file: "d1.FITS" },
      { path: "20260729-2/t2.FITS", file: "t2.FITS" },
    ]);
  });

  it("con selectedFolderNames: filtra por folderName (con sufijo)", () => {
    const files = buildAllFiles(groups, new Set(["20260729-1"]));
    expect(files).toEqual([
      { path: "20260729-1/t1.FITS", file: "t1.FITS" },
      { path: "20260729-1/darks/d1.FITS", file: "d1.FITS" },
    ]);
  });

  it("con selectedFolderNames: ambos seleccionados = todo", () => {
    const files = buildAllFiles(
      groups,
      new Set(["20260729-1", "20260729-2"]),
    );
    expect(files.length).toBe(3);
  });

  it("sesiones de días distintos: cada una con su propio folderName sin sufijo", () => {
    // día 1 con 1 sesión, día 2 con 1 sesión → folderName === date
    const mixed = [
      mkGroup("20260801", [rec("a", "01-Aug-2026 08:00:00")]),
      mkGroup("20260802", [rec("b", "02-Aug-2026 08:00:00")]),
    ];
    const files = buildAllFiles(mixed);
    expect(files).toEqual([
      { path: "20260801/a.FITS", file: "a.FITS" },
      { path: "20260802/b.FITS", file: "b.FITS" },
    ]);
  });

  it("día 1 con 1 sesión + día 2 con 2 sesiones: solo el día 2 lleva sufijo", () => {
    // Caso mixto: el día con multi-secuencia lleva sufijo, el día con
    // sesión única NO (compatibilidad con herramientas externas).
    const mixed = [
      mkGroup("20260801", [rec("a", "01-Aug-2026 08:00:00")]),
      mkGroup(
        "20260802",
        [rec("b1", "02-Aug-2026 08:00:00")],
        [],
        { sessionIndex: 1, sessionCount: 2 },
      ),
      mkGroup(
        "20260802",
        [rec("b2", "02-Aug-2026 20:00:00")],
        [],
        { sessionIndex: 2, sessionCount: 2 },
      ),
    ];
    const files = buildAllFiles(mixed);
    expect(files).toEqual([
      { path: "20260801/a.FITS", file: "a.FITS" },
      { path: "20260802-1/b1.FITS", file: "b1.FITS" },
      { path: "20260802-2/b2.FITS", file: "b2.FITS" },
    ]);
  });
});

/**
 * `transitOffsetVsGroup` calcula el offset del midpoint contra el
 * borde más cercano de un grupo. La UI lo usa para decidir si el
 * tránsito está "found" (offset 0), "near-miss" (|offset| <= 120 min)
 * o "not found" (|offset| > 120 min), midiéndolo contra la SESIÓN
 * más relevante (no contra el rango global de todas las imágenes).
 */
describe("transitOffsetVsGroup", () => {
  it("devuelve 0 si el midpoint cae dentro del grupo", () => {
    const grp = mkGroup(
      "20260727",
      [rec("a", "27-Jul-2026 03:22:11"), rec("b", "27-Jul-2026 05:18:15")],
    );
    expect(
      transitOffsetVsGroup(grp, {
        midtimeIso: "2026-07-27T05:00:00.000Z",
      }),
    ).toBe(0);
  });

  it("devuelve 0 en el BORDE inferior (firstMs == midMs)", () => {
    const grp = mkGroup(
      "20260727",
      [rec("a", "27-Jul-2026 05:34:11"), rec("b", "27-Jul-2026 09:00:00")],
    );
    expect(
      transitOffsetVsGroup(grp, {
        midtimeIso: "2026-07-27T05:34:11.000Z",
      }),
    ).toBe(0);
  });

  it("devuelve NEGATIVO si el midpoint cae después del fin del grupo", () => {
    // Caso real reportado: tránsito a 05:34, sesión 1 termina a 05:18 → -16 min
    const grp = mkGroup(
      "20260727",
      [
        rec("a", "27-Jul-2026 03:22:11"),
        rec("b", "27-Jul-2026 05:18:15"),
      ],
    );
    const offset = transitOffsetVsGroup(grp, {
      midtimeIso: "2026-07-27T05:34:11.000Z",
    });
    expect(offset).not.toBeNull();
    expect(offset!).toBeLessThan(0);
    // 05:34:11 - 05:18:15 = 15:56 = 15.93 min, redondeado a 16
    expect(offset!).toBe(-16);
  });

  it("devuelve POSITIVO si el midpoint cae antes del inicio del grupo", () => {
    const grp = mkGroup(
      "20260730",
      [rec("a", "30-Jul-2026 05:30:21"), rec("b", "30-Jul-2026 09:06:15")],
    );
    // tránsito a 05:00 (30 min antes del inicio de la sesión 2)
    expect(
      transitOffsetVsGroup(grp, {
        midtimeIso: "2026-07-30T05:00:00.000Z",
      }),
    ).toBe(30);
  });

  it("devuelve null si el grupo no tiene imágenes de tránsito", () => {
    const grp = mkGroup(
      "20260727",
      [],
      [rec("d", "27-Jul-2026 06:00:00")],
    );
    expect(
      transitOffsetVsGroup(grp, { midtimeIso: "2026-07-27T05:34:00.000Z" }),
    ).toBeNull();
  });

  it("devuelve null si el tránsito es null", () => {
    const grp = mkGroup(
      "20260727",
      [rec("a", "27-Jul-2026 03:22:11")],
    );
    expect(transitOffsetVsGroup(grp, null)).toBeNull();
  });

  it("devuelve null si midtimeIso no es parseable", () => {
    const grp = mkGroup(
      "20260727",
      [rec("a", "27-Jul-2026 03:22:11")],
    );
    expect(transitOffsetVsGroup(grp, { midtimeIso: "not-a-date" })).toBeNull();
  });

  it("ignora los darks al calcular el rango del grupo", () => {
    // grupo con 1 transit (08:00) y 1 dark (03:00). Si el dark se
    // incluyera, el rango sería 03:00-08:00 y el tránsito a 05:30
    // estaría dentro. Sin el dark, el rango es 08:00-08:00 (un solo
    // punto) y el tránsito a 05:30 está 30 min antes.
    const grp = mkGroup(
      "20260802",
      [rec("a", "02-Aug-2026 08:00:00")],
      [rec("d", "02-Aug-2026 03:00:00")],
    );
    expect(
      transitOffsetVsGroup(grp, { midtimeIso: "2026-08-02T05:30:00.000Z" }),
    ).toBe(150);
  });
});

/**
 * REGRESIÓN (ago-2026): el usuario reportó inconsistencia en
 * multi-sesión de días DISTINTOS. Caso WASP-80 b con:
 *   Sesión 1: 27-Jul-2026 03:22 → 05:18 (1h 56min, 39 imágenes)
 *   Sesión 2: 30-Jul-2026 05:30 → 09:06 (3h 36min, 73 imágenes)
 *   Tránsito: 27-Jul-2026 05:34 (WASP-80 b según NASA)
 *
 * ANTES del fix: el endpoint /api/transit-check se llamaba con el
 * rango GLOBAL (03:22 del 27 → 09:06 del 30) y devolvía
 * `found: true, offsetMin: 0` porque el tránsito cae dentro del
 * rango global. Pero la sesión relevante (la 1) tiene el tránsito
 * 16 min después de su fin, así que decir "found" es engañoso.
 *
 * DESPUÉS del fix: el frontend recalcula el offset contra cada
 * sesión con `transitOffsetVsGroup` y reporta "nearMiss" con
 * offsetMin=-16 contra la Sesión 1. La Sesión 2 queda a -4317 min
 * (3 días) y no afecta al estado.
 */
describe("REGRESIÓN: WASP-80 b multi-sesión días distintos", () => {
  const sesion1 = mkGroup(
    "20260727",
    [rec("a", "27-Jul-2026 03:22:11"), rec("b", "27-Jul-2026 05:18:15")],
  );
  const sesion2 = mkGroup(
    "20260730",
    [rec("a", "30-Jul-2026 05:30:21"), rec("b", "30-Jul-2026 09:06:15")],
  );
  const transit = { midtimeIso: "2026-07-27T05:34:11.000Z" };

  it("Sesión 1: offset -16 (16 min después del fin)", () => {
    expect(transitOffsetVsGroup(sesion1, transit)).toBe(-16);
  });

  it("Sesión 2: offset muy negativo (3 días antes de su inicio)", () => {
    // 30-Jul-2026 05:30:21 - 27-Jul-2026 05:34:11 = ~3 días = ~4317 min
    const off = transitOffsetVsGroup(sesion2, transit);
    expect(off).not.toBeNull();
    expect(off!).toBeGreaterThan(3000);
  });

  it("mejor (mínimo absoluto) es -16 (la sesión 1 es la relevante)", () => {
    const candidates = [sesion1, sesion2].map((g) =>
      transitOffsetVsGroup(g, transit),
    );
    const best = candidates
      .filter((o): o is number => o !== null)
      .reduce(
        (acc, o) => (Math.abs(o) < Math.abs(acc) ? o : acc),
        Number.POSITIVE_INFINITY,
      );
    expect(best).toBe(-16);
  });

  it("el grupo que contiene el tránsito NO contiene el midpoint (caso del usuario)", () => {
    // El tránsito está 16 min después del fin de la sesión 1,
    // por lo que groupContainsTransit devuelve false. La UI NO
    // muestra tick verde en esta sesión — el tick solo aparece
    // cuando el tránsito cae ESTRICTAMENTE dentro de la sesión.
    expect(groupContainsTransit(sesion1, transit)).toBe(false);
  });
});
