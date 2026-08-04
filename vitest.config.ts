import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Replicamos el alias `@/* -> src/*` que ya existe en `tsconfig.json`,
// para que Vitest pueda resolver `import x from "@/lib/..."` en los tests.
// Sin esto, Vitest (que no lee tsconfig.paths por defecto) falla con
// "Cannot find package '@/...'".
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Sin entorno DOM: los tests son lógica pura (matching de tránsitos,
    // propagacion de incertidumbre, etc.) y no tocan window/document.
    environment: "node",
  },
});
