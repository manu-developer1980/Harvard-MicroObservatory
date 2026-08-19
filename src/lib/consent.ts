export const CONSENT_STORAGE_KEY = "mo.cookie-consent";

export type ConsentCategory = "functional" | "analytics" | "thirdParty";

export type ConsentState = {
  version: 1;
  functional: boolean;
  analytics: boolean;
  thirdParty: boolean;
};

export const DEFAULT_CONSENT: ConsentState = {
  version: 1,
  functional: false,
  analytics: false,
  thirdParty: false,
};

function isConsentState(value: unknown): value is ConsentState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ConsentState>;
  return (
    v.version === 1 &&
    typeof v.functional === "boolean" &&
    typeof v.analytics === "boolean" &&
    typeof v.thirdParty === "boolean"
  );
}

export function getStoredConsent(): ConsentState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isConsentState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasConsent(category: ConsentCategory): boolean {
  const stored = getStoredConsent();
  return stored ? stored[category] : false;
}

export function setStoredConsent(consent: ConsentState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
  } catch {
    /* ignore storage errors */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ConsentState>("mo:consent", {
      detail: consent,
    }));
  }
}
