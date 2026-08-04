import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import netlify from "@astrojs/netlify";

export default defineConfig({
  output: "server",
  adapter: netlify(),
  integrations: [react()],
  server: {
    port: 4321,
  },
  vite: {
    // jszip se carga dinámicamente en el cliente (no en SSR), así que no
    // necesitamos tocar ssr.noExternal. Para que Vite lo pre-bundle bien
    // en dev y lo sirva optimizado al navegador, lo declaramos aquí.
    //
    // react / react-dom / jsx-runtime: CRÍTICO incluirlos aquí. Sin
    // esto, cuando Vitest y el dev server de Astro comparten
    // `node_modules/.vite/deps/`, el pre-bundle de React puede quedar
    // en un estado inconsistente y provocar en runtime
    //   "Cannot read properties of null (reading 'useState')"
    //   "Minified React error #423"
    // al ejecutar `useState()` en los componentes. Forzar el
    // pre-bundle aquí hace que Vite regenere las entradas de React
    // cada vez que cambian las dependencias, evitando la corrupción.
    // Es la misma solución que recomienda la docs de Vite + Vitest
    // para proyectos que combinan ambos.
    optimizeDeps: {
      include: [
        "jszip",
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    },
  },
});
