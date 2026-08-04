/**
 * Funciones puras de matching de tránsitos contra la ventana del usuario.
 *
 * Extraídas de `pages/api/transit-check.ts` para poder testearlas
 * sin levantar el endpoint (ni mockear fetch a NASA). Toda la lógica
 * que decide qué tránsito cae "dentro" de la ventana vive aquí.
 *
 * Lo que NO vive aquí:
 *   - Parseo del body / query params del endpoint
 *   - Llamada a la TAP query de NASA
 *   - Caché HTTP
 *   - Selección de la "mejor" efeméride por planeta (eso requiere
 *     varias efemérides candidatas; vive en el endpoint)
 */
import { jdToUtcIso, isoToMoFormat } from "@/lib/jd";

export type PlanetEph = {
  pl_name: string;
  hostname: string;
  pl_orbper: number;        // días
  pl_orbpererr1: number;    // incertidumbre del periodo (días)
  pl_tranmid: number;       // BJD del tránsito de referencia
  pl_tranmiderr1: number;   // incertidumbre +1σ (días)
  pl_tranmiderr2: number;   // incertidumbre -1σ (días)
  pl_trandur?: number;      // horas (puede ser null/undefined)
  pl_refname?: string;      // referencia bibliográfica (HTML)
};

export type TransitHit = {
  pl_name: string;
  hostname: string;
  midtimeJd: number;
  midtimeUtc: string;     // formato MO "2026-07-24 02:09:00"
  midtimeIso: string;     // "2026-07-24T02:09:00.000Z"
  period: number;         // días
  duration?: number;      // horas
  uncertaintyJd: number;  // 1σ en días
  reference?: string;     // bibliografía limpia de HTML
  // 0 si el midpoint está dentro de la ventana. Si está fuera, minutos
  // de diferencia con el borde más cercano (positivo = después del fin,
  // negativo = antes del inicio).
  offsetMin: number;
};

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/**
 * Margen de tolerancia al matching de tránsitos contra la ventana, en
 * días. Vale 0.01 d = 14.4 min.
 *
 * Por qué este valor:
 *   - Cubre la diferencia BJD_TDB vs UTC (~8 min según NASA).
 *   - Cubre el redondeo de coma flotante al convertir JD ↔ ISO string.
 *   - Es muy inferior a NEAR_MISS_THRESHOLD_MIN=120 del frontend, así
 *     que un tránsito "lejano" se clasifica correctamente como ✗ (no
 *     encontrado) en vez de contaminar la lista de "found".
 *
 * NO subir. Un valor de 0.5 (12 h) generó un bug en el que un tránsito
 * 9 h después del fin de la ventana se marcaba como "dentro" — el bug
 * del WASP-67 b del 2026-07-29. Ver `transit-match.test.ts`.
 */
export const TRANSIT_MATCH_TOLERANCE_DAYS = 0.01;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Limpia el HTML que viene en `pl_refname` (NASA lo entrega como
 * `<a href="...">Ivshina &amp; Winn 2022</a>`) y devuelve solo el texto
 * legible. Si la entrada no parece HTML, la devuelve tal cual.
 */
export function stripHtml(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const noTags = trimmed.replace(/<[^>]*>/g, "");
  const decoded = noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return decoded.trim() || undefined;
}

/**
 * Incertidumbre propagada de la predicción a `n` períodos desde la
 * referencia:
 *
 *     σ(t_n) ≈ √(σ(t_0)² + (n · σ(P))²)
 *
 * El término del periodo DOMINA a partir de ~1000 períodos hacia el
 * futuro. Por eso NASA usa un flag `ismostprecise=1` que NO es
 * simplemente "menor pl_tranmiderr1", sino la efeméride con menor
 * σ(t_n) en el momento de la consulta.
 */
export function propagatedUncertainty(
  eph: Pick<PlanetEph, "pl_tranmiderr1" | "pl_tranmiderr2" | "pl_orbpererr1">,
  n: number,
): number {
  const sigmaT0 = Math.max(
    Math.abs(eph.pl_tranmiderr1 || 0),
    Math.abs(eph.pl_tranmiderr2 || 0),
  );
  const sigmaP = Math.abs(eph.pl_orbpererr1 || 0);
  return Math.sqrt(sigmaT0 * sigmaT0 + (n * sigmaP) * (n * sigmaP));
}

// ---------------------------------------------------------------------------
// Core: matching contra la ventana
// ---------------------------------------------------------------------------

/**
 * Genera los tránsitos del planeta en [startJd, endJd] usando
 * t_n = t_0 + n*P para n entero. Para no perdernos ningún tránsito en
 * una ventana de varios días, iteramos ±5 períodos extra alrededor.
 *
 * Solo devuelve tránsitos cuyo midpoint cae dentro de la ventana con
 * una tolerancia de TRANSIT_MATCH_TOLERANCE_DAYS. Para el "near miss"
 * usa `findNearest`.
 */
export function transitsInWindow(
  eph: PlanetEph,
  startJd: number,
  endJd: number,
): TransitHit[] {
  if (eph.pl_orbper <= 0) return [];
  const hits: TransitHit[] = [];

  const nApprox = Math.round((startJd - eph.pl_tranmid) / eph.pl_orbper);
  const periodsInWindow = Math.ceil((endJd - startJd) / eph.pl_orbper) + 2;
  const nStart = nApprox - 5;
  const nEnd = nApprox + periodsInWindow + 5;

  const uncertaintyJd = Math.max(
    Math.abs(eph.pl_tranmiderr1 || 0),
    Math.abs(eph.pl_tranmiderr2 || 0),
  );

  for (let n = nStart; n <= nEnd; n++) {
    const midJd = eph.pl_tranmid + n * eph.pl_orbper;
    if (
      midJd < startJd - TRANSIT_MATCH_TOLERANCE_DAYS ||
      midJd > endJd + TRANSIT_MATCH_TOLERANCE_DAYS
    ) continue;
    const midIso = jdToUtcIso(midJd);
    let offsetMin = 0;
    if (midJd < startJd) {
      offsetMin = Math.round((startJd - midJd) * 24 * 60);
    } else if (midJd > endJd) {
      offsetMin = -Math.round((midJd - endJd) * 24 * 60);
    }
    hits.push({
      pl_name: eph.pl_name,
      hostname: eph.hostname,
      midtimeJd: midJd,
      midtimeUtc: isoToMoFormat(midIso),
      midtimeIso: midIso,
      period: eph.pl_orbper,
      duration: eph.pl_trandur ?? undefined,
      uncertaintyJd,
      reference: stripHtml(eph.pl_refname),
      offsetMin,
    });
  }
  return hits;
}

/**
 * Encuentra el tránsito más cercano a la ventana (incluso si está
 * fuera). Busca ±10 períodos alrededor para detectar "near misses".
 * Devuelve `null` si el planeta no tiene un periodo válido.
 */
export function findNearest(
  eph: PlanetEph,
  startJd: number,
  endJd: number,
): TransitHit | null {
  if (eph.pl_orbper <= 0) return null;
  const nApprox = Math.round((startJd - eph.pl_tranmid) / eph.pl_orbper);
  const periodsInWindow = Math.ceil((endJd - startJd) / eph.pl_orbper) + 2;
  const nStart = nApprox - 10;
  const nEnd = nApprox + periodsInWindow + 10;

  const uncertaintyJd = Math.max(
    Math.abs(eph.pl_tranmiderr1 || 0),
    Math.abs(eph.pl_tranmiderr2 || 0),
  );

  let best: TransitHit | null = null;
  let bestDist = Infinity;

  for (let n = nStart; n <= nEnd; n++) {
    const midJd = eph.pl_tranmid + n * eph.pl_orbper;
    let dist: number;
    if (midJd < startJd) dist = startJd - midJd;
    else if (midJd > endJd) dist = midJd - endJd;
    else dist = 0;
    if (dist < bestDist) {
      bestDist = dist;
      const midIso = jdToUtcIso(midJd);
      let offsetMin = 0;
      if (midJd < startJd) {
        offsetMin = Math.round((startJd - midJd) * 24 * 60);
      } else if (midJd > endJd) {
        offsetMin = -Math.round((midJd - endJd) * 24 * 60);
      }
      best = {
        pl_name: eph.pl_name,
        hostname: eph.hostname,
        midtimeJd: midJd,
        midtimeUtc: isoToMoFormat(midIso),
        midtimeIso: midIso,
        period: eph.pl_orbper,
        duration: eph.pl_trandur ?? undefined,
        uncertaintyJd,
        reference: stripHtml(eph.pl_refname),
        offsetMin,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Matching sobre MÚLTIPLES efemérides
// ---------------------------------------------------------------------------

export type EphemeridesMatchResult = {
  /** Tránsitos cuya midpoint cae dentro de la ventana (cualquier efeméride). */
  transits: TransitHit[];
  /** Midpoint más cercano a la ventana, considerando TODAS las efemérides. */
  nearest: TransitHit | null;
  /** Nombres únicos de planeta que aportaron al menos una efeméride. */
  matchedPlanets: string[];
  /** Referencias bibliográficas únicas (HTML limpio). */
  references: string[];
};

/**
 * Aplica el matching sobre TODAS las efemérides del array, sin
 * pre-seleccionar una "mejor".
 *
 * Por qué NO seleccionamos la mejor efeméride por planeta:
 *   - NASA entrega varias efemérides por planeta (distintos papers,
 *     cada uno con su t_0 y P medidos). La "ismostprecise=1" que usa
 *     TransitView es dinámica y depende de la incertidumbre
 *     propagada σ(t_n) en la fecha consultada.
 *   - Replicar esa selección con nuestros datos (σ_t0, σ_P) fallaba
 *     para casos como WASP-67 b del 2026-07-29: nuestra "mejor"
 *     efeméride predecía el tránsito a 20:09:36 UTC (Mancini 2014),
 *     pero las 6 efemérides de NASA TransitView lo predicen entre
 *     10:03 y 10:22 UTC, todas dentro de la ventana del usuario.
 *     El bug se manifestaba como "✗ ningún tránsito encontrado"
 *     cuando en realidad hay 6 predicciones dentro de la ventana.
 *   - La solución simple y robusta: usar TODAS las efemérides. Si
 *     AL MENOS UNA predice un tránsito dentro de la ventana, lo
 *     marcamos como "found". El usuario ve la dispersión y decide.
 */
export function matchAllEphemerides(
  ephs: PlanetEph[],
  startJd: number,
  endJd: number,
): EphemeridesMatchResult {
  const allInWindow: TransitHit[] = [];
  let bestNearest: TransitHit | null = null;

  for (const eph of ephs) {
    allInWindow.push(...transitsInWindow(eph, startJd, endJd));
    const n = findNearest(eph, startJd, endJd);
    if (n) {
      if (
        !bestNearest ||
        Math.abs(n.offsetMin) < Math.abs(bestNearest.offsetMin)
      ) {
        bestNearest = n;
      }
    }
  }
  allInWindow.sort((a, b) => a.midtimeJd - b.midtimeJd);

  const matchedPlanets = Array.from(new Set(ephs.map((e) => e.pl_name)));
  const references = Array.from(
    new Set(
      ephs
        .map((e) => stripHtml(e.pl_refname))
        .filter((r): r is string => !!r),
    ),
  );

  return {
    transits: allInWindow,
    nearest: bestNearest,
    matchedPlanets,
    references,
  };
}
