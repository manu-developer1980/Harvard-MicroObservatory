/**
 * GET /api/fits/[file]
 *
 * Proxy de un FITS desde mo-www.cfa.harvard.edu a nuestro dominio.
 * Aplica CORS allowlist (no `*`) para evitar uso abusivo como proxy
 * abierto, y maneja errores de MO.
 */
import type { APIRoute } from "astro";
import { t, getReqLang } from "@/lib/i18n";
import { resolveAllowedOrigin } from "@/lib/cors";

export const prerender = false;

const MO_FITS_BASE = "https://mo-www.cfa.harvard.edu/ImageDirectory/";

/** Cabeceras CORS para el response, basadas en la allowlist.
 *  Si el origin no está permitido, NO emitimos `Access-Control-Allow-Origin`
 *  (el navegador bloqueará el cross-origin XHR). SIEMPRE emitimos
 *  `Vary: Origin` para que la CDN no mezcle respuestas cacheadas de
 *  distintos orígenes. */
function corsHeaders(request: Request): Record<string, string> {
  const allow = resolveAllowedOrigin(request, {
    allowedOrigins: import.meta.env.ALLOWED_FITS_ORIGINS,
    isDev: import.meta.env.DEV,
  });
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Vary siempre: imprescindible para que la CDN no sirva a un
    // origen la respuesta cacheada para otro.
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

export const GET: APIRoute = async ({ params, request }) => {
  const lang = getReqLang(request);
  const file = params.file;
  if (!file) return bad(request, t("error.missingFileParam", lang));
  if (typeof file !== "string")
    return bad(request, t("error.invalidFileParam", lang));
  if (!/^[A-Za-z0-9._\-]+\.FITS$/.test(file)) {
    return bad(request, t("error.invalidFilename", lang), 400);
  }

  const url = MO_FITS_BASE + file;
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "mo-downloader-web/0.1 (Netlify proxy)" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!upstream.ok || !upstream.body) {
      return bad(
        request,
        t("error.moStatus", lang, { status: upstream.status }),
        502,
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/fits",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders(request),
      },
    });
  } catch (err) {
    return bad(
      request,
      t("error.fetchFits", lang, {
        msg: err instanceof Error ? err.message : "?",
      }),
      502,
    );
  }
};

export const OPTIONS: APIRoute = async ({ request }) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
};
