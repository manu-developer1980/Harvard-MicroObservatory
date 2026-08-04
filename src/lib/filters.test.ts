/**
 * Tests del clustering de sesiones y de su integración con `applyGapFilter`.
 *
 * Caso estrella (regresión): secuencias que cruzan la medianoche UTC.
 * La versión anterior agrupaba por `YYYYMMDD` y partía una sesión de
 * 22:00 day 1 → 02:00 day 2 en dos grupos independientes, sin evaluar
 * los gaps en el cambio de día. Con `clusterSessions` ahora se trata
 * como UNA sola sesión.
 */
import { describe, it, expect } from "vitest";
import {
  clusterSessions,
  applyGapFilter,
  DEFAULT_SESSION_BREAK_MIN,
  type ImageRecord,
} from "@/lib/filters";

// Helper para construir ImageRecords rápidamente en los tests
function img(
  datetime: string,        // "23-Jul-2026 22:00:00"
  weather: number = 90,
  telescope: string = "T1",
  filter: string = "V",
): ImageRecord {
  return {
    datetime,
    weather,
    telescope,
    filter,
    // `short` se usa como nombre de archivo FITS en el ZIP.
    short: `transit_${datetime.replace(/[^0-9]/g, "")}`,
    fits: `transit_${datetime.replace(/[^0-9]/g, "")}.FITS`,
    site: "T1",
  };
}

describe("clusterSessions: casos básicos", () => {
  it("input vacío devuelve []", () => {
    expect(clusterSessions([])).toEqual([]);
  });

  it("una sola imagen produce una sesión de 1 imagen", () => {
    const s = clusterSessions([img("23-Jul-2026 22:00:00")]);
    expect(s).toHaveLength(1);
    expect(s[0].imageCount).toBe(1);
    expect(s[0].crossesMidnight).toBe(false);
  });

  it("imágenes con gap < 30 min → misma sesión", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:10:00"),
      img("23-Jul-2026 22:20:00"),
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(1);
    expect(s[0].imageCount).toBe(3);
  });

  it("imágenes con gap > 30 min → 2 sesiones", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:10:00"),
      img("23-Jul-2026 22:50:00"), // gap 40 min
      img("23-Jul-2026 23:00:00"),
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(2);
    expect(s[0].imageCount).toBe(2);
    expect(s[1].imageCount).toBe(2);
  });
});

describe("clusterSessions: cruce de medianoche (regresión)", () => {
  it("sesión 22:00 day 1 → 00:30 day 2 con gaps de 15 min = 1 sesión que cruza medianoche", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:15:00"),
      img("23-Jul-2026 22:30:00"),
      img("23-Jul-2026 22:45:00"),
      img("23-Jul-2026 23:00:00"),
      img("23-Jul-2026 23:15:00"),
      img("23-Jul-2026 23:30:00"),
      img("23-Jul-2026 23:45:00"),
      img("24-Jul-2026 00:00:00"),
      img("24-Jul-2026 00:15:00"),
      img("24-Jul-2026 00:30:00"),
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(1);
    expect(s[0].imageCount).toBe(11);
    expect(s[0].crossesMidnight).toBe(true);
    expect(s[0].startDate).toBe("20260723");
    expect(s[0].endDate).toBe("20260724");
    expect(s[0].durationMinutes).toBe(150);
  });

  it("multi-noche separada por >30 min = 2 sesiones, ninguna cruza medianoche individualmente", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:15:00"),
      img("23-Jul-2026 22:30:00"),
      // gap 23h: nueva sesión
      img("24-Jul-2026 22:00:00"),
      img("24-Jul-2026 22:15:00"),
      img("24-Jul-2026 22:30:00"),
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(2);
    expect(s[0].imageCount).toBe(3);
    expect(s[0].crossesMidnight).toBe(false);
    expect(s[1].imageCount).toBe(3);
    expect(s[1].crossesMidnight).toBe(false);
  });
});

describe("clusterSessions: bordes y configuración", () => {
  it("gap exactamente 30 min NO es session break (es la frontera inclusiva)", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:30:00"), // gap 30 min exacto
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(1);
  });

  it("gap 30.5 min ES session break", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:30:30"), // gap 30.5 min
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(2);
  });

  it("DEFAULT_SESSION_BREAK_MIN === 30", () => {
    expect(DEFAULT_SESSION_BREAK_MIN).toBe(30);
  });

  it("orden de input desordenado no afecta el resultado (orden por datetime)", () => {
    const rows = [
      img("23-Jul-2026 22:20:00"),
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:10:00"),
    ];
    const s = clusterSessions(rows);
    expect(s).toHaveLength(1);
    expect(s[0].start).toBe("23-Jul-2026 22:00:00");
    expect(s[0].end).toBe("23-Jul-2026 22:20:00");
  });

  it("threshold personalizable: con 10 min, una sesión de 15 min se parte", () => {
    const rows = [
      img("23-Jul-2026 22:00:00"),
      img("23-Jul-2026 22:15:00"),
    ];
    expect(clusterSessions(rows, 30)).toHaveLength(1);
    expect(clusterSessions(rows, 10)).toHaveLength(2);
  });
});

describe("applyGapFilter: integración con sesiones", () => {
  it("devuelve la lista de sesiones en el resultado", () => {
    const rows = [
      img("23-Jul-2026 22:00:00", 90),
      img("23-Jul-2026 22:15:00", 90),
      img("23-Jul-2026 22:30:00", 90),
    ];
    const { sessions } = applyGapFilter(rows, { threshold: 70, lang: "en" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].imageCount).toBe(3);
  });

  it("una sesión de 22:00 a 02:00 (con weather bueno) mantiene todas las imágenes", () => {
    // Caso de regresión principal: el filtro de gap antes partía esto
    // en dos fechas y nunca evaluaba el gap en el cambio de día. Ahora
    // debería mantener todas las imágenes si la meteorología es buena.
    const rows: ImageRecord[] = [
      img("23-Jul-2026 22:00:00", 90),
      img("23-Jul-2026 22:30:00", 90),
      img("23-Jul-2026 23:00:00", 90),
      img("23-Jul-2026 23:30:00", 90),
      img("24-Jul-2026 00:00:00", 90),
      img("24-Jul-2026 00:30:00", 90),
      img("24-Jul-2026 01:00:00", 90),
      img("24-Jul-2026 01:30:00", 90),
      img("24-Jul-2026 02:00:00", 90),
    ];

    const { kept, discarded, sessions } = applyGapFilter(rows, {
      threshold: 70,
      lang: "en",
    });
    // Una sola sesión que cruza medianoche
    expect(sessions).toHaveLength(1);
    expect(sessions[0].crossesMidnight).toBe(true);
    // Con weather=90 > threshold=70 y gaps=30 min exactos, no se descarta nada
    expect(kept).toHaveLength(9);
    expect(discarded).toHaveLength(0);
  });
});
