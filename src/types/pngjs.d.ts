// Tipos para `pngjs` (no trae .d.ts oficiales).
// Lo justo para que el endpoint /api/fits-view compile.
declare module "pngjs" {
  export class PNG {
    constructor(opts: { width: number; height: number });
    data: Buffer;
    width: number;
    height: number;
    static sync: {
      write(png: PNG): Buffer;
    };
  }
}
