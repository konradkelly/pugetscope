import { test, expect } from "@playwright/test";
import { SEEDED_LOGIN_EMAIL, SEEDED_LOGIN_PASSWORD } from "../fixtures/constants.js";

test("signup logs the new user in, then logout reverts the rail to logged-out", async ({ page }) => {
  // Unique per run so repeated local e2e runs (docker-compose's Postgres
  // volume persists across `down`/`up`, unlike Redis) never collide on the
  // UNIQUE email constraint — the seeded login user below is fine reusing
  // the same address since seed.ts upserts it.
  const email = `e2e-signup-${Date.now()}@pugetscope.test`;

  await page.goto("/");
  await page.getByRole("button", { name: "Log in / sign up" }).click();
  await page.getByTestId("auth-tab-signup").click();

  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill("e2e-password-123");
  await page.getByPlaceholder("Confirm password").fill("e2e-password-123");
  await page.getByTestId("auth-submit").click();

  await expect(page.getByRole("button", { name: email })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in / sign up" })).toBeVisible();
});

test("login with an existing account shows the user's email on the rail", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Log in / sign up" }).click();

  // "login" is AuthPanel's default mode — no tab click needed.
  await page.getByPlaceholder("Email").fill(SEEDED_LOGIN_EMAIL);
  await page.getByPlaceholder("Password", { exact: true }).fill(SEEDED_LOGIN_PASSWORD);
  await page.getByTestId("auth-submit").click();

  await expect(page.getByRole("button", { name: SEEDED_LOGIN_EMAIL })).toBeVisible();
});

test("a wrong password shows an error and does not log in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Log in / sign up" }).click();

  await page.getByPlaceholder("Email").fill(SEEDED_LOGIN_EMAIL);
  await page.getByPlaceholder("Password", { exact: true }).fill("definitely-wrong-password");
  await page.getByTestId("auth-submit").click();

  await expect(page.getByText("invalid email or password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log in / sign up" })).toBeVisible();
});
