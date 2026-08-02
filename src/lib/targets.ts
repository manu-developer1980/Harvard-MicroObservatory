/**
 * Targets de exoplanetas disponibles en MicroObservatory.
 * Puerto directo de la constante AVAILABLE_TARGETS del script Python.
 */
export const AVAILABLE_TARGETS: readonly string[] = [
  "All ExoPlanets",
  "CoRoT-2",
  "K2-237",
  "Kepler-12",
  "Qatar-4",
  "Qatar-6",
  "TOI1259",
  "TOI1516",
  "TOI4145",
  "TRES-1",
  "TRES-3",
  "TRES-5",
  "WASP-135",
  "WASP-2",
  "WASP-53",
  "WASP-58",
  "WASP-67",
  "WASP-80",
  "WASP-81",
  "WASP-89",
] as const;

export type Target = (typeof AVAILABLE_TARGETS)[number];
