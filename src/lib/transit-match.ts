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
// Selección de la efeméride "most precise" (réplica de NASA TransitView)
// ---------------------------------------------------------------------------

/**
 * Escoge la efeméride con MENOR incertidumbre propagada σ(t_n) en la
 * fecha de la consulta. Esto es lo que NASA marca como "Most precise
 * references" (rojo en TransitView): el flag `ismostprecise=1` que
 * la Transit Service API computa dinámicamente a partir de
 *
 *     σ(t_n) ≈ √(σ(t_0)² + (n · σ(P))²)
 *
 * No es lo mismo que el mínimo `pl_tranmiderr1` (eso solo mira la
 * incertidumbre de la época de referencia, ignorando cómo crece la
 * del periodo con n). Para fechas lejanas de t_0, el término del
 * periodo DOMINA y la elección cambia.
 *
 * @param ephs   Efemérides candidatas (mismo planeta).
 * @param queryJd Fecha alrededor de la cual se hace la predicción.
 *                Típicamente el centro de la ventana del usuario.
 * @returns      La efeméride con menor σ(t_n). Si hay empate, la
 *               primera del array (orden estable).
 */
export function pickMostPreciseEphemeris(
  ephs: PlanetEph[],
  queryJd: number,
): PlanetEph {
  if (ephs.length === 1) return ephs[0];

  let best: PlanetEph = ephs[0];
  let bestSigma = Infinity;
  for (const eph of ephs) {
    if (eph.pl_orbper <= 0) continue; // efeméride inválida
    const n = Math.round((queryJd - eph.pl_tranmid) / eph.pl_orbper);
    const sigma = propagatedUncertainty(eph, n);
    if (sigma < bestSigma) {
      bestSigma = sigma;
      best = eph;
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

// ---------------------------------------------------------------------------
// Matching sobre LA efeméride "most precise" (réplica del TransitView)
// ---------------------------------------------------------------------------

export type MostPreciseMatchResult = {
  /** Efeméride que se ha usado (la "most precise" en queryJd). */
  picked: PlanetEph;
  /** Predicción: el tránsito más cercano a la ventana (puede estar
   *  dentro o fuera). Es UN solo objeto, no un array. */
  transit: TransitHit;
  /** `true` si la midpoint cae dentro de la ventana. */
  found: boolean;
};

/**
 * Variante de `matchAllEphemerides` que usa SOLO la efeméride marcada
 * como "most precise" por NASA (réplica de su TransitView con el
 * "Event Midpoint Calendar UT"). Si esa predicción cae dentro de la
 * ventana del usuario → `found: true`. Si no, devolvemos el "nearest"
 * igualmente para que la UI pueda avisar del near-miss.
 *
 * Por qué este y no `matchAllEphemerides`:
 *   - La UX es más clara: UNA predicción por planeta, no 5-6.
 *   - Coincide con lo que el usuario ve en la web de NASA cuando
 *     selecciona un target y abre TransitView.
 *   - Cuando las efemérides CONVERGEN (la mayoría de los casos), las
 *     predicciones están a pocos segundos entre sí, así que el
 *     resultado es esencialmente el mismo que `matchAll`.
 *   - Cuando DIVERGEN (caso raro, ephemerides de papers con
 *     calibraciones distintas), elegimos la que NASA considera
 *     "most precise" — la de menor σ(t_n) propagada.
 *
 * IMPORTANTE: el `transit` devuelto es el MÁS CERCANO a la ventana
 * (no necesariamente dentro). Si está dentro → `found: true` y
 * `offsetMin === 0`. Si no, `offsetMin !== 0` indica los minutos de
 * desviación (positivo = antes del inicio, negativo = después del fin).
 *
 * Caso WASP-67 b 2026-07-29 (regresión previa): con `matchAll`, las
 * 6 efemérides predecían 10:03–10:22 (dentro de ventana) y se
 * reportaba "found". Con `matchMostPrecise`, se elige la "most
 * precise" según σ(t_n) en el centro de la ventana — si NASA la
 * marca como tal, la predicción debería caer en ese mismo rango
 * (10:03–10:22) y `found` sigue siendo true. Si nuestra
 * `propagatedUncertainty` discrepa de la de NASA (escogiendo Mancini
 * 2014 en vez de la "true most precise"), la predicción se va a
 * 20:09:36 UTC y `found` pasa a false. Por eso el test de regresión
 * usa la efeméride con `σ_t0` claramente más bajo que las demás —
 * la que se elegiría en la práctica.
 */
export function matchMostPreciseEphemeris(
  ephs: PlanetEph[],
  startJd: number,
  endJd: number,
): MostPreciseMatchResult {
  if (ephs.length === 0) {
    throw new Error("matchMostPreciseEphemeris: ephs vacío");
  }
  // queryJd = centro de la ventana. Para ventanas muy estrechas esto
  // coincide prácticamente con cualquier punto interior.
  const queryJd = (startJd + endJd) / 2;
  const picked = pickMostPreciseEphemeris(ephs, queryJd);

  // Calculamos la predicción con la efeméride elegida. Usamos
  // `transitsInWindow` para saber si está dentro; si no, `findNearest`
  // para devolver el "near miss".
  const inWindow = transitsInWindow(picked, startJd, endJd);
  if (inWindow.length > 0) {
    return { picked, transit: inWindow[0], found: true };
  }
  const nearest = findNearest(picked, startJd, endJd);
  if (!nearest) {
    // Efeméride inválida (pl_orbper <= 0). Imposible en la práctica
    // porque `pickMostPreciseEphemeris` ya la filtra, pero por si
    // acaso. Devolvemos un TransitHit "vacío" en n=0.
    const midJd = picked.pl_tranmid;
    return {
      picked,
      transit: {
        pl_name: picked.pl_name,
        hostname: picked.hostname,
        midtimeJd: midJd,
        midtimeUtc: jdToUtcIso(midJd),
        midtimeIso: jdToUtcIso(midJd),
        period: picked.pl_orbper,
        duration: picked.pl_trandur ?? undefined,
        uncertaintyJd: 0,
        reference: stripHtml(picked.pl_refname),
        offsetMin: 0,
      },
      found: false,
    };
  }
  return { picked, transit: nearest, found: false };
}
