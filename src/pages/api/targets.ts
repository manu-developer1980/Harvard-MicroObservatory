// src/pages/api/targets.ts
// Devuelve la lista viva de exoplanetas disponibles en MicroObservatory,
// parseada en tiempo real del desplegable oficial de la página del archivo.
//
// Caché: ninguna a propósito. El endpoint es barato (~50 KB de HTML) y
// la UI lo refresca cada 60 s en memoria. Si MO añade/quita targets, los
// usuarios los ven al recargar o al cumplirse el intervalo.

import type { APIRoute } from "astro";
import * as cheerio from "cheerio";
import { t, getReqLang } from "@/lib/i18n";

const MO_URL =
  "https://waps.cfa.harvard.edu/microobservatory/MOImageDirectory/ImageDirectory.php";

// Prefijos que identifican exoplanetas en el catálogo de MO.
// "All ExoPlanets" se trata aparte (es el comodín).
const EXO_PREFIXES = [
  "CoRoT",
  "K2-",
  "KELT",
  "Kepler",
  "Qatar",
  "TOI",
  "TRES",
  "WASP",
];

// Exoplanetas con nombres que no encajan en los prefijos de arriba.
// (Por ahora ninguno, pero el hook queda por si MO añade "OGLE", "HAT-P", etc.)
const EXO_EXACT: string[] = [];

const TIMEOUT_MS = 8_000;

function isExoplanet(name: string): boolean {
  if (name === "All ExoPlanets") return true;
  if (EXO_EXACT.includes(name)) return true;
  return EXO_PREFIXES.some((p) => name.startsWith(p));
}

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
    const optionNames = $("option")
      .map((_, el) => $(el).text().trim())
      .get();
    const unique = Array.from(new Set(optionNames));
    const exo = unique.filter(isExoplanet);

    // "All ExoPlanets" primero, luego alfabético
    exo.sort((a, b) => {
      if (a === "All ExoPlanets") return -1;
      if (b === "All ExoPlanets") return 1;
      return a.localeCompare(b);
    });

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
