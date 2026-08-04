/**
 * Schemas de validación (Zod) para los body de los endpoints POST.
 *
 * Centralizamos los schemas aquí para:
 *  1. Reutilizarlos entre el cliente (validación previa opcional) y
 *     el servidor (validación autoritativa antes de procesar).
 *  2. Tener UN solo sitio donde ajustar restricciones (e.g. rango
 *     de `badGapMid`).
 *  3. Tiparlos: `z.infer<typeof X>` genera el tipo TypeScript
 *     automáticamente (sustituye a las interfaces a mano que tenías
 *     en cada endpoint, propensas a desincronizarse con la realidad).
 *
 * Decisiones de diseño:
 *  - Todos los campos opcionales llevan `.optional()` o `.default()`
 *    para no romper clientes existentes que mandan shapes parciales.
 *  - `.transform()` se usa para normalizar (trim de strings) ANTES
 *    de validar; así las reglas `min(1)` operan sobre el valor
 *    ya saneado.
 *  - Los strings `target` se limitan a un charset razonable
 *    (letras, dígitos, guiones, espacios) para bloquear inyecciones
 *    creativas antes de llegar al SQL escape.
 */
import { z } from "zod";

/** Charset permitido en nombres de exoplaneta (defensa adicional
 *  antes del SQL escape). Coincide con los formatos de MO y NASA:
 *  "WASP-12", "TrES-3", "HAT-P-11", "KELT-9", "TOI-1234.01", etc.
 *  NO permitimos '/', '\\', '%', '_' (SQL/LIKE), ni comillas. */
const EXOPLANET_NAME = /^[A-Za-z0-9\-\.+\s]+$/;

/** MO usa "DD-Mon-YYYY" (e.g. "27-Jul-2026") o "DD-Mon-YYYY HH:MM:SS".
 *  ISO se tolera también por si el cliente ya tiene un parser. */
const MO_DATE = /^(\d{2}-[A-Za-z]{3}-\d{4}( \d{2}:\d{2}(:\d{2})?)?|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?)$/;

export const LangSchema = z.enum(["en", "es"]).optional();

export const TargetSchema = z
  .string()
  .trim()
  .min(1, "target vacío")
  .max(64, "target demasiado largo")
  .regex(EXOPLANET_NAME, "target contiene caracteres no permitidos");

// ============================================================================
// /api/preview
// ============================================================================

export const PreviewRequestSchema = z
  .object({
    target: TargetSchema,
    // `date` puede venir vacío o con formatos MO / ISO; el parser
    // específico vive en `parseDateArg` (lib/filters). Aquí solo
    // verificamos que sea un string razonable.
    date: z.string().trim().max(128).optional(),
    threshold: z.number().int().min(0).max(100).optional(),
    telescope: z.string().trim().max(64).optional(),
    filter: z.string().trim().max(64).optional(),
    badGapMid: z.number().int().min(4).max(30).optional(),
    inclusiveWeather: z.boolean().optional(),
    requireDarks: z.boolean().optional(),
    lang: LangSchema,
  })
  .strict(); // rechaza claves desconocidas (defense in depth)

export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;

// ============================================================================
// /api/transit-check
// ============================================================================

export const TransitCheckRequestSchema = z
  .object({
    target: TargetSchema,
    start: z
      .string()
      .trim()
      .min(1, "start vacío")
      .max(64, "start demasiado largo")
      .regex(MO_DATE, "start con formato no reconocido"),
    end: z
      .string()
      .trim()
      .min(1, "end vacío")
      .max(64, "end demasiado largo")
      .regex(MO_DATE, "end con formato no reconocido"),
    lang: LangSchema,
  })
  .strict();

export type TransitCheckRequest = z.infer<typeof TransitCheckRequestSchema>;

// ============================================================================
// Helper
// ============================================================================

/** Parsea un body JSON validándolo contra un schema de Zod. Devuelve
 *  `{ ok: true, data }` si todo OK, o `{ ok: false, error }` con un
 *  mensaje listo para enviar al cliente. NO se hace log del body crudo
 *  (defense in depth: no leakear input del usuario en logs). */
export function parseBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  // Mensaje compacto: primer issue, sin exponer el path interno.
  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, error: `${path}${issue.message}` };
}
