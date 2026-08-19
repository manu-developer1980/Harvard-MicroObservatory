declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

/** Push a custom event to GTM dataLayer (GA4 tags listen via Custom Event triggers). */
export function trackEvent(
  event: string,
  params?: Record<string, string | number | boolean>,
): void {
  if (typeof window === "undefined") return;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ event, ...params });
}

/** Fired when the user completes a FITS ZIP download. */
export function trackDownloadImages(params: {
  target: string;
  telescope: string;
  fileCount: number;
}): void {
  trackEvent("download_images", {
    event_name: "Download Images",
    target: params.target,
    telescope: params.telescope,
    file_count: params.fileCount,
  });
}

/** Fired when the user completes a Google Drive upload. */
export function trackDriveUpload(params: {
  target: string;
  telescope: string;
  fileCount: number;
}): void {
  trackEvent("drive_upload", {
    event_name: "Drive Upload",
    target: params.target,
    telescope: params.telescope,
    file_count: params.fileCount,
  });
}
