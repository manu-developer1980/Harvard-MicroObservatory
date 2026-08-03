import { useEffect, useState } from "react";
import {
  t as i18n,
  getStoredLang,
  setStoredLang,
  type Lang,
} from "@/lib/i18n";

/**
 * Footer de la app. Vive como componente React (no como parte del HTML
 * SSR de index.astro) para que pueda re-renderizarse cuando el usuario
 * cambia el idioma con el switcher de la UI. Si lo dejáramos en
 * index.astro, quedaría fijado al `Accept-Language` del navegador para
 * siempre y nunca se traduciría al cambiar manualmente a EN.
 *
 * Misma prioridad i18n que Downloader:
 *   1. localStorage["mo.lang"]  (override persistente del usuario)
 *   2. initialLang (SSR)
 *   3. navigator.language
 *   4. "en" (default)
 */
type FooterProps = {
  initialLang?: Lang;
};

export default function Footer({ initialLang }: FooterProps = {}) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === "undefined") {
      return initialLang ?? "en";
    }
    return getStoredLang() ?? initialLang ?? "en";
  });

  // Sincroniza el <html lang="..."> y persiste en localStorage para
  // que la siguiente carga herede la elección. También escucha el
  // CustomEvent `mo:lang` que dispara el Downloader cuando el usuario
  // cambia el idioma con el switcher — así nos re-renderizamos al
  // mismo tiempo que el resto de la UI.
  useEffect(() => {
    setStoredLang(lang);
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    function onLang(e: Event) {
      const ce = e as CustomEvent<Lang>;
      if (ce.detail && (ce.detail === "en" || ce.detail === "es")) {
        setLangState(ce.detail);
      }
    }
    window.addEventListener("mo:lang", onLang as EventListener);
    return () => window.removeEventListener("mo:lang", onLang as EventListener);
  }, []);

  return (
    <footer>
      <p className="credit">
        <a
          href="https://www.instagram.com/manu_astrofoto/"
          target="_blank"
          rel="noopener"
          aria-label={i18n("footer.igAria", lang)}
        >
          <svg
            className="ig-icon"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
          </svg>
          {i18n("footer.credit", lang)} <strong>@manu_astrofoto</strong> 🔭
        </a>
      </p>
      <p
        // El template incluye un <a> en el placeholder moLink, así que
        // necesitamos renderizarlo como HTML. La URL es hardcoded en el
        // código, no viene de input del usuario, así que no hay XSS.
        dangerouslySetInnerHTML={{
          __html: i18n("footer.datasrc", lang, {
            moLink: `<a href="https://waps.cfa.harvard.edu/microobservatory/" target="_blank" rel="noopener">${i18n("footer.moName", lang)}</a>`,
          }),
        }}
      />
    </footer>
  );
}
