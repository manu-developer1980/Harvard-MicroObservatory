/**
 * Tests de los schemas de validación (Zod) en `schemas.ts`.
 *
 * Cubren:
 *  - Aceptación de inputs válidos (happy path).
 *  - Rechazo de inputs malformados con códigos de error claros.
 *  - Rechazo de claves desconocidas (defense in depth).
 *  - Defensa contra inputs hostiles (path traversal, SQL wildcards,
 *    caracteres de control, longitudes excesivas).
 */
import { describe, it, expect } from "vitest";
import {
  PreviewRequestSchema,
  TransitCheckRequestSchema,
  parseBody,
  LangSchema,
} from "@/lib/schemas";

describe("LangSchema", () => {
  it("acepta 'en' y 'es'", () => {
    expect(LangSchema.parse("en")).toBe("en");
    expect(LangSchema.parse("es")).toBe("es");
  });

  it("rechaza valores no soportados", () => {
    expect(() => LangSchema.parse("fr")).toThrow();
    expect(() => LangSchema.parse("")).toThrow();
    expect(() => LangSchema.parse(42)).toThrow();
  });
});

describe("PreviewRequestSchema", () => {
  const validTarget = "WASP-12";
  const minimal = { target: validTarget };

  it("acepta el body mínimo (solo target)", () => {
    const r = PreviewRequestSchema.parse(minimal);
    expect(r.target).toBe(validTarget);
  });

  it("acepta body completo con todos los campos", () => {
    const r = PreviewRequestSchema.parse({
      target: "TrES-3",
      date: "29-Jul-2026:30-Jul-2026",
      threshold: 90,
      telescope: "Telescope-C",
      filter: "V",
      badGapMid: 12,
      inclusiveWeather: false,
      requireDarks: true,
      lang: "es",
    });
    expect(r.threshold).toBe(90);
    expect(r.badGapMid).toBe(12);
    expect(r.lang).toBe("es");
  });

  it("trimea espacios alrededor del target", () => {
    const r = PreviewRequestSchema.parse({ target: "  WASP-12  " });
    expect(r.target).toBe("WASP-12");
  });

  it("rechaza target vacío", () => {
    const r = PreviewRequestSchema.safeParse({ target: "" });
    expect(r.success).toBe(false);
  });

  it("rechaza target con caracteres peligrosos (path traversal, SQL)", () => {
    // Comilla simple, %, _, /, \ — todos bloqueados por el regex.
    for (const bad of ["O'Hara", "WASP%", "WASP_12", "../etc", "a\\b"]) {
      const r = PreviewRequestSchema.safeParse({ target: bad });
      expect(r.success, `debería rechazar: ${bad}`).toBe(false);
    }
  });

  it("rechaza target excesivamente largo (>64)", () => {
    const r = PreviewRequestSchema.safeParse({ target: "a".repeat(65) });
    expect(r.success).toBe(false);
  });

  it("rechaza threshold fuera de 0-100", () => {
    expect(PreviewRequestSchema.safeParse({ target: "X", threshold: -1 }).success).toBe(false);
    expect(PreviewRequestSchema.safeParse({ target: "X", threshold: 101 }).success).toBe(false);
  });

  it("rechaza badGapMid fuera de 4-30", () => {
    expect(PreviewRequestSchema.safeParse({ target: "X", badGapMid: 3 }).success).toBe(false);
    expect(PreviewRequestSchema.safeParse({ target: "X", badGapMid: 31 }).success).toBe(false);
  });

  it("rechaza threshold no entero (defense in depth)", () => {
    const r = PreviewRequestSchema.safeParse({ target: "X", threshold: 85.5 });
    expect(r.success).toBe(false);
  });

  it("rechaza claves desconocidas (.strict())", () => {
    const r = PreviewRequestSchema.safeParse({
      target: "WASP-12",
      evil: "pwn",
    });
    expect(r.success).toBe(false);
  });

  it("rechaza tipos incorrectos (no coerción implícita)", () => {
    // Zod 4 NO convierte "85" a 85 — buen comportamiento: el
    // cliente debe mandar el tipo correcto. Esto evita bypasses
    // vía coerción de strings.
    const r = PreviewRequestSchema.safeParse({ target: "X", threshold: "85" });
    expect(r.success).toBe(false);
  });
});

describe("TransitCheckRequestSchema", () => {
  const valid = {
    target: "WASP-67",
    start: "29-Jul-2026 08:10:10",
    end: "29-Jul-2026 10:30:15",
  };

  it("acepta el body mínimo", () => {
    const r = TransitCheckRequestSchema.parse(valid);
    expect(r.target).toBe("WASP-67");
  });

  it("acepta formato ISO UTC", () => {
    const r = TransitCheckRequestSchema.parse({
      target: "X",
      start: "2026-07-29T08:10:10Z",
      end: "2026-07-29T10:30:15Z",
    });
    expect(r.start).toMatch(/^2026-/);
  });

  it("rechaza start/end vacíos", () => {
    expect(
      TransitCheckRequestSchema.safeParse({ ...valid, start: "" }).success,
    ).toBe(false);
  });

  it("rechaza formatos de fecha no reconocidos", () => {
    expect(
      TransitCheckRequestSchema.safeParse({
        ...valid,
        start: "ayer a las 8",
      }).success,
    ).toBe(false);
  });

  it("rechaza target con caracteres hostiles", () => {
    expect(
      TransitCheckRequestSchema.safeParse({
        ...valid,
        target: "WASP-12' OR 1=1--",
      }).success,
    ).toBe(false);
  });

  it("rechaza claves desconocidas", () => {
    const r = TransitCheckRequestSchema.safeParse({
      ...valid,
      admin: true,
    });
    expect(r.success).toBe(false);
  });
});

describe("parseBody", () => {
  it("devuelve { ok: true, data } con input válido", () => {
    const r = parseBody(PreviewRequestSchema, { target: "WASP-12" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.target).toBe("WASP-12");
  });

  it("devuelve { ok: false, error } con mensaje claro en error", () => {
    const r = parseBody(PreviewRequestSchema, { target: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/target/);
    }
  });

  it("no lanza excepciones con input completamente inválido", () => {
    // El cliente podría mandar null, undefined, string, número...
    expect(() => parseBody(PreviewRequestSchema, null)).not.toThrow();
    expect(() => parseBody(PreviewRequestSchema, "string")).not.toThrow();
    expect(() => parseBody(PreviewRequestSchema, 42)).not.toThrow();
  });
});
