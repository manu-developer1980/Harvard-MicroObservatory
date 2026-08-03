/**
 * Spanish dictionary. Las mismas claves que `en.ts`.
 */
export const es = {
  "app.title": "MicroObservatory Downloader",
  "app.lead":
    "Descarga imágenes FITS de exoplanetas y Dark-C de calibración desde MicroObservatory (Harvard CFA), con filtros de weather y continuidad temporal.",
  "app.lang.switchTo": "EN",
  "app.lang.label": "Idioma",

  "field.exoplanet": "Exoplaneta",
  "field.dateRange": "Rango de fechas",
  "field.dateStart": "Inicio (DD-MM-YYYY)",
  "field.dateEnd": "Fin (DD-MM-YYYY)",
  "field.dateRangeHint":
    "Deja un campo vacío para no aplicar ese límite.",
  "field.threshold": "Umbral clear % (≥) —",
  "field.thresholdRec": "recomendado 85",
  "field.gap": "Gap máximo entre frames —",
  "field.gapRec": "recomendado 10 min",
  "field.gapHint":
    "Gaps > {gap} min se descartan (suponen discontinuidad operativa). ≥ 30 min cuenta como corte de sesión.",
  "field.telescope": "Telescopio",
  "field.telescopeChoose": "-- elige --",
  "field.telescopeEmpty": "(sin telescopios para este target)",
  "field.telescopeLoading": "cargando...",
  "field.captureFilter": "Filtro de captura —",
  "field.captureFilterHint":
    "EXOTIC asume mismo filtro en toda la secuencia",
  "field.filterEmpty": "(sin imágenes)",
  "field.filterLocked": "único disponible para este telescopio",
  "field.filterAuto": "auto (el más común)",
  "field.allowWithoutDarks": "Permitir sin darks",
  "field.allowWithoutDarksHint":
    "Por defecto, EXOTIC exige darks de la misma fecha y telescopio. Activa esta opción solo si tu sesión no tiene darks disponibles: la curva de luz saldrá más ruidosa.",

  "status.live": "live",
  "status.error": "error",
  "status.loading": "cargando…",

  "targets.errorLoad":
    "No se pudo cargar la lista de targets desde MicroObservatory.",
  "targets.retry": "Reintentar",
  "targets.loadingMsg": "⟳ Cargando targets desde MO…",
  "targets.lastUpdate": "Actualizado a las {time}",
  "targets.refreshAria": "Refrescar lista de targets",
  "targets.refreshTitle":
    "Refrescar lista (también se actualiza cada 60 s)",

  "threshold.veryPermissive": "muy permisivo",
  "threshold.permissive": "permisivo",
  "threshold.standard": "estándar",
  "threshold.recommended": "recomendado",
  "threshold.veryStrict": "muy estricto",

  "gap.strict": "estricto (corta más)",
  "gap.recommended": "recomendado",
  "gap.permissive": "permisivo",
  "gap.loose": "laxo (tolera pausas largas)",

  "action.preview": "Previsualizar",
  "action.loading": "...",
  "action.download": "Descargar ZIP ({count} FITS)",

  "summary.title": "Resumen",
  "summary.target": "Target: {target} ({telescope})",
  "summary.range": "Rango: {range}",
  "summary.filter": "Filtro: {filter}",
  "summary.filterAuto": "autodetect",
  "summary.threshold": "Umbral clear: ≥ {threshold}%",
  "summary.gap": "Gap máximo entre frames: {gap} min",
  "summary.transitTotal": "Tránsito total analizado: {count}",
  "summary.transitKept": "Tránsito que pasa filtros: {count}",
  "summary.darks": "Dark-C del telescopio: {count} (en {dates} fechas)",
  "summary.sequence":
    "Ventana de la secuencia: {start} → {end} UTC ({duration})",
  "summary.sequenceHint":
    "Tip: un tránsito exoplanetario típico dura 1–4 h. Si tu ventana es mucho más corta o está descentrada, la curva de luz saldrá parcial.",
  "summary.empty":
    "No hay fechas que cumplan los filtros. Prueba a relajar el umbral o el rango de fechas.",

  "discarded.title": "{count} imágenes descartadas (primeras)",
  "discarded.headers.date": "Fecha UT",
  "discarded.headers.weather": "Clear%",
  "discarded.headers.gapPrev": "Gap prev",
  "discarded.headers.gapNext": "Gap next",
  "discarded.headers.filter": "Filtro",
  "discarded.headers.telescope": "Telescopio",
  "discarded.headers.short": "Short",
  "discarded.headers.reasons": "Motivos",

  "darkDebug.title":
    "Darks disponibles ({inRange} totales en rango de {totalParsed} parseados — telescopio elegido: {telescope})",
  "darkDebug.hint":
    "Listado de Dark-C que existen en MO en tu rango de fechas. Las filas marcadas con ✓ tienen al menos un dark del telescopio elegido, así que se usarán para calibrar. Si una fecha muestra darks de OTROS telescopios pero no del tuyo, no son usables (mezclar scopes produce calibración incorrecta).",
  "darkDebug.headers.date": "Fecha",
  "darkDebug.headers.count": "#",
  "darkDebug.headers.match": "¿Tu scope?",
  "darkDebug.headers.telescopes": "Telescopios",
  "darkDebug.headers.filters": "Filtros",
  "darkDebug.headers.times": "Horas (UTC)",

  "progress.downloading": "Descargando {done}/{total} — {current}",
  "progress.zipping": "Comprimiendo ZIP...",
  "progress.done": "✅ ZIP descargado",
  "progress.error": "❌ {errorMsg}",

  "error.noTelescope": "Selecciona un telescopio",
  "error.noFiles": "No hay archivos para descargar",
  "error.generic": "Error: {msg}",

  // Mensajes de error del servidor (respuestas API + errores lanzados)
  "error.invalidJson": "JSON inválido",
  "error.missingTarget": "Falta el campo 'target'",
  "error.invalidDate": "Fecha inválida",
  "error.invalidDateFormat":
    "Fecha inválida: {value} (esperado DD-MM-YYYY o YYYY-MM-DD)",
  "error.invalidMonth": "Mes inválido en la fecha: {value}",
  "error.fetchTargetList":
    "No se pudo obtener el listado del target desde MicroObservatory",
  "error.targetNoImages": "El target '{target}' no tiene imágenes",
  "error.noRowsParsed": "No se parsearon filas de {target}",
  "error.missingFileParam": "Falta el parámetro 'file'",
  "error.invalidFileParam": "Parámetro 'file' inválido",
  "error.invalidFilename": "Nombre de archivo no válido",
  "error.moStatus": "MO devolvió HTTP {status}",
  "error.fetchFits": "Error al obtener FITS: {msg}",
  "error.targetsFetch":
    "No se pudo obtener la lista de targets desde MicroObservatory",

  "footer.credit": "hecho por",
  "footer.datasrc":
    "Datos: {moLink} · Filtrado: weather ≥ threshold + continuidad temporal · Darks: solo si existen en la fecha",
  "footer.moName": "MicroObservatory @ Harvard CFA",
  "footer.igAria": "Perfil de Instagram de @manu_astrofoto",

  "reason.weather": "weather {value}%<{threshold}%",
  "reason.weatherLeq": "weather {value}%<={threshold}%",
  "reason.gapCloudy":
    "gap {label}={gap}min (rango {min}-{mid}) + vecino nuboso ({neighbor}%)",
  "reason.gapMedium": "gap {label}={gap}min (rango {mid}-{high})",
  "reason.gapDark": "gap {label}={gap}min (modo dark)",
  "reason.noDarks": "sin darks disponibles en esta fecha",
};
