/**
 * One-off Playwright capture of the MicroObservatory Downloader workflow.
 * Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 node docs/screenshots/capture-workflow.mjs
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const BASE = process.env.APP_URL || "http://localhost:4322";
const TARGET = process.env.DEMO_TARGET || "CoRoT-2";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1100, height: 920 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(90_000);

console.log("→", BASE);
await page.goto(BASE, { waitUntil: "domcontentloaded" });

const enBtn = page.locator(".lang-switcher button", { hasText: "EN" });
if (await enBtn.count()) {
  await enBtn.click();
}

await page.waitForFunction(() => {
  const sel = document.querySelector(".targets-field select");
  return sel && sel.options.length > 3;
});

await page.locator(".targets-field select").selectOption(TARGET);

// Telescope auto-selects when only one is available
await page.waitForFunction(() => {
  const labels = [...document.querySelectorAll("label")];
  const telLabel = labels.find((l) =>
    /Telescope|Telescopio/i.test(l.querySelector("span")?.textContent || ""),
  );
  const sel = telLabel?.querySelector("select");
  return Boolean(sel?.value);
});

// Wait until capture filter is resolved (locked code or select)
await page.waitForFunction(() => {
  const locked = document.querySelector(".filter-locked code");
  if (locked && locked.textContent?.trim()) return true;
  const labels = [...document.querySelectorAll("label")];
  const f = labels.find((l) =>
    /Capture filter|Filtro/i.test(l.querySelector("span")?.textContent || ""),
  );
  const sel = f?.querySelector("select");
  return Boolean(sel && sel.options.length > 1);
});

// Preview button idle
await page.waitForFunction(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /^Preview$/i.test(b.textContent?.trim() || ""),
  );
  return Boolean(btn) && !btn.disabled;
});

await page.waitForTimeout(400);
await page.screenshot({
  path: path.join(OUT, "01-form.png"),
  fullPage: false,
});
console.log("✓ 01-form.png");

await page.getByRole("button", { name: /^Preview$/i }).click();

await page.waitForSelector(".sequence-table, .image-checklists", {
  timeout: 90_000,
});
// Prefer waiting for transit-check to settle (found / notFound / nearMiss)
await page
  .waitForFunction(() => {
    const el = document.querySelector(".transit-check");
    if (!el) return true;
    return !el.className.includes("transit-loading");
  }, null, { timeout: 45_000 })
  .catch(() => {});

await page.waitForTimeout(600);

// Focused shot: summary + sequence table
const summaryBlock = page.locator(".summary, .preview-result, .downloader").first();
await page.evaluate(() => {
  const h = document.querySelector(".summary, h2, .image-checklists-title");
  h?.scrollIntoView({ block: "start" });
});
await page.waitForTimeout(200);

// Clip around the results area if we can find it
const results = page.locator(".summary").first();
if (await results.count()) {
  const box = await page.locator(".downloader").boundingBox();
  await page.screenshot({
    path: path.join(OUT, "02-preview.png"),
    clip: box
      ? {
          x: Math.max(0, box.x - 8),
          y: Math.max(0, box.y + 280),
          width: Math.min(box.width + 16, 1100),
          height: 780,
        }
      : undefined,
    fullPage: !box,
  });
} else {
  await page.screenshot({
    path: path.join(OUT, "02-preview.png"),
    fullPage: true,
  });
}
console.log("✓ 02-preview.png");

const details = page.locator("details.image-checklist-details").first();
if (await details.count()) {
  await details.evaluate((el) => {
    el.open = true;
  });
  await page.waitForTimeout(300);
  await details.scrollIntoViewIfNeeded();
  const dbox = await details.boundingBox();
  await page.screenshot({
    path: path.join(OUT, "03-checklist.png"),
    clip: dbox
      ? {
          x: Math.max(0, dbox.x - 4),
          y: Math.max(0, dbox.y - 4),
          width: Math.min(dbox.width + 8, 1100),
          height: Math.min(dbox.height + 8, 700),
        }
      : undefined,
  });
  console.log("✓ 03-checklist.png");

  const viewBtn = details.getByRole("button", { name: /View|Ver/i }).first();
  await viewBtn.click();
  await page.waitForSelector(".fits-viewer img, [role='dialog'] img", {
    timeout: 60_000,
  });
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(OUT, "04-fits-viewer.png"),
    fullPage: false,
  });
  console.log("✓ 04-fits-viewer.png");
} else {
  console.warn("! No checklist — skipped 03/04");
}

await browser.close();
console.log("Done →", OUT);
