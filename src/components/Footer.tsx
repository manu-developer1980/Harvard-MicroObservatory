import { useEffect, useRef, useState } from "react";
import {
  t as i18n,
  getStoredLang,
  setStoredLang,
  type Lang,
} from "@/lib/i18n";
import {
  getStoredConsent,
  type ConsentState,
} from "@/lib/consent";

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
 *
 * Buy Me a Coffee: el embed oficial (`button.prod.min.js`) hace
 * `document.writeln` al encontrar `script[data-name="bmc-button"]`, lo
 * que destruye la página si se carga tras el parse. Aquí cargamos el
 * script SIN ese atributo y llamamos a `window.bmcBtnWidget(...)` para
 * inyectar el HTML en un contenedor junto a la firma.
 */
type FooterProps = {
  initialLang?: Lang;
};

type BmcWindow = Window & {
  bmcBtnWidget?: (
    text: string,
    slug: string,
    color: string,
    emoji: string,
    font: string,
    fontColor: string,
    outlineColor: string,
    coffeeColor: string,
  ) => string;
};

const BMC_SCRIPT =
  "https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js";
const BMC_SLUG = "manu_astrofoto";
const DEFAULT_CONSENT: ConsentState = {
  version: 1,
  functional: false,
  analytics: false,
  thirdParty: false,
};

export default function Footer({ initialLang }: FooterProps = {}) {
  // IMPORTANTE: el initial state debe coincidir EXACTAMENTE con el SSR
  // para evitar React hydration error #425/#418/#423. El SSR siempre usa
  // `initialLang` (derivado de Accept-Language en index.astro); aplicamos
  // la preferencia de localStorage en un useEffect posterior al mount.
  const [lang, setLangState] = useState<Lang>(initialLang ?? "en");
  const [consent, setConsent] = useState<ConsentState>(DEFAULT_CONSENT);
  const bmcRef = useRef<HTMLDivElement | null>(null);

  // Tras montar, sincronizamos con la preferencia persistida. Si difiere
  // del valor SSR, forzamos un re-render con el idioma guardado. Se
  // ejecuta UNA sola vez (deps []) y solo en cliente.
  useEffect(() => {
    const stored = getStoredLang();
    if (stored && stored !== lang) {
      setLangState(stored);
    }
    const storedConsent = getStoredConsent();
    if (storedConsent) setConsent(storedConsent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    function onConsent(e: Event) {
      const ce = e as CustomEvent<ConsentState>;
      if (ce.detail) setConsent(ce.detail);
    }
    window.addEventListener("mo:consent", onConsent as EventListener);
    return () => window.removeEventListener("mo:consent", onConsent as EventListener);
  }, []);

  // Buy Me a Coffee widget (official script, safe React mount).
  useEffect(() => {
    const host = bmcRef.current;
    if (!host) return;
    if (!consent.thirdParty) {
      host.innerHTML = `<a class="bmc-fallback" href="https://www.buymeacoffee.com/${BMC_SLUG}" target="_blank" rel="noopener">Buy me a coffee</a>`;
      host.dataset.bmc = "0";
      return;
    }
    if (host.dataset.bmc === "1") return;
    host.dataset.bmc = "1";

    const render = () => {
      const w = window as BmcWindow;
      if (!w.bmcBtnWidget || !bmcRef.current) return;
      bmcRef.current.innerHTML = w.bmcBtnWidget(
        "Buy me a coffee",
        BMC_SLUG,
        "#FFDD00",
        "",
        "Bree",
        "#000000",
        "#000000",
        "#ffffff",
      );
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${BMC_SCRIPT}"]`,
    );
    if (existing && (window as BmcWindow).bmcBtnWidget) {
      render();
      return;
    }

    const script = document.createElement("script");
    script.src = BMC_SCRIPT;
    script.async = true;
    // Sin data-name="bmc-button": evita document.writeln del embed.
    script.onload = render;
    script.onerror = () => {
      if (!bmcRef.current) return;
      bmcRef.current.innerHTML = `<a class="bmc-fallback" href="https://www.buymeacoffee.com/${BMC_SLUG}" target="_blank" rel="noopener">Buy me a coffee</a>`;
    };
    document.body.appendChild(script);
  }, [consent.thirdParty]);

  return (
    <footer>
      <div className="credit-row">
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
        
      </div>
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
      <div
          className="bmc-wrap"
          ref={bmcRef}
          aria-label="Buy me a coffee"
        />
    </footer>
  );
}
