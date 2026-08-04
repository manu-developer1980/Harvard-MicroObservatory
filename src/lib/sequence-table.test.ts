import { describe, it, expect } from "vitest";
import {
  buildAllFiles,
  groupContainsTransit,
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

describe("groupContainsTransit", () => {
  it("devuelve true cuando el midpoint cae dentro del rango de imágenes", () => {
    const g = {
      date: "20260802",
      transit: [
        rec("a", "02-Aug-2026 06:00:00"),
        rec("b", "02-Aug-2026 08:00:00"),
        rec("c", "02-Aug-2026 09:00:00"),
      ],
      darks: [],
    };
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(g, transit)).toBe(true);
  });

  it("devuelve true en el BORDE inferior (firstMs == midMs)", () => {
    const g = {
      date: "20260802",
      transit: [
        rec("a", "02-Aug-2026 08:16:00"),
        rec("b", "02-Aug-2026 09:00:00"),
      ],
      darks: [],
    };
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(g, transit)).toBe(true);
  });

  it("devuelve true en el BORDE superior (lastMs == midMs)", () => {
    const g = {
      date: "20260802",
      transit: [
        rec("a", "02-Aug-2026 06:00:00"),
        rec("b", "02-Aug-2026 08:16:00"),
      ],
      darks: [],
    };
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(g, transit)).toBe(true);
  });

  it("devuelve false cuando el midpoint cae ANTES del grupo", () => {
    const g = {
      date: "20260802",
      transit: [
        rec("a", "02-Aug-2026 09:00:00"),
        rec("b", "02-Aug-2026 10:00:00"),
      ],
      darks: [],
    };
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(g, transit)).toBe(false);
  });

  it("devuelve false cuando el midpoint cae DESPUÉS del grupo", () => {
    const g = {
      date: "20260802",
      transit: [
        rec("a", "02-Aug-2026 06:00:00"),
        rec("b", "02-Aug-2022 07:00:00"),
      ],
      darks: [],
    };
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(g, transit)).toBe(false);
  });

  it("devuelve false si no hay tránsito", () => {
    const g = {
      date: "20260802",
      transit: [rec("a", "02-Aug-2026 06:00:00")],
      darks: [],
    };
    expect(groupContainsTransit(g, null)).toBe(false);
  });

  it("devuelve false si el grupo no tiene imágenes de tránsito", () => {
    const g = {
      date: "20260802",
      transit: [],
      darks: [rec("dark", "02-Aug-2026 06:00:00")],
    };
    const transit = { midtimeIso: "2026-08-02T08:16:00.000Z" };
    expect(groupContainsTransit(g, transit)).toBe(false);
  });

  it("devuelve false si midtimeIso no es parseable", () => {
    const g = {
      date: "20260802",
      transit: [rec("a", "02-Aug-2026 06:00:00")],
      darks: [],
    };
    expect(groupContainsTransit(g, { midtimeIso: "not-a-date" })).toBe(
      false,
    );
  });

  it("ignora los registros del grupo que no están en transit[] (e.g. darks)", () => {
    // grupo con 1 transit y 1 dark, donde el dark está fuera del rango
    const g = {
      date: "20260802",
      transit: [rec("a", "02-Aug-2026 08:00:00")],
      darks: [rec("dark", "02-Aug-2026 03:00:00")],
    };
    const transit = { midtimeIso: "2026-08-02T08:00:00.000Z" };
    // El rango se calcula SOLO sobre transit[], no sobre darks.
    expect(groupContainsTransit(g, transit)).toBe(true);
  });
});

describe("buildAllFiles", () => {
  const groups = [
    {
      date: "20260802",
      transit: [rec("t1", "02-Aug-2026 06:00:00")],
      darks: [rec("d1", "02-Aug-2026 06:00:00")],
    },
    {
      date: "20260803",
      transit: [rec("t2", "03-Aug-2026 06:00:00")],
      darks: [],
    },
  ];

  it("sin selectedDates: incluye todos los grupos (backward compatible)", () => {
    const files = buildAllFiles(groups);
    expect(files).toEqual([
      { path: "20260802/t1.FITS", file: "t1.FITS" },
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
      { path: "20260803/t2.FITS", file: "t2.FITS" },
    ]);
  });

  it("con selectedDates: solo los grupos marcados", () => {
    const files = buildAllFiles(groups, new Set(["20260802"]));
    expect(files).toEqual([
      { path: "20260802/t1.FITS", file: "t1.FITS" },
      { path: "20260802/darks/d1.FITS", file: "d1.FITS" },
    ]);
  });

  it("con selectedDates vacío: lista vacía", () => {
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
