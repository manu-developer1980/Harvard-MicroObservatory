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
    optimizeDeps: {
      include: ["jszip"],
    },
  },
});
