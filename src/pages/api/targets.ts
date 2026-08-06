// src/pages/api/targets.ts
// Devuelve la lista viva de exoplanetas disponibles en MicroObservatory,
// parseada en tiempo real del desplegable oficial de la página del archivo.
//
// Rango de fechas: el HTML de MO tiene un parámetro `SortRange` (10/20/30)
// que controla cuántos días hacia atrás muestra el desplegable. Por
// defecto (sin parámetro) MO devuelve solo 10 días, lo que deja fuera
// exoplanetas como HAT-P-19, HAT-P-27, KELT-20, Kepler-12, Qatar-4/6/9,
// etc. que tengan observaciones más antiguas. Pedimos `SortRange=30`
// (el máximo) para maximizar la cobertura. Si MO lo ignora o cambia
// el parámetro, el efecto es "solo" perder los targets más antiguos.
//
// Caché: ninguna a propósito. El endpoint es barato (~50 KB de HTML) y
// la UI lo refresca cada 60 s en memoria. Si MO añade/quita targets, los
// usuarios los ven al recargar o al cumplirse el intervalo.

import type { APIRoute } from "astro";
import * as cheerio from "cheerio";
import { t, getReqLang } from "@/lib/i18n";
import { isExoplanet, normalizeMoName } from "@/lib/targets";

const MO_URL =
  "https://waps.cfa.harvard.edu/microobservatory/MOImageDirectory/ImageDirectory.php" +
  "?SortBy=Date&SortPos=DESC&SearchFor=&Type=&SortRange=30";

const TIMEOUT_MS = 8_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60", // edge cache 1 min por si hay CDN
    },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const lang = getReqLang(request);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MO_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; EXOTIC/1.0)" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return jsonResponse(
        { ok: false, error: t("error.moStatus", lang, { status: res.status }) },
        502,
      );
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    // El desplegable de "Sort by Object" puede tener cualquier name;
    // parseamos TODOS los <option> y filtramos por nombre.
    // Aplicamos `normalizeMoName` (HATP-19 → HAT-P-19) para que el
    // formato enviado a NASA en el transit-check coincida con el
    // canónico. Ver `normalizeMoName` para más detalles.
    const optionNames = $("option")
      .map((_, el) => normalizeMoName($(el).text().trim()))
      .get();
    const unique = Array.from(new Set(optionNames));
    const exo = unique.filter(isExoplanet).sort((a, b) => a.localeCompare(b));

    return jsonResponse({
      ok: true,
      targets: exo,
      source: "microobservatory.harvard.edu",
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(
      { ok: false, error: t("error.targetsFetch", lang) + `: ${msg}` },
      500,
    );
  } finally {
    clearTimeout(timer);
  }
};
