import { hasConsent } from "@/lib/consent";

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
  if (!hasConsent("analytics")) return;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ event, ...params });
}

/** Fired when the user completes a FITS ZIP download. */
export function trackDownloadImages(): void {
  trackEvent("download_images", {
    event_name: "Download Images",
  });
}

/** Fired when the user completes a Google Drive upload. */
export function trackDriveUpload(): void {
  trackEvent("drive_upload", {
    event_name: "Drive Upload",
  });
}
