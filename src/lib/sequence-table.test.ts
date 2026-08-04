import { describe, it, expect } from "vitest";
import {
  buildAllFiles,
  groupContainsTransit,
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
