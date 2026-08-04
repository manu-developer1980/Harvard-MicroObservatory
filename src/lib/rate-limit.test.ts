/**
 * Tests del core de rate limiting (`checkRateLimit` y `clientIp`).
 *
 * Cubre:
 *  - Happy path: primeras N requests pasan, la N+1ª se deniega.
 *  - Reset de ventana: tras windowSec, vuelve a estar disponible.
 *  - Bordes de ventana: requests en el segundo del cambio.
 *  - Estado nulo / estado de ventana antigua: empieza nueva ventana.
 *  - remaining decrece correctamente.
 *  - resetInSec siempre positivo.
 *  - IP extraction desde x-forwarded-for, x-real-ip, fallback.
 */
import { describe, it, expect } from "vitest";
import { checkRateLimit, clientIp, type RateLimitConfig } from "@/lib/rate-limit";

const cfg: RateLimitConfig = { max: 3, windowSec: 60 };
const T0 = 1_700_000_000_000; // epoch ms arbitrario (alineado a minuto)
// 1_700_000_000_000 / 60_000 = 28333333.333...; floor = 28333333; *60000 = T0 exacto
// Para que T0 caiga justo en el inicio de ventana, lo alineamos:
const T_START = Math.floor(T0 / 60_000) * 60_000;

describe("checkRateLimit — happy path", () => {
  it("permite las primeras N requests y deniega la N+1ª", () => {
    let state: { count: number; windowStart: number } | null = null;
    for (let i = 0; i < cfg.max; i++) {
      const d = checkRateLimit(state, T_START + i * 1000, cfg);
      expect(d.allowed).toBe(true);
      state = d.nextState;
    }
    const denied = checkRateLimit(state, T_START + cfg.max * 1000, cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("remaining decrece: max-1, max-2, ..., 0", () => {
    let state: { count: number; windowStart: number } | null = null;
    for (let i = 0; i < cfg.max; i++) {
      const d = checkRateLimit(state, T_START + i * 100, cfg);
      expect(d.remaining).toBe(cfg.max - 1 - i);
      state = d.nextState;
    }
  });
});

describe("checkRateLimit — reset de ventana", () => {
  it("permite de nuevo tras cambiar de ventana", () => {
    // Llenamos la primera ventana
    let state: { count: number; windowStart: number } | null = null;
    for (let i = 0; i < cfg.max; i++) {
      state = checkRateLimit(state, T_START + i * 100, cfg).nextState;
    }
    expect(checkRateLimit(state, T_START + cfg.max * 100, cfg).allowed).toBe(false);

    // Saltamos a la siguiente ventana
    const T_NEXT = T_START + cfg.windowSec * 1000;
    const d = checkRateLimit(state, T_NEXT + 100, cfg);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(cfg.max - 1);
    expect(d.nextState.windowStart).toBe(T_NEXT);
  });

  it("estado de ventana anterior (antiguo windowStart) se trata como nueva ventana", () => {
    const oldState = {
      count: cfg.max, // saturado
      windowStart: T_START - cfg.windowSec * 1000, // ventana anterior
    };
    const d = checkRateLimit(oldState, T_START, cfg);
    expect(d.allowed).toBe(true);
    expect(d.nextState.count).toBe(1);
    expect(d.nextState.windowStart).toBe(T_START);
  });
});

describe("checkRateLimit — bordes de ventana", () => {
  it("último segundo de la ventana sigue contando para la MISMA ventana", () => {
    // T_START + 59_999 ms: sigue en la ventana de T_START
    const d = checkRateLimit(null, T_START + 59_999, cfg);
    expect(d.nextState.windowStart).toBe(T_START);
    expect(d.resetInSec).toBe(1); // menos de 2s
  });

  it("resetInSec siempre es >= 1 (evitamos 0 o negativos)", () => {
    const d = checkRateLimit(null, T_START + 59_999, cfg);
    expect(d.resetInSec).toBeGreaterThanOrEqual(1);
  });
});

describe("checkRateLimit — estado inicial", () => {
  it("estado null se trata como ventana vacía", () => {
    const d = checkRateLimit(null, T_START, cfg);
    expect(d.allowed).toBe(true);
    expect(d.nextState.count).toBe(1);
    expect(d.nextState.windowStart).toBe(T_START);
  });

  it("estado denegado NO incrementa el counter", () => {
    // Llenamos
    let state: { count: number; windowStart: number } | null = null;
    for (let i = 0; i < cfg.max; i++) {
      state = checkRateLimit(state, T_START + i * 100, cfg).nextState;
    }
    // Varios denied
    const d1 = checkRateLimit(state, T_START + 1000, cfg);
    const d2 = checkRateLimit(d1.nextState, T_START + 2000, cfg);
    expect(d1.allowed).toBe(false);
    expect(d2.allowed).toBe(false);
    expect(d2.nextState.count).toBe(cfg.max); // sin incremento
  });
});

describe("clientIp", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("https://x.test/", { headers });
  }

  it("toma la primera IP de x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" }))).toBe("1.2.3.4");
  });

  it("trim de espacios en x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "  1.2.3.4  ,10.0.0.1" }))).toBe("1.2.3.4");
  });

  it("usa x-real-ip como fallback", () => {
    expect(clientIp(req({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("prefiere x-forwarded-for sobre x-real-ip", () => {
    expect(
      clientIp(
        req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }),
      ),
    ).toBe("1.2.3.4");
  });

  it("devuelve 'unknown' si no hay cabeceras", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("ignora x-forwarded-for vacío y recae a x-real-ip", () => {
    expect(clientIp(req({ "x-forwarded-for": "", "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });
});
