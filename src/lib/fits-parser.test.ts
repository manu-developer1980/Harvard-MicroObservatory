/**
 * Test E2E del parser FITS: generamos un FITS sintético en memoria
 * y lo parseamos. Sirve como sanity check de que el parser maneja
 * los formatos típicos de MicroObservatory (BITPIX 16, imagen 2D
 * con BZERO/BSCALE).
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { parseFits, FitsParseError } from "@/lib/fits-parser";
import { stretchImage, computeStretchBounds } from "@/lib/fits-stretch";

const RECORD_SIZE = 80;
const BLOCK_SIZE = 2880;

/** Genera un FITS sintético en memoria. */
function makeFits(opts: {
  width: number;
  height: number;
  bitpix: number;
  bzero?: number;
  bscale?: number;
  object?: string;
  data?: Int16Array;
}): Buffer {
  const { width, height, bitpix } = opts;
  const bzero = opts.bzero ?? 0;
  const bscale = opts.bscale ?? 1;
  // Header: 8 records mínimo, padded a 2880 bytes.
  const header = Buffer.alloc(BLOCK_SIZE);
  const writeRec = (i: number, kw: string, value: string, comment = "") => {
    const start = i * RECORD_SIZE;
    // Keyword (8 chars padded)
    header.write(kw.padEnd(8, " "), start, 8, "ascii");
    header.write("= ", start + 8, 2, "ascii");
    // Value field: cols 11-30 = 20 chars. Numéricos: right-justified.
    // Strings: ' value padded     '.
    const valStr = value.startsWith("'")
      ? value.padEnd(20, " ")
      : value.padStart(20, " ");
    header.write(valStr, start + 10, 20, "ascii");
    if (comment) {
      // Comment ocupa cols 32-80 (50 bytes) con prefijo " / "
      header.write(" / " + comment.slice(0, 47), start + 30, 50, "ascii");
    }
  };
  let i = 0;
  writeRec(i++, "SIMPLE", "T", "standard FITS");
  writeRec(i++, "BITPIX", String(bitpix), "8/16/32/64 signed, -32 float");
  writeRec(i++, "NAXIS", "2", "number of axes");
  writeRec(i++, "NAXIS1", String(width), "axis length");
  writeRec(i++, "NAXIS2", String(height), "axis length");
  if (bzero !== 0) writeRec(i++, "BZERO", String(bzero), "offset");
  if (bscale !== 1) writeRec(i++, "BSCALE", String(bscale), "scale");
  if (opts.object) writeRec(i++, "OBJECT", `'${opts.object.padEnd(8, " ")}'`, "target");
  writeRec(i++, "END", "", "");
  // Datos: array por defecto es un gradiente 0..(w*h-1) en Int16
  const dataBytes = width * height * Math.abs(bitpix / 8);
  let dataBuf: Buffer;
  if (bitpix === 16) {
    const arr = opts.data ?? new Int16Array(width * height);
    if (!opts.data) {
      for (let k = 0; k < arr.length; k++) arr[k] = k;
    }
    dataBuf = Buffer.alloc(arr.length * 2);
    for (let k = 0; k < arr.length; k++) {
      dataBuf.writeInt16BE(arr[k]!, k * 2);
    }
  } else {
    dataBuf = Buffer.alloc(dataBytes);
  }
  return Buffer.concat([header, dataBuf]);
}

describe("parseFits: FITS sintético", () => {
  it("parsea un FITS 2D de 4x4 con BITPIX=16 y gradiente lineal", () => {
    const buf = makeFits({
      width: 4,
      height: 4,
      bitpix: 16,
      data: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    });
    const img = parseFits(buf);
    expect(img.width).toBe(4);
    expect(img.height).toBe(4);
    expect(img.data.length).toBe(16);
    expect(img.data[0]).toBe(0);
    expect(img.data[15]).toBe(15);
  });

  it("aplica BZERO=100 y BSCALE=0.5 a los valores raw", () => {
    // raw=0 → 100 + 0.5*0 = 100
    // raw=10 → 100 + 0.5*10 = 105
    const buf = makeFits({
      width: 2,
      height: 2,
      bitpix: 16,
      bzero: 100,
      bscale: 0.5,
      data: new Int16Array([0, 10, 20, 30]),
    });
    const img = parseFits(buf);
    expect(img.data[0]).toBe(100);
    expect(img.data[1]).toBe(105);
    expect(img.data[2]).toBe(110);
    expect(img.data[3]).toBe(115);
  });

  it("parsea OBJECT del header", () => {
    const buf = makeFits({
      width: 2,
      height: 2,
      bitpix: 16,
      object: "WASP-2",
    });
    const img = parseFits(buf);
    expect(img.header.object).toBe("WASP-2");
  });

  it("lanza FitsParseError si BITPIX=0", () => {
    // Forzamos un header sin BITPIX usando Buffer directo
    const header = Buffer.alloc(BLOCK_SIZE);
    header.write("END".padEnd(80, " "), 0, "ascii");
    const buf = Buffer.concat([header, Buffer.alloc(4)]);
    expect(() => parseFits(buf)).toThrow(FitsParseError);
  });

  it("lanza FitsParseError si NAXIS != 2", () => {
    const header = Buffer.alloc(BLOCK_SIZE);
    const kw = (i: number, name: string, val: string) => {
      const start = i * RECORD_SIZE;
      header.write(name.padEnd(8, " "), start, 8, "ascii");
      header.write("= ", start + 8, 2, "ascii");
      header.write(val.padStart(20, " "), start + 10, 20, "ascii");
    };
    kw(0, "SIMPLE", "T");
    kw(1, "BITPIX", "16");
    kw(2, "NAXIS", "3");
    kw(3, "NAXIS1", "4");
    kw(4, "NAXIS2", "4");
    kw(5, "NAXIS3", "4");
    header.write("END".padEnd(80, " "), 6 * RECORD_SIZE, "ascii");
    const buf = Buffer.concat([header, Buffer.alloc(4 * 4 * 4 * 2)]);
    expect(() => parseFits(buf)).toThrow(FitsParseError);
  });

  it("lanza FitsParseError si FITS truncado", () => {
    const buf = makeFits({ width: 4, height: 4, bitpix: 16 });
    // Cortamos el buffer a la mitad
    const trunc = buf.subarray(0, buf.length / 2);
    expect(() => parseFits(trunc)).toThrow(FitsParseError);
  });

  it("rechaza un buffer demasiado pequeño", () => {
    const tiny = Buffer.alloc(100);
    expect(() => parseFits(tiny)).toThrow(FitsParseError);
  });
});

describe("stretch: asinh/log/linear sobre datos sintéticos", () => {
  it("linear mapea [0, 100] a [0, 255]", () => {
    const data = new Float64Array([0, 25, 50, 75, 100]);
    const out = stretchImage(data, {
      kind: "linear",
      lowPercentile: 0,
      highPercentile: 100,
    });
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(255);
    expect(out[2]).toBeGreaterThan(120);
    expect(out[2]).toBeLessThan(135);
  });

  it("asinh preserva contraste en rango amplio [0, 1e6]", () => {
    // Datos con un outlier grande. asinh NO debe saturar la zona baja.
    const data = new Float64Array([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1_000_000,
    ]);
    const out = stretchImage(data, { kind: "asinh" });
    // Los valores bajos (0..1000) deben ocupar un rango razonable
    // del output, no quedar todos en 0.
    const out1000 = out[10]!;
    const out0 = out[0]!;
    expect(out1000).toBeGreaterThan(out0);
    expect(out1000).toBeLessThan(255);
  });

  it("log comprime el rango [0, 1e6] de forma monótona", () => {
    const data = new Float64Array([0, 100, 1000, 10000, 100000, 1000000]);
    const out = stretchImage(data, { kind: "log" });
    // La salida debe ser monótona creciente
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
    }
    expect(out[out.length - 1]).toBe(255);
  });

  it("computeStretchBounds ignora NaN/Inf", () => {
    const data = new Float64Array([1, 2, NaN, 3, Infinity, 4, -Infinity, 5]);
    const { lo, hi } = computeStretchBounds(data, 0, 100);
    expect(lo).toBe(1);
    expect(hi).toBe(5);
  });
});
