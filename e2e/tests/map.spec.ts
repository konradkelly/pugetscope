import { test, expect } from "@playwright/test";
import {
  SEEDED_AIRCRAFT_ICAO24,
  SEEDED_AIRCRAFT_CALLSIGN,
  SEEDED_AIRCRAFT_REGISTRATION,
  SEEDED_AIRCRAFT_MODEL,
} from "../fixtures/constants.js";

test("live map connects and reflects the seeded aircraft count", async ({ page }) => {
  await page.goto("/");

  // The only existing "feed is ready" signal in the DOM today (App.tsx) —
  // no loading spinner/skeleton to wait on instead.
  await expect(page.getByText(`live · 1 aircraft`)).toBeVisible({ timeout: 15_000 });
});

test("clicking a live aircraft marker opens the detail panel with real data", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(`live · 1 aircraft`)).toBeVisible({ timeout: 15_000 });

  await page.locator(`[data-testid="aircraft-marker-${SEEDED_AIRCRAFT_ICAO24}"]`).click();

  await expect(page).toHaveURL(new RegExp(`/aircraft/${SEEDED_AIRCRAFT_ICAO24}$`));
  await expect(page.getByRole("heading", { name: SEEDED_AIRCRAFT_CALLSIGN })).toBeVisible();
  await expect(page.getByText(SEEDED_AIRCRAFT_ICAO24)).toBeVisible();
  await expect(page.getByText(SEEDED_AIRCRAFT_REGISTRATION)).toBeVisible();
  await expect(page.getByText(SEEDED_AIRCRAFT_MODEL)).toBeVisible();

  // Scoped to the detail panel specifically — the legend panel (open by
  // default alongside it, App.tsx's initial activeRailPanel) has its own
  // "Close" button too.
  await page.getByTestId("aircraft-detail-panel").getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/$/);
});
