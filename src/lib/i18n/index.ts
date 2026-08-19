/**
 * Módulo i18n minimalista.
 *
 * Uso:
 *   import { t, detectLang, getStoredLang, setStoredLang, type Lang } from "@/lib/i18n";
 *   const lang: Lang = detectLang();
 *   t("app.title", lang);                        // "MicroObservatory Downloader"
 *   t("summary.target", lang, { target, telescope });
 *
 * Detección:
 *   - Cliente (navigator.language): es -> "es", resto -> "en"
 *   - Servidor (Accept-Language):  es -> "es", resto -> "en"
 *
 * Persistencia:
 *   - localStorage["lang"] guarda la elección del usuario si la cambia
 *     manualmente. Tiene prioridad sobre la detección automática.
 */
import { en } from "./dictionaries/en";
import { es } from "./dictionaries/es";
import { hasConsent } from "@/lib/consent";

export type Lang = "en" | "es";
export const SUPPORTED: Lang[] = ["en", "es"];

const dicts: Record<Lang, Record<string, string>> = { en, es };

const STORAGE_KEY = "mo.lang";

export function detectLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  const l = navigator.language?.toLowerCase() ?? "";
  if (l.startsWith("es")) return "es";
  return "en";
}

export function detectLangFromHeader(header: string | null): Lang {
  if (!header) return "en";
  // Accept-Language suele ser "es-ES,es;q=0.9,en;q=0.8"
  // Nos basta con mirar la primera etiqueta primaria.
  const first = header.split(",")[0]?.toLowerCase() ?? "";
  if (first.startsWith("es")) return "es";
  return "en";
}

/**
 * Resuelve el idioma de una request entrante en una API route.
 * Prioridad: ?lang= query param > Accept-Language header > "en".
 * Útil para endpoints GET donde el cliente no puede enviar body
 * (p.ej. /api/targets, /api/fits/[file]).
 */
export function getReqLang(request: Request): Lang {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("lang");
    if (q === "es" || q === "en") return q;
  } catch {
    /* ignore */
  }
  return detectLangFromHeader(request.headers.get("accept-language"));
}

export function getStoredLang(): Lang | null {
  if (typeof localStorage === "undefined") return null;
  if (!hasConsent("functional")) return null;
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "en" || v === "es") return v;
  return null;
}

export function setStoredLang(lang: Lang): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (hasConsent("functional")) localStorage.setItem(STORAGE_KEY, lang);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Resuelve la clave en el diccionario del idioma y sustituye
 * placeholders {nombre} por los valores en `params`. Si la clave
 * no existe, devuelve la propia clave (mejor que `undefined` en UI).
 */
export function t(
  key: string,
  lang: Lang,
  params?: Record<string, string | number>,
): string {
  const dict = dicts[lang] ?? dicts.en;
  let text = dict[key] ?? dicts.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(
        new RegExp(`\\{${k}\\}`, "g"),
        String(v),
      );
    }
  }
  return text;
}
