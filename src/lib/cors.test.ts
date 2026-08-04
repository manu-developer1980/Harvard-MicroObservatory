/**
 * Tests del helper CORS para el proxy FITS.
 *
 * Casos cubiertos:
 *  - Origin en la allowlist → se espeja.
 *  - Origin NO en la allowlist → null (CORS bloqueado).
 *  - Sin Origin (curl, same-origin) → null (no hace falta espejar).
 *  - DEV: localhost permitido por defecto.
 *  - PROD sin allowlist → deny-all.
 *  - Espacios y entradas vacías en la env var se ignoran.
 *  - Origins con scheme no http/https o con espacios → ignorados.
 *  - Origins case-insensitive.
 */
import { describe, it, expect } from "vitest";
import { resolveAllowedOrigin } from "@/lib/cors";

function req(origin: string | null): Request {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  return new Request("https://api.example.com/api/fits/test.FITS", {
    method: "GET",
    headers,
  });
}

describe("resolveAllowedOrigin — producción (sin isDev)", () => {
  it("espeja origin si está en la allowlist", () => {
    const r = resolveAllowedOrigin(req("https://exotic.example.com"), {
      allowedOrigins: "https://exotic.example.com",
    });
    expect(r).toBe("https://exotic.example.com");
  });

  it("devuelve null si el origin NO está en la allowlist", () => {
    const r = resolveAllowedOrigin(req("https://evil.example.com"), {
      allowedOrigins: "https://exotic.example.com",
    });
    expect(r).toBeNull();
  });

  it("soporta múltiples orígenes separados por comas", () => {
    const env = "https://exotic.example.com,https://staging.example.com";
    expect(
      resolveAllowedOrigin(req("https://staging.example.com"), {
        allowedOrigins: env,
      }),
    ).toBe("https://staging.example.com");
    expect(
      resolveAllowedOrigin(req("https://other.example.com"), {
        allowedOrigins: env,
      }),
    ).toBeNull();
  });

  it("ignora espacios y entradas vacías en la env var", () => {
    const env =
      "  https://exotic.example.com , , https://staging.example.com ";
    expect(
      resolveAllowedOrigin(req("https://exotic.example.com"), {
        allowedOrigins: env,
      }),
    ).toBe("https://exotic.example.com");
  });

  it("deny-by-default si no se configura la env var", () => {
    // Ni siquiera localhost funciona en prod sin config.
    expect(
      resolveAllowedOrigin(req("http://localhost:4321"), {
        allowedOrigins: undefined,
      }),
    ).toBeNull();
  });

  it("ignora origins con scheme no http/https", () => {
    expect(
      resolveAllowedOrigin(req("javascript:alert(1)"), {
        allowedOrigins: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  it("trimea espacios accidentales en el Origin del request", () => {
    // Comportamiento defensivo: aunque los browsers no mandan
    // espacios, si llegan los limpiamos antes de comparar.
    expect(
      resolveAllowedOrigin(req("https://exotic.example.com  "), {
        allowedOrigins: "https://exotic.example.com",
      }),
    ).toBe("https://exotic.example.com");
  });
});

describe("resolveAllowedOrigin — desarrollo (isDev=true)", () => {
  it("permite localhost:4321 (Astro dev) sin config", () => {
    const r = resolveAllowedOrigin(req("http://localhost:4321"), {
      allowedOrigins: undefined,
      isDev: true,
    });
    expect(r).toBe("http://localhost:4321");
  });

  it("permite localhost:8888 (Netlify dev) sin config", () => {
    const r = resolveAllowedOrigin(req("http://localhost:8888"), {
      allowedOrigins: undefined,
      isDev: true,
    });
    expect(r).toBe("http://localhost:8888");
  });

  it("permite 127.0.0.1 sin config", () => {
    const r = resolveAllowedOrigin(req("http://127.0.0.1:4321"), {
      allowedOrigins: undefined,
      isDev: true,
    });
    expect(r).toBe("http://127.0.0.1:4321");
  });

  it("rechaza origins externos aunque esté en dev", () => {
    const r = resolveAllowedOrigin(req("https://evil.example.com"), {
      allowedOrigins: undefined,
      isDev: true,
    });
    expect(r).toBeNull();
  });

  it("mezcla allowlist explícita con defaults de dev", () => {
    const r = resolveAllowedOrigin(req("https://exotic.example.com"), {
      allowedOrigins: "https://exotic.example.com",
      isDev: true,
    });
    expect(r).toBe("https://exotic.example.com");
    const r2 = resolveAllowedOrigin(req("http://localhost:4321"), {
      allowedOrigins: "https://exotic.example.com",
      isDev: true,
    });
    expect(r2).toBe("http://localhost:4321");
  });
});

describe("resolveAllowedOrigin — sin Origin header", () => {
  it("devuelve null (curl, same-origin, server-to-server)", () => {
    // Sin Origin, no hay nada que espejar. El browser no aplica CORS
    // a same-origin ni a <a download>.
    const r = resolveAllowedOrigin(req(null), {
      allowedOrigins: "https://exotic.example.com",
    });
    expect(r).toBeNull();
  });
});

describe("resolveAllowedOrigin — comparación case-sensitive", () => {
  it("HTTPS (mayúsculas) NO matchea https (minúsculas) en la allowlist", () => {
    // Los browsers siempre mandan el scheme en minúsculas. Si llega
    // un request con scheme en mayúsculas, NO es un browser legítimo
    // → lo rechazamos (defense in depth, evita enumeración con
    // herramientas no estándar).
    const r = resolveAllowedOrigin(req("HTTPS://exotic.example.com"), {
      allowedOrigins: "https://exotic.example.com",
    });
    expect(r).toBeNull();
  });
});
