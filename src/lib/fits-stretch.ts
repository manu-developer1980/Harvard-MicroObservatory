/**
 * Funciones de "stretch" para visualizar imágenes FITS de astronomía.
 *
 * Una imagen FITS en bruto tiene un rango dinámico enorme (típicamente
 * 14-16 bits = 0..65535 counts) con la mayor parte de la información
 * concentrada en una pequeña franja de valores. Mostrar el array
 * de píxeles tal cual en una pantalla de 8 bits (0..255) desperdicia
 * la mayoría de los píxeles: salen todos negros o todos blancos.
 *
 * El "stretch" es una función monótona creciente que mapea el rango
 * dinámico del FITS a [0, 255] de forma que las features astronómicas
 * (estrellas, tránsito, fondo de cielo) sean visibles.
 *
 * Tres flavours implementadas:
 *   - `linear`: identidad mapeada al rango [min, max]. Útil para
 *     imágenes bien expuestas donde el histograma es uniforme.
 *   - `log`:   log(1 + x) - log(1 + min). Resalta zonas oscuras
 *     (estrellas débiles) pero satura las brillantes.
 *   - `asinh`: arcsinh(x / scale). El estándar de facto en
 *     astronomía profesional (e.g. SDSS, Hubble). Preserva el
 *     contraste en TODO el rango dinámico, sin saturar ni en
 *     las zonas brillantes ni en las oscuras. Es el default.
 *
 * Las funciones son PURAS: no leen del FITS directamente, reciben
 * un Float64Array y devuelven Uint8Array. Esto permite testearlas
 * sin I/O.
 *
 * El `percentileClip` previo al stretch descarta outliers (e.g. rayos
 * cósmicos que saturan 1-2 píxeles) que de otro modo comprimirían
 * todo el stretch a un blanco plano.
 */
export type StretchKind = "linear" | "log" | "asinh";

export type StretchOptions = {
  /** Tipo de stretch. Default "asinh" (recomendado). */
  kind?: StretchKind;
  /** Percentiles bajo/alto para clipping. Default [0.5, 99.5]. */
  lowPercentile?: number;
  highPercentile?: number;
  /** Parámetro de softening para asinh. Default 10000. Cuanto
   *  mayor, más lineal; cuanto menor, más contraste en zonas oscuras. */
  asinhScale?: number;
};

/** Devuelve el percentil p (0..100) de un array ya ordenado. */
function percentileSorted(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const t = idx - lo;
  return sorted[lo]! * (1 - t) + sorted[hi]! * t;
}

/** Calcula low/high del array tras clipping por percentiles. */
export function computeStretchBounds(
  data: Float64Array,
  lowPct: number,
  highPct: number,
): { lo: number; hi: number } {
  // Filtramos NaN/Inf que aparecen en zonas defectuosas del CCD
  // y que no deben contar para el histograma.
  const clean: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isFinite(v)) clean.push(v);
  }
  if (clean.length === 0) return { lo: 0, hi: 1 };
  // Para percentiles no hace falta un sort completo, pero para
  // arrays pequeños (~1M píxeles) el sort es despreciable. Para
  // arrays más grandes, considerar quickselect, pero no es el
  // cuello de botella actual.
  const sorted = Float64Array.from(clean).sort();
  return {
    lo: percentileSorted(sorted, lowPct),
    hi: percentileSorted(sorted, highPct),
  };
}

/** Stretch lineal: identity mapeada a [lo, hi] -> [0, 255]. */
function stretchLinear(
  data: Float64Array,
  lo: number,
  hi: number,
): Uint8Array {
  const out = new Uint8Array(data.length);
  const range = hi - lo;
  if (range <= 0) {
    // Imagen plana (sin rango). Devolvemos gris medio.
    out.fill(128);
    return out;
  }
  const invRange = 255 / range;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) {
      out[i] = 0;
      continue;
    }
    let norm = (v - lo) * invRange;
    if (norm < 0) norm = 0;
    else if (norm > 255) norm = 255;
    out[i] = Math.round(norm);
  }
  return out;
}

/** Stretch logarítmico: realza sombras pero satura luces. */
function stretchLog(
  data: Float64Array,
  lo: number,
  hi: number,
): Uint8Array {
  // log(1 + x - lo) / log(1 + hi - lo) * 255
  // Asumimos lo >= 0 (típico en FITS de CCD). Si lo < 0,
  // sumamos -lo antes del log para evitar log de negativos.
  const shift = lo < 0 ? -lo : 0;
  const denom = Math.log1p(hi - lo + shift);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) {
      out[i] = 0;
      continue;
    }
    const norm = Math.log1p(v - lo + shift) / denom;
    const clamped = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    out[i] = Math.round(clamped * 255);
  }
  return out;
}

/** Stretch asinh: contraste uniforme en todo el rango. */
function stretchAsinh(
  data: Float64Array,
  lo: number,
  hi: number,
  scale: number,
): Uint8Array {
  // arcsinh((x - lo) / scale) / arcsinh((hi - lo) / scale) * 255
  const range = hi - lo;
  if (range <= 0 || scale <= 0) {
    return stretchLinear(data, lo, hi);
  }
  const denom = Math.asinh(range / scale);
  if (denom === 0) {
    return stretchLinear(data, lo, hi);
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) {
      out[i] = 0;
      continue;
    }
    const norm = Math.asinh((v - lo) / scale) / denom;
    const clamped = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    out[i] = Math.round(clamped * 255);
  }
  return out;
}

/**
 * Aplica el stretch seleccionado al array físico y devuelve
 * Uint8Array de 0..255 listo para meter en un PNG.
 */
export function stretchImage(
  data: Float64Array,
  opts: StretchOptions = {},
): Uint8Array {
  const kind = opts.kind ?? "asinh";
  const lowPct = opts.lowPercentile ?? 0.5;
  const highPct = opts.highPercentile ?? 99.5;
  const asinhScale = opts.asinhScale ?? 10000;
  const { lo, hi } = computeStretchBounds(data, lowPct, highPct);
  switch (kind) {
    case "linear":
      return stretchLinear(data, lo, hi);
    case "log":
      return stretchLog(data, lo, hi);
    case "asinh":
      return stretchAsinh(data, lo, hi, asinhScale);
  }
}
