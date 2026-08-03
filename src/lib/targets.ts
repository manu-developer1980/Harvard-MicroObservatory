/**
 * Targets de exoplanetas disponibles en MicroObservatory.
 * Puerto de la constante AVAILABLE_TARGETS del script Python.
 *
 * Esta lista es el FALLBACK estático: la UI intenta primero obtener la
 * lista en vivo desde /api/targets (que parsea el desplegable oficial de
 * MO y se refresca cada 5 min). Si MO no responde, usamos esta.
 *
 * Última sincronización con el desplegable oficial: 2026-08-02.
 */
export const AVAILABLE_TARGETS: readonly string[] = [
  "All ExoPlanets",
  "CoRoT-2",
  "K2-237",
  "KELT-23A",
  "Qatar-1",
  "TOI1516",
  "TOI4145",
  "TRES-1",
  "TRES-3",
  "TRES-5",
  "WASP-135",
  "WASP-163",
  "WASP-2",
  "WASP-53",
  "WASP-58",
  "WASP-67",
  "WASP-80",
  "WASP-89",
] as const;

export type Target = (typeof AVAILABLE_TARGETS)[number];
