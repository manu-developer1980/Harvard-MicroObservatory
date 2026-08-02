/**
 * GET /api/fits/[file]
 *
 * Proxy de un FITS desde mo-www.cfa.harvard.edu a nuestro dominio.
 * Añade cabeceras CORS y maneja errores de MO.
 *
 * Esto evita que el navegador sufra restricciones CORS al descargar
 * directamente desde otro origen.
 */
import type { APIRoute } from "astro";

export const prerender = false;

const MO_FITS_BASE = "https://mo-www.cfa.harvard.edu/ImageDirectory/";

function bad(msg: string, status = 400): Response {
  return new Response(msg, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const GET: APIRoute = async ({ params }) => {
  const file = params.file;
  if (!file) return bad("Falta parámetro 'file'");
  if (typeof file !== "string") return bad("Parámetro 'file' inválido");
  if (!/^[A-Za-z0-9._\-]+\.FITS$/.test(file)) {
    return bad("Nombre de archivo no válido", 400);
  }

  const url = MO_FITS_BASE + file;
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "mo-downloader-web/0.1 (Netlify proxy)" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!upstream.ok || !upstream.body) {
      return bad(`MO devolvió ${upstream.status}`, 502);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/fits",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    return bad(`Error al obtener FITS: ${err instanceof Error ? err.message : "?"}`, 502);
  }
};

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};
