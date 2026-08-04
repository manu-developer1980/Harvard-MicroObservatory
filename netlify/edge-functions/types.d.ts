/**
 * Declaraciones de tipos mínimas para el Edge Function de Netlify.
 *
 * El edge function se ejecuta en Deno (NO en Node), así que las APIs
 * nativas de Deno (`Deno.env`) y los tipos del Edge Runtime
 * (`Context` de `@netlify/edge-functions`) no están disponibles en
 * el tsconfig del proyecto Astro principal.
 *
 * En lugar de instalar `@deno/types` (que añade un montón de tipos
 * que no usamos) o un triple-slash a URLs externas (que requiere
 * red), declaramos SOLO lo que necesitamos. El Deno runtime
 * validará el resto.
 */

// Globals de Deno (subset mínimo que usamos).
declare const Deno: {
  env: {
    toObject(): Record<string, string>;
  };
};

// Tipos del Edge Runtime de Netlify.
declare module "https://edge.netlify.com" {
  export interface Context {
    /** Continúa al siguiente handler (SSR function, static, etc.). */
    next(): Promise<Response>;
    /** Geo lookup (no lo usamos pero está en el type oficial). */
    geo?: Record<string, unknown>;
    site?: { id?: string };
  }
}

// Tipos del cliente Blobs (subset mínimo que usamos).
// Importamos desde esm.sh con versión pinneada; el module specifier
// debe coincidir EXACTAMENTE con el usado en `rate-limit.ts` para
// que el declare module aplique.
declare module "https://esm.sh/@netlify/blobs@10.7.11" {
  export interface SetOptions {
    ttl?: number;
  }
  export interface GetOptions {
    type?: "json" | "text" | "arrayBuffer" | "stream";
    consistency?: "strong" | "eventual";
  }
  export interface Store {
    get<T = unknown>(key: string, opts?: GetOptions): Promise<T | null>;
    setJSON(key: string, value: unknown, opts?: SetOptions): Promise<void>;
  }
  export function getStore(name: string): Store;
}
