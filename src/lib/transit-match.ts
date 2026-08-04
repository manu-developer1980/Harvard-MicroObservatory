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
  pl_orbper: number;             // días
  /**
   * Incertidumbre +1σ del periodo, en días. PUEDE ser null en la
   * tabla `ps` de NASA: hay entradas (p.ej. Stassun 2017 para
   * WASP-67 b) con P pero sin σ_P. Tratar null como 0 da ventaja
   * indebida a esas efemérides en el cómputo de σ(t_n); lo
   * correcto es considerar la incertidumbre como DESCONOCIDA
   * (= Infinity), no nula.
   */
  pl_orbpererr1: number | null;
  /**
   * BJD del tránsito de referencia. PUEDE ser null (p.ej. Mancini
   * 2014 para WASP-67 b tiene P=4.61 sin t_0). Sin t_0 no se
   * puede predecir ningún tránsito: `transitsInWindow` y
   * `findNearest` lo filtran.
   */
  pl_tranmid: number | null;
  /** Incertidumbre +1σ de t_0 (días). null si falta. */
  pl_tranmiderr1: number | null;
  /** Incertidumbre -1σ de t_0 (días). null si falta. */
  pl_tranmiderr2: number | null;
  pl_trandur?: number | null;     // horas (null si falta)
  pl_refname?: string;           // referencia bibliográfica (HTML)
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
 *
 * Importante sobre campos null/undefined:
 *   La tabla `ps` de NASA puede tener `pl_tranmid`, `pl_orbpererr1`,
 *   etc. como `null` para entradas con datos parciales (p.ej. Mancini
 *   2014 para WASP-67 b: tiene P=4.61 pero sin t_0 ni σ_P; Stassun
 *   2017: tiene P=4.61442 con σ_P pero sin t_0). NO tratamos esos
 *   nulos como 0, porque 0 = "incertidumbre nula" (predicción
 *   perfecta) y haría que esas efemérides ganaran el ranking
 *   "most precise" de forma falsa. Una incertidumbre desconocida
 *   es INFINITA, no 0. Devolvemos `Infinity` en esos casos para
 *   que `pickMostPreciseEphemeris` las descarte.
 */
export function propagatedUncertainty(
  eph: Pick<PlanetEph, "pl_tranmiderr1" | "pl_tranmiderr2" | "pl_orbpererr1">,
  n: number,
): number {
  const t1 = eph.pl_tranmiderr1;
  const t2 = eph.pl_tranmiderr2;
  const p = eph.pl_orbpererr1;
  // Si CUALQUIER componente falta, la incertidumbre es desconocida
  // (infinita). No es 0.
  if (t1 == null || t2 == null || p == null) return Infinity;
  const sigmaT0 = Math.max(Math.abs(t1), Math.abs(t2));
  return Math.sqrt(sigmaT0 * sigmaT0 + (n * p) * (n * p));
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
  // Sin t_0 no podemos calcular n*P. NASA devuelve null en
  // `pl_tranmid` para efemérides con datos parciales (caso real:
  // Stassun 2017 / Mancini 2014 en WASP-67 b). Devolvemos [] para
  // que no afecte al matching.
  if (eph.pl_tranmid == null || eph.pl_orbper <= 0) return [];
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
  // Misma guarda que transitsInWindow: sin t_0 no podemos iterar.
  if (eph.pl_tranmid == null || eph.pl_orbper <= 0) return null;
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

  // Filtro previo: descartamos efemérides con datos incompletos
  // (NASA devuelve null en `pl_tranmid`, `pl_orbpererr1`, etc. para
  // entradas parciales — caso real: WASP-67 b tiene Stassun 2017 y
  // Mancini 2014 con t_0 = null). Sin este filtro, una efeméride
  // con t_0 null pasaba a "best" porque `propagatedUncertainty`
  // devolvía 0 (null → 0) y todas las demás σ > 0. Ahora
  // `propagatedUncertainty` devuelve `Infinity` para nulls, pero
  // ser explícitos aquí también es defensa en profundidad.
  const valid = ephs.filter(
    (e) =>
      e.pl_orbper > 0 &&
      e.pl_tranmid != null &&
      e.pl_orbpererr1 != null,
  );
  // Si TODAS son inválidas (caso extremo), caemos a la primera del
  // array original. El caller (matchMostPreciseEphemeris) maneja
  // el resultado vacío.
  const candidates = valid.length > 0 ? valid : ephs;

  let best: PlanetEph = candidates[0];
  let bestSigma = Infinity;
  for (const eph of candidates) {
    if (eph.pl_orbper <= 0) continue;
    if (eph.pl_tranmid == null) continue; // defensa redundante
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
 * Caso WASP-67 b 2026-07-29 (regresión resuelta, ago-2026): la
 * tabla `ps` de NASA tiene 8 efemérides para WASP-67 b, dos de
 * ellas con `pl_tranmid = null` y/o `pl_orbpererr1 = null`
 * (Stassun 2017 y Mancini 2014). Antes del fix,
 * `propagatedUncertainty` trataba los null como 0, dando σ = 0
 * para esas dos → se elegían como "most precise" con σ=0, pero
 * al no tener t_0 el matching daba un "nearest" en 20:09:36 UTC
 * (10h después del fin) y `found: false`. Tras el fix, los nulls
 * devuelven `Infinity` en `propagatedUncertainty` y esas dos se
 * filtran en `pickMostPreciseEphemeris`. La "most precise" real
 * es Kokori 2022 con σ ≈ 4.1e-4 d, que predice 10:16:16 UTC —
 * DENTRO de la ventana del usuario (08:10:10 → 10:30:15). Ver
 * `transit-match.test.ts` (suite "WASP-67 b REAL ephemerides").
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
  let picked = pickMostPreciseEphemeris(ephs, queryJd);

  // Defensa: si la "picked" sigue siendo inválida (caso extremo:
  // TODAS las efemérides tienen t_0 o σ_P null), caemos a la
  // primera que tenga t_0 no-null para poder al menos calcular
  // "nearest" — aunque la predicción será muy mala, es mejor que
  // un TransitHit con midJd=null. Si tampoco hay, lanzamos un
  // error claro.
  if (picked.pl_tranmid == null) {
    const fallback = ephs.find((e) => e.pl_tranmid != null);
    if (!fallback) {
      throw new Error(
        "matchMostPreciseEphemeris: ninguna efeméride tiene pl_tranmid válido",
      );
    }
    picked = fallback;
  }

  // Calculamos la predicción con la efeméride elegida. Usamos
  // `transitsInWindow` para saber si está dentro; si no, `findNearest`
  // para devolver el "near miss".
  const inWindow = transitsInWindow(picked, startJd, endJd);
  if (inWindow.length > 0) {
    return { picked, transit: inWindow[0], found: true };
  }
  const nearest = findNearest(picked, startJd, endJd);
  if (!nearest) {
    // Defensa final: si llegamos aquí, picked.pl_tranmid es no-null
    // (por la guarda anterior) pero findNearest devolvió null. No
    // debería pasar, pero por si acaso devolvemos un TransitHit con
    // la t_0 cruda como midpoint (no ideal pero no rompe la UI).
    const midJd = picked.pl_tranmid as number;
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

// ---------------------------------------------------------------------------
// Normalización de nombres de planeta para matching contra NASA ps table
// ---------------------------------------------------------------------------

/**
 * Variantes del nombre del target que se prueban contra la tabla `ps`
 * de NASA Exoplanet Archive. La idea es cubrir las diferencias de
 * formato entre cómo escribe el usuario (o el desplegable de MO) y el
 * `hostname` canónico de NASA.
 *
 * Casos reales (verificados contra NASA, ago-2026):
 *   - "KELT-23A"  (MO)  → NASA "KELT-23 A"  (con espacio, sistema binario)
 *   - "TOI1516"   (MO)  → NASA "TOI-1516"   (con guion entre prefijo y número)
 *   - "TOI 4145"  (MO)  → NASA "TOI-4145"   (guion en vez de espacio)
 *   - "WASP-135"  (MO)  → NASA "WASP-135"   (idéntico, no necesita nada)
 *   - "WASP-12 b" (MO)  → NASA "WASP-12 b"  (idéntico)
 *
 * Estrategia: el endpoint intenta primero el input literal, luego cada
 * variante. Devolvemos un array en orden de prioridad (input primero,
 * luego variantes). La consulta para en cuanto una variante devuelve
 * ≥1 fila. Si ninguna matchea, se devuelve [] y el endpoint marca
 * "target not found" como antes.
 *
 * Las transformaciones son:
 *   1. WS→hyphen           "TOI 4145"      → "TOI-4145"
 *   2. prefix→hyphen        "TOI1516"       → "TOI-1516"
 *   3. number→space-letter  "KELT-23A"      → "KELT-23 A"
 *   4. Combinación 1+2+3    "TOI 4145A"     → "TOI-4145 A"
 *
 * Caso ya correcto (regresión): "WASP-135 b" sigue matcheando a la
 * primera porque el input literal está en la lista.
 */
export function normalizeTargetForNasa(input: string): string[] {
  const candidates = new Set<string>();
  const trim = input.trim();
  if (!trim) return [];

  candidates.add(trim);

  // (1) Whitespace → hyphen. "TOI 4145" → "TOI-4145", "LHS 1140" → "LHS-1140".
  candidates.add(trim.replace(/\s+/g, "-"));

  // (2) Insertar guion entre el prefijo de letras y el primer dígito,
  //     tolerando separadores existentes (espacio, guion o nada).
  //     "TOI1516" → "TOI-1516", "TOI 1516" → "TOI-1516",
  //     "TOI-1516" → "TOI-1516" (idempotente).
  candidates.add(
    trim.replace(/^([A-Za-z]+)[^\dA-Za-z]*(\d)/, "$1-$2"),
  );

  // (3) Insertar espacio entre el último dígito y la letra final
  //     (sufijo de componente binario en NASA: "KELT-23 A").
  //     "KELT-23A" → "KELT-23 A", "KELT-23 A" → "KELT-23 A" (idempotente).
  candidates.add(trim.replace(/(\d)([A-Z][a-z]?)$/, "$1 $2"));

  // (4) Las tres transformaciones combinadas (cubre entradas con
  //     múltiples desviaciones: "TOI 4145A" → "TOI-4145 A").
  candidates.add(
    trim
      .replace(/\s+/g, "-")
      .replace(/^([A-Za-z]+)[^\dA-Za-z]*(\d)/, "$1-$2")
      .replace(/(\d)([A-Z][a-z]?)$/, "$1 $2"),
  );

  return Array.from(candidates);
}
