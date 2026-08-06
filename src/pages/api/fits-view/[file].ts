/**
 * GET /api/fits-view/[file]?stretch=asinh&low=0.5&high=99.5
 *
 * Descarga un FITS de MicroObservatory, lo parsea, aplica un stretch
 * y devuelve un PNG de 8 bits con los metadatos principales en
 * cabeceras HTTP. La imagen se cachea 1 día en la CDN.
 *
 * Diferencia con `/api/fits/[file]`:
 *   - `/api/fits/[file]` proxy crudo (para descarga). El cliente
 *     recibe los bytes originales.
 *   - `/api/fits-view/[file]` proxy procesado. El cliente recibe
 *     un PNG listo para `<img src>`.
 *
 * El procesamiento se hace en el backend (no en el cliente) por:
 *   1. Compatibilidad cross-browser (no requiere WebGL/Canvas).
 *   2. No exponer el bundle del parser FITS al cliente.
 *   3. Permitir caché CDN agresivo (1 día, el FITS no cambia).
 *
 * El bundle solo añade `pngjs` (pequeño, sin deps nativas) — la
 * alternativa `sharp` sería más rápida pero requiere binarios
 * nativos y complica el deploy.
 *
 * Formato del response:
 *   - Content-Type: image/png
 *   - X-Fits-Metadata: <JSON URL-encoded con header FITS relevante>
 *     (cabecera custom porque no podemos devolver JSON + imagen en
 *     un solo response; el cliente hace una segunda request al
 *     endpoint ?meta=1 si quiere solo los metadatos).
 *
 * Si el FITS no encaja en el subconjunto soportado por el parser
 * (e.g. data cube 3D, Rice compression), devolvemos 422 con un
 * mensaje descriptivo.
 */
import type { APIRoute } from "astro";
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";
import { parseFits, FitsParseError } from "@/lib/fits-parser";
import { stretchImage, type StretchKind } from "@/lib/fits-stretch";
import { t, getReqLang } from "@/lib/i18n";
import { resolveAllowedOrigin } from "@/lib/cors";

export const prerender = false;

const MO_FITS_BASE = "https://mo-www.cfa.harvard.edu/ImageDirectory/";

function corsHeaders(request: Request): Record<string, string> {
  const allow = resolveAllowedOrigin(request, {
    allowedOrigins: import.meta.env.ALLOWED_FITS_ORIGINS,
    isDev: import.meta.env.DEV,
  });
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = allow;
  return headers;
}

function bad(
  request: Request,
  msg: string,
  status = 400,
): Response {
  return new Response(msg, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(request),
    },
  });
}

function fitsToPng(
  fits: { data: Float64Array; width: number; height: number },
  stretchKind: StretchKind,
): Buffer {
  const stretched = stretchImage(fits.data, { kind: stretchKind });
  const png = new PNG({ width: fits.width, height: fits.height });
  // pngjs espera RGBA: 4 bytes por píxel. Asignamos los 3 canales
  // con el mismo valor (gris) y alpha=255 (opaco).
  for (let i = 0; i < stretched.length; i++) {
    const v = stretched[i]!;
    const j = i * 4;
    png.data[j] = v;
    png.data[j + 1] = v;
    png.data[j + 2] = v;
    png.data[j + 3] = 255;
  }
  return PNG.sync.write(png);
}

export const GET: APIRoute = async ({ params, request, url }) => {
  const lang = getReqLang(request);
  const file = params.file;
  if (!file || typeof file !== "string") {
    return bad(request, t("error.missingFileParam", lang));
  }
  if (!/^[A-Za-z0-9._\-]+\.FITS$/.test(file)) {
    return bad(request, t("error.invalidFilename", lang), 400);
  }

  // Query params. Default: asinh (estándar astronomía).
  const stretchKind = (url.searchParams.get("stretch") ?? "asinh") as StretchKind;
  if (stretchKind !== "asinh" && stretchKind !== "log" && stretchKind !== "linear") {
    return bad(request, `stretch inválido: ${stretchKind}`, 400);
  }
  const metaOnly = url.searchParams.get("meta") === "1";

  const upstream = await fetch(MO_FITS_BASE + file, {
    headers: { "User-Agent": "mo-downloader-web/0.1 (Netlify FITS viewer)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!upstream.ok) {
    return bad(
      request,
      t("error.moStatus", lang, { status: upstream.status }),
      502,
    );
  }
  const arrayBuf = await upstream.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  let fits;
  try {
    fits = parseFits(buf);
  } catch (err) {
    if (err instanceof FitsParseError) {
      return bad(request, `FITS inválido: ${err.message}`, 422);
    }
    return bad(
      request,
      err instanceof Error ? err.message : String(err),
      500,
    );
  }

  // Modo "meta only": devolvemos solo los metadatos como JSON.
  // Útil para previsualizar la cabecera sin tener que descargar
  // y procesar toda la imagen (especialmente con Netlify
  // Functions que tienen 6MB de payload limit).
  if (metaOnly) {
    const meta = {
      ok: true,
      file,
      width: fits.width,
      height: fits.height,
      bitpix: fits.header.bitpix,
      bzero: fits.header.bzero,
      bscale: fits.header.bscale,
      object: fits.header.object,
      telescope: fits.header.telescope,
      filter: fits.header.filter,
      exptime: fits.header.exptime,
      dateObs: fits.header.dateObs,
      // Min/max stats del array físico (tras BZERO/BSCALE) para
      // que la UI pueda mostrar el rango dinámico sin tener
      // que recibir los píxeles.
      stats: computeStats(fits.data),
    };
    return new Response(JSON.stringify(meta), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders(request),
      },
    });
  }

  // Modo "full": PNG + metadatos en cabecera X-Fits-Metadata.
  const png = fitsToPng(fits, stretchKind);
  const meta = {
    width: fits.width,
    height: fits.height,
    bitpix: fits.header.bitpix,
    object: fits.header.object,
    telescope: fits.header.telescope,
    filter: fits.header.filter,
    exptime: fits.header.exptime,
    dateObs: fits.header.dateObs,
    stretch: stretchKind,
    stats: computeStats(fits.data),
  };
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Fits-Metadata": encodeURIComponent(JSON.stringify(meta)),
      ...corsHeaders(request),
    },
  });
};

function computeStats(data: Float64Array): {
  min: number;
  max: number;
  mean: number;
} {
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    n++;
  }
  return {
    min: n === 0 ? 0 : mn,
    max: n === 0 ? 0 : mx,
    mean: n === 0 ? 0 : sum / n,
  };
}

export const OPTIONS: APIRoute = async ({ request }) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
};
