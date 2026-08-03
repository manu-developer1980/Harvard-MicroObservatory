/**
 * English dictionary.
 * Keys are dot-separated paths. Parameters in {curly_braces}.
 */
export const en = {
  "app.title": "MicroObservatory Downloader",
  "app.lead":
    "Download FITS images of exoplanets and Dark-C calibration frames from MicroObservatory (Harvard CFA), with weather and temporal continuity filters.",
  "app.lang.switchTo": "ES",
  "app.lang.label": "Language",

  "field.exoplanet": "Exoplanet",
  "field.dateRange": "Date range",
  "field.dateStart": "Start (DD-MM-YYYY)",
  "field.dateEnd": "End (DD-MM-YYYY)",
  "field.dateRangeHint":
    "Leave a field empty to not apply that limit.",
  "field.threshold": "Clear-sky threshold % (≥) —",
  "field.thresholdRec": "recommended 85",
  "field.gap": "Max gap between frames —",
  "field.gapRec": "recommended 10 min",
  "field.gapHint":
    "Gaps > {gap} min are dropped (assume operational discontinuity). ≥ 30 min counts as session break.",
  "field.telescope": "Telescope",
  "field.telescopeChoose": "-- pick one --",
  "field.telescopeEmpty": "(no telescopes for this target)",
  "field.telescopeLoading": "loading...",
  "field.captureFilter": "Capture filter —",
  "field.captureFilterHint":
    "EXOTIC assumes the same filter across the whole sequence",
  "field.filterEmpty": "(no images)",
  "field.filterLocked": "only one available for this telescope",
  "field.filterAuto": "auto (most common)",
  "field.allowWithoutDarks": "Allow without darks",
  "field.allowWithoutDarksHint":
    "By default, EXOTIC requires darks from the same date and telescope. Enable this only if your session has no darks available: the resulting light curve will be noisier.",

  "status.live": "live",
  "status.error": "error",
  "status.loading": "loading…",

  "targets.errorLoad":
    "Could not load the target list from MicroObservatory.",
  "targets.retry": "Retry",
  "targets.loadingMsg": "⟳ Loading targets from MO…",
  "targets.lastUpdate": "Updated at {time}",
  "targets.refreshAria": "Refresh target list",
  "targets.refreshTitle":
    "Refresh list (also updates every 60 s automatically)",

  "threshold.veryPermissive": "very permissive",
  "threshold.permissive": "permissive",
  "threshold.standard": "standard",
  "threshold.recommended": "recommended",
  "threshold.veryStrict": "very strict",

  "gap.strict": "strict (cuts more)",
  "gap.recommended": "recommended",
  "gap.permissive": "permissive",
  "gap.loose": "loose (tolerates long pauses)",

  "action.preview": "Preview",
  "action.loading": "...",
  "action.download": "Download ZIP ({count} FITS)",

  "summary.title": "Summary",
  "summary.target": "Target: {target} ({telescope})",
  "summary.range": "Range: {range}",
  "summary.filter": "Filter: {filter}",
  "summary.filterAuto": "autodetect",
  "summary.threshold": "Clear-sky threshold: ≥ {threshold}%",
  "summary.gap": "Max gap between frames: {gap} min",
  "summary.transitTotal": "Transit images analyzed: {count}",
  "summary.transitKept": "Transit images passing filters: {count}",
  "summary.darks": "Dark-C frames for the telescope: {count} (in {dates} dates)",
  "summary.sequence":
    "Sequence window: {start} → {end} UTC ({duration})",
  "summary.sequenceHint":
    "Tip: a typical exoplanet transit lasts 1–4 h. If your window is much shorter or off-centre, the light curve will be partial.",
  "summary.empty":
    "No dates pass the current filters. Try relaxing the threshold or the date range.",

  "discarded.title": "{count} discarded images (first batch)",
  "discarded.headers.date": "UTC date",
  "discarded.headers.weather": "Clear%",
  "discarded.headers.gapPrev": "Gap prev",
  "discarded.headers.gapNext": "Gap next",
  "discarded.headers.filter": "Filter",
  "discarded.headers.telescope": "Telescope",
  "discarded.headers.short": "Short ID",
  "discarded.headers.reasons": "Reasons",

  "darkDebug.title":
    "Darks available ({inRange} in range of {totalParsed} parsed — selected telescope: {telescope})",
  "darkDebug.hint":
    "List of Dark-C frames that exist in MO within your date range. Rows marked with ✓ have at least one dark from the selected telescope, so they will be used for calibration. If a date shows darks from OTHER telescopes but not yours, they are not usable (mixing scopes produces incorrect calibration).",
  "darkDebug.headers.date": "Date",
  "darkDebug.headers.count": "#",
  "darkDebug.headers.match": "Your scope?",
  "darkDebug.headers.telescopes": "Telescopes",
  "darkDebug.headers.filters": "Filters",
  "darkDebug.headers.times": "Times (UTC)",

  "progress.downloading": "Downloading {done}/{total} — {current}",
  "progress.zipping": "Compressing ZIP...",
  "progress.done": "✅ ZIP downloaded",
  "progress.error": "❌ {errorMsg}",

  "error.noTelescope": "Pick a telescope first",
  "error.noFiles": "There are no files to download",
  "error.generic": "Error: {msg}",

  // Server-side error messages (API responses + thrown errors)
  "error.invalidJson": "Invalid JSON",
  "error.missingTarget": "Missing 'target' field",
  "error.invalidDate": "Invalid date",
  "error.invalidDateFormat":
    "Invalid date: {value} (expected DD-MM-YYYY or YYYY-MM-DD)",
  "error.invalidMonth": "Invalid month in date: {value}",
  "error.fetchTargetList":
    "Could not fetch the target listing from MicroObservatory",
  "error.targetNoImages": "Target '{target}' has no images",
  "error.noRowsParsed": "No rows parsed for {target}",
  "error.missingFileParam": "Missing 'file' parameter",
  "error.invalidFileParam": "Invalid 'file' parameter",
  "error.invalidFilename": "Invalid filename",
  "error.moStatus": "MO returned HTTP {status}",
  "error.fetchFits": "Error fetching FITS: {msg}",
  "error.targetsFetch":
    "Could not fetch the target list from MicroObservatory",

  "footer.credit": "made by",
  "footer.datasrc":
    "Data: {moLink} · Filtering: weather ≥ threshold + temporal continuity · Darks: only if they exist for the date",
  "footer.moName": "MicroObservatory @ Harvard CFA",
  "footer.igAria": "Instagram profile of @manu_astrofoto",

  // Discarded-reason templates (server-side)
  "reason.weather": "weather {value}%<{threshold}%",
  "reason.weatherLeq": "weather {value}%<={threshold}%",
  "reason.gapCloudy":
    "gap {label}={gap}min (range {min}-{mid}) + cloudy neighbour ({neighbor}%)",
  "reason.gapMedium": "gap {label}={gap}min (range {mid}-{high})",
  "reason.gapDark": "gap {label}={gap}min (dark mode)",
  "reason.noDarks": "no darks available for this date",
};
