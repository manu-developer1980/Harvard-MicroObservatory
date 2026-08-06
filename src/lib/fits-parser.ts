/**
 * Parser FITS (Flexible Image Transport System) para Node.js.
 *
 * Implementación MÍNIMA enfocada al caso de uso del proyecto:
 * imágenes 2D de MicroObservatory en formato FITS estándar.
 * No soporta Rice compression, binary tables ni data cubes
 * (no los necesitamos para las capturas de exoplanetas).
 *
 * Formato FITS referencia:
 *   https://heasarc.gsfc.nasa.gov/docs/fits/standard/fits_standard.pdf
 *
 * Estructura básica:
 *   - Cada bloque HDU es múltiplo de 2880 bytes
 *   - El header son 80-char ASCII records:
 *     col 1-8   KEYWORD (e.g. "BITPIX ", "NAXIS  ", "END     ")
 *     col 9-10  "= "
 *     col 11-30 value
 *     col 32-80 comment
 *   - BITPIX: 8, 16, 32, 64 (unsigned) o -32, -64 (float/double)
 *   - NAXIS: número de dimensiones (típicamente 2 para imagen)
 *   - NAXIS1, NAXIS2: tamaño en cada dimensión
 *   - BZERO + BSCALE: physical_value = BZERO + BSCALE * raw_value
 *   - Datos binarios inmediatamente después del header, padded a
 *     2880-byte block boundary
 *
 * Esta función es PURA: dado un ArrayBuffer, devuelve los datos
 * parseados sin side effects. Testeable en aislamiento.
 *
 * Si el FITS no encaja en el subconjunto soportado, lanza
 * `FitsParseError` con un mensaje descriptivo. La capa de red
 * (endpoint) traduce eso a un HTTP 422.
 */
import { Buffer } from "node:buffer";

export class FitsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FitsParseError";
  }
}

export type FitsHeader = {
  bitpix: number;
  naxis: number;
  naxes: number[]; // NAXIS1, NAXIS2, ...
  bzero: number;
  bscale: number;
  object?: string;
  telescope?: string;
  filter?: string;
  exptime?: number;
  dateObs?: string;
  // Keywords FITS adicionales relevantes para astronomía, pasados tal
  // cual aparecen en el header. Útiles para mostrar en el visor
  // (RA, DEC, AIRMASS, etc.) sin tener que mapear cada uno.
  raw: Record<string, string>;
};

export type FitsImage = {
  header: FitsHeader;
  // Float array con valores físicos (después de aplicar BZERO/BSCALE).
  // Dimensiones: [NAXIS2][NAXIS1] (row-major).
  // El tipo siempre es `number` (float64) para que el stretch
  // (asinh/log/linear) pueda operar sin perder precisión.
  data: Float64Array;
  width: number;
  height: number;
};

const BLOCK_SIZE = 2880;
const RECORD_SIZE = 80;

/** Convierte bytes crudos a float físico aplicando BZERO/BSCALE.
 *  Acepta `Uint8Array` o `Buffer` (que también extiende Uint8Array). */
function rawToPhysical(
  raw: Uint8Array,
  bitpix: number,
  bzero: number,
  bscale: number,
): Float64Array {
  const bytesPerPixel = Math.abs(bitpix / 8);
  const n = Math.floor(raw.length / bytesPerPixel);
  const out = new Float64Array(n);
  // Para BITPIX positivo (enteros sin signo), los datos en el
  // archivo ya están en two's complement big-endian. Cuando
  // BITPIX=8 los valores son unsigned (0..255). Para BITPIX 16/32
  // los valores son signed, así que necesitamos el sign extension.
  switch (bitpix) {
    case 8: {
      for (let i = 0; i < n; i++) {
        out[i] = bzero + bscale * raw[i]!;
      }
      return out;
    }
    case 16: {
      const view = new DataView(raw.buffer, raw.byteOffset, n * 2);
      for (let i = 0; i < n; i++) {
        out[i] = bzero + bscale * view.getInt16(i * 2, false);
      }
      return out;
    }
    case 32: {
      const view = new DataView(raw.buffer, raw.byteOffset, n * 4);
      for (let i = 0; i < n; i++) {
        out[i] = bzero + bscale * view.getInt32(i * 4, false);
      }
      return out;
    }
    case 64: {
      // 64-bit signed integer (raro en astronomía amateur pero válido).
      // JavaScript no tiene BigInt-to-Float en DataView, usamos Number()
      // que puede perder precisión sobre 2^53, pero para datos
      // FITS típicos (counts de un CCD) los valores están lejos
      // de ese límite.
      const view = new DataView(raw.buffer, raw.byteOffset, n * 8);
      for (let i = 0; i < n; i++) {
        const hi = view.getInt32(i * 8, false);
        const lo = view.getUint32(i * 8 + 4, false);
        const big = BigInt(hi) * (1n << 32n) + BigInt(lo);
        out[i] = bzero + bscale * Number(big);
      }
      return out;
    }
    case -32: {
      const view = new DataView(raw.buffer, raw.byteOffset, n * 4);
      for (let i = 0; i < n; i++) {
        out[i] = bzero + bscale * view.getFloat32(i * 4, false);
      }
      return out;
    }
    case -64: {
      const view = new DataView(raw.buffer, raw.byteOffset, n * 8);
      for (let i = 0; i < n; i++) {
        out[i] = bzero + bscale * view.getFloat64(i * 8, false);
      }
      return out;
    }
    default:
      throw new FitsParseError(`BITPIX no soportado: ${bitpix}`);
  }
}

/** Parsea un header record de 80 chars y devuelve (keyword, rawValue, rawRecord). */
function parseHeaderRecord(record: string): [string, string, string] {
  // Formato canónico: "KEYWORD = VALUE / COMMENT"
  // Si no hay "=", todo el record es la keyword (e.g. "COMMENT ...",
  // "HISTORY ...", "END", "CONTINUE").
  const eqIdx = record.indexOf("=");
  const keyword = record.slice(0, 8).trim();
  if (keyword === "END") {
    return ["END", "", record];
  }
  if (eqIdx < 0) {
    return [keyword, "", record];
  }
  // El VALUE está en cols 11-30 (índice 10..29). Sacamos eso
  // limpiando espacios. Para strings (entre comillas), preservamos
  // el contenido.
  let valPart = record.slice(10, 30).trim();
  if (valPart.startsWith("'") && valPart.endsWith("'")) {
    // FITS strings: 'value padded with spaces     '
    valPart = valPart.slice(1, -1).trim();
  } else if (valPart.startsWith("'")) {
    // String que continúa en la siguiente record (continuación FITS).
    // Simplificación: cortamos en el próximo "'" que encontremos.
    valPart = valPart.slice(1);
  }
  return [keyword, valPart, record];
}

function parseHeader(buf: Uint8Array): FitsHeader {
  // El header es una secuencia de 80-char records ASCII. Cada
  // 36 records forman un bloque de 2880 bytes. Lo leemos en
  // bloques hasta encontrar la keyword END.
  const decoder = new TextDecoder("ascii");
  const text = decoder.decode(buf);
  const records: string[] = [];
  for (let i = 0; i + RECORD_SIZE <= text.length; i += RECORD_SIZE) {
    const rec = text.slice(i, i + RECORD_SIZE);
    records.push(rec);
    if (rec.startsWith("END     ")) {
      break;
    }
  }
  if (records.length === 0) {
    throw new FitsParseError("FITS vacío (sin header records)");
  }
  const raw: Record<string, string> = {};
  for (const rec of records) {
    const [kw, _val, rawRec] = parseHeaderRecord(rec);
    if (kw) raw[kw] = rawRec;
  }
  const getNum = (kw: string, dflt: number): number => {
    const rec = raw[kw];
    if (!rec) return dflt;
    const eq = rec.indexOf("=");
    if (eq < 0) return dflt;
    const val = rec.slice(10, 30).trim().split("/")[0].trim();
    const n = Number(val);
    return Number.isFinite(n) ? n : dflt;
  };
  const getStr = (kw: string): string | undefined => {
    const rec = raw[kw];
    if (!rec) return undefined;
    const eq = rec.indexOf("=");
    if (eq < 0) return undefined;
    let val = rec.slice(10, 30).trim();
    if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1).trim();
    } else {
      val = val.split("/")[0].trim();
    }
    return val || undefined;
  };

  const bitpix = getNum("BITPIX", 0);
  if (bitpix === 0) {
    throw new FitsParseError("FITS sin BITPIX");
  }
  const naxis = getNum("NAXIS", 0);
  if (naxis === 0) {
    throw new FitsParseError("FITS sin NAXIS (no es una imagen)");
  }
  if (naxis !== 2) {
    // Permitimos NAXIS=3 solo si la 3ª dimensión es 1 (data cube
    // degenerado, a veces lo emiten algunos telescopios).
    const naxis3 = getNum("NAXIS3", 1);
    if (naxis !== 2 || naxis3 !== 1) {
      throw new FitsParseError(
        `Solo se soportan imágenes 2D (NAXIS=${naxis})`,
      );
    }
  }
  const naxes: number[] = [];
  for (let i = 1; i <= naxis; i++) {
    naxes.push(getNum(`NAXIS${i}`, 0));
  }
  if (naxes.some((n) => n <= 0)) {
    throw new FitsParseError(`NAXIS inválido: ${naxes.join("x")}`);
  }

  return {
    bitpix,
    naxis,
    naxes,
    bzero: getNum("BZERO", 0),
    bscale: getNum("BSCALE", 1),
    object: getStr("OBJECT"),
    telescope: getStr("TELESCOP"),
    filter: getStr("FILTER"),
    exptime: getNum("EXPTIME", NaN),
    dateObs: getStr("DATE-OBS"),
    raw,
  };
}

/** Devuelve el offset en bytes donde empiezan los datos (post-header). */
function dataOffset(header: Uint8Array): number {
  // El header termina en la keyword END. Los datos empiezan
  // inmediatamente después, alineados al siguiente múltiplo
  // de 2880 bytes.
  const decoder = new TextDecoder("ascii");
  const text = decoder.decode(header);
  for (let i = 0; i + RECORD_SIZE <= text.length; i += RECORD_SIZE) {
    if (text.slice(i, i + 8) === "END     ") {
      const endOfHeader = i + RECORD_SIZE;
      // Round up al siguiente bloque
      const blocks = Math.ceil(endOfHeader / BLOCK_SIZE);
      return blocks * BLOCK_SIZE;
    }
  }
  throw new FitsParseError("Header sin keyword END");
}

/**
 * Parsea un FITS completo desde un ArrayBuffer/Buffer/Uint8Array.
 * Lanza FitsParseError si el formato no encaja en el subconjunto
 * soportado.
 */
export function parseFits(input: Buffer | ArrayBuffer | Uint8Array): FitsImage {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Validación mínima: 2880 bytes (un bloque) + al menos 1 record.
  if (buf.length < BLOCK_SIZE) {
    throw new FitsParseError("FITS demasiado pequeño");
  }
  const header = parseHeader(buf);
  const off = dataOffset(buf);
  if (off >= buf.length) {
    throw new FitsParseError("FITS sin datos tras el header");
  }
  const width = header.naxes[0];
  const height = header.naxes[1];
  const expectedBytes = width * height * Math.abs(header.bitpix / 8);
  if (off + expectedBytes > buf.length) {
    throw new FitsParseError(
      `FITS truncado: esperados ${expectedBytes} bytes de datos, ` +
        `disponibles ${buf.length - off}`,
    );
  }
  // Sliceamos la sección de datos y aplicamos BZERO/BSCALE.
  // El subarray comparte el buffer del FITS (no copia memoria), así
  // que es eficiente incluso para imágenes de 10+ MB.
  const dataBytes = buf.subarray(off, off + expectedBytes);
  const data = rawToPhysical(
    new Uint8Array(
      dataBytes.buffer,
      dataBytes.byteOffset,
      dataBytes.byteLength,
    ),
    header.bitpix,
    header.bzero,
    header.bscale,
  );
  return { header, data, width, height };
}
