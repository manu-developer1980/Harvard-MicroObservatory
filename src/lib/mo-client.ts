/**
 * Cliente HTTP + parser HTML de MicroObservatory.
 * Puerto a TypeScript de las funciones fetch_html / parse_rows de Python.
 */
import * as cheerio from "cheerio";
import type { ImageRecord } from "./filters";

const MO_LIST_URL =
  "https://waps.cfa.harvard.edu/microobservatory/MOImageDirectory/ImageDirectory.php";

export type FetchHtmlOptions = {
  target: string;
  type?: "Object" | "Calibration";
  sortRange?: string;   // días hacia atrás
};

/**
 * Convierte un nombre de target en formato canónico (NASA) al formato
 * que MicroObservatory espera en su `?SearchFor=`.
 *
 * Caso bug ago-2026: la familia HAT-P-NN (e.g. "HAT-P-27") vive en
 * dos formatos incompatibles:
 *   - NASA Exoplanet Archive: "HAT-P-19" (con guion entre HAT y P)
 *   - MicroObservatory:       "HATP-19"  (sin guion)
 *
 * El desplegable y la BÚSQUEDA de MO usan exclusivamente "HATP-19".
 * Si mandamos "HAT-P-19" a MO, devuelve 0 filas. Por eso el frontend
 * puede mostrar el formato canónico (que es el que el usuario
 * reconoce) pero la request a MO debe transformarse.
 *
 * Esta función es la inversa de `normalizeMoName` en
 * `src/lib/targets.ts`: una convierte MO→NASA, esta convierte
 * NASA→MO. Mantenemos las conversiones EXPLÍCITAS y simétricas
 * para que un cambio en un sitio requiera actualizar el otro.
 *
 * Si en el futuro MO cambiase su formato (e.g. aceptar "HAT-P-19"
 * directamente), basta con eliminar esta función.
 */
export function toMoSearchName(target: string): string {
  // HAT-P-NN → HATP-NN (sin guion). Bug ago-2026.
  if (/^HAT-P-\d/i.test(target)) {
    return target.replace(/^HAT-P-/, "HATP-");
  }
  return target;
}

export async function fetchHtml(opts: FetchHtmlOptions): Promise<string | null> {
  const {
    target,
    type = "Object",
    // SortRange acepta solo 3 valores discretos en MicroObservatory:
    // 10, 20, 30. Cualquier otro número (50, 100, 500...) devuelve
    // 0 filas aunque el target tenga imágenes en el archivo — ver
    // bug ago-2026 Qatar-9: el antiguo "500" silenciosamente dejaba
    // fuera targets cuyas únicas observaciones estaban en la franja
    // 20-30 días. 30 es también el máximo de retención pública de
    // MO ("Images are stored in the directory for only four weeks!"),
    // así que pedir más no aporta nada.
    //
    // Si MO algún día amplia el rango, basta con cambiar este
    // default. Ver test E2E en `mo-client.test.ts → fetchHtml
    // SortRange` si quieres verificar el comportamiento con curl.
    sortRange = "30",
  } = opts;
  // MicroObservatory usa un formato distinto al de NASA para la
  // familia HAT-P-NN (ver `toMoSearchName`). Sin esta traducción,
  // el endpoint /api/preview devuelve 0 filas para "HAT-P-27" aunque
  // el target SÍ esté en el archivo. El test E2E con curl confirmó:
  //   SearchFor=HAT-P-27 → 0 filas
  //   SearchFor=HATP-27  → 1 fila de Object_
  const moName = toMoSearchName(target);
  const url = new URL(MO_LIST_URL);
  url.searchParams.set("SortBy", "Date");
  url.searchParams.set("SortPos", "DESC");
  url.searchParams.set("SearchFor", moName);
  url.searchParams.set("Type", type);
  url.searchParams.set("SortRange", sortRange);

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "mo-downloader-web/0.1" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`fetchHtml: HTTP ${res.status} for ${target}`);
      return null;
    }
    const text = await res.text();
    if (text.includes("The image you requested is not found")) {
      return "";
    }
    return text;
  } catch (err) {
    console.error(`fetchHtml error for ${target}:`, err);
    return null;
  }
}

/**
 * Parsea el HTML de MicroObservatory y devuelve la lista de registros.
 *
 * Estructura del HTML: cada fila es
 *   <tr id="Object_NNN">
 *     <td id="FILENAME">FILENAME</td>
 *     <td>DD-Mon-YYYY HH:MM:SS</td>
 *     <a href="https://mo-www.cfa.harvard.edu/ImageDirectory/FITS.FITS">...</a>
 *     ...
 *     <td class="Object_Info_td">Target,Filename,DateLocal,...,Tele,...,Site</td>
 *     <a href="..." target="blank">NN% Clear</a>
 *   </tr>
 */
export function parseRows(html: string): ImageRecord[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const rows: ImageRecord[] = [];

  $('tr[id^="Object_"]').each((_, tr) => {
    const $tr = $(tr);
    const short = $tr.find("td[id]").first().attr("id") ?? "";
    if (!short) return;

    // Fecha: la 2ª <td>
    const cells = $tr.find("td");
    const dt = cells.eq(1).text().trim();

    // FITS URL
    const fitsHref = $tr
      .find('a[href*="mo-www.cfa.harvard.edu/ImageDirectory/"]')
      .first()
      .attr("href");
    if (!fitsHref) return;
    const fits = decodeURIComponent(
      fitsHref.split("/").pop() ?? "",
    );

    // Info: el layout del CSV es
    //   Target,Filename,DateLocal,StartExp,EndExp,LST,UT,ExpTime,Cam,Filter,
    //   InOut,Alt,RA,Dec,Alt2,Az2,HA,Tele,Lat,Lon,Town,State,Country
    //  ( 0      1       2        3       4     5  6   7       8   9  ...
    const info = $tr.find("td.Object_Info_td").text().trim();
    const parts = info.split(",");
    const filter = (parts[9] ?? "").trim();
    const telescope = (parts[17] ?? "").trim();
    const site = (parts[20] ?? "").trim();

    // Weather: el último <a target="blank">
    const weatherText = $tr.find('a[target="blank"]').last().text().trim();
    const weatherMatch = weatherText.match(/(\d+)%/);
    const weather = weatherMatch ? parseInt(weatherMatch[1], 10) : 0;

    rows.push({
      short,
      datetime: dt,
      fits,
      weather,
      filter,
      telescope,
      site,
    });
  });

  return rows;
}
