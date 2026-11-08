/// <reference lib="dom" />
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { toSessionView } from "../../src/server/rules.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import type { SessionView, Snapshot } from "../../src/shared/protocol.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WARNING = 'Claude Code did not report "status" for a session.';

function sample(now: number): SessionView[] {
  const base = {
    cwd: "C:\\repos\\sample",
    gitBranch: "main",
    model: "claude-sample",
    startedAt: now - 2 * HOUR,
    lastActivityAt: now - 300_000,
  };
  const view = (fields: Parameters<typeof toSessionView>[0]) => ({
    ...base,
    ...toSessionView(fields),
  });
  return [
    view({
      name: "prompting",
      sessionId: "a",
      kind: "interactive",
      status: "waiting",
      waitingFor: "permission prompt",
    }),
    view({
      name: "blocked",
      sessionId: "b",
      kind: "background",
      state: "blocked",
    }),
    view({
      name: "running",
      sessionId: "c",
      kind: "interactive",
      status: "busy",
    }),
    {
      ...view({
        name: "abandoned",
        sessionId: "d",
        kind: "background",
        state: "blocked",
      }),
      lastActivityAt: now - 27 * DAY,
    },
    {
      ...view({
        name: "completed",
        sessionId: "e",
        kind: "background",
        state: "done",
      }),
      finishedAt: now - HOUR,
    },
    {
      ...toSessionView({
        name: "bare",
        sessionId: "f",
        kind: "interactive",
        status: "idle",
      }),
    },
  ];
}

const snapshot = (fields: Partial<Snapshot> = {}): Snapshot => ({
  sessions: sample(Date.now()),
  error: null,
  warnings: [],
  ...fields,
});

let server: RunningServer;
let closed: boolean;

test.beforeEach(async () => {
  closed = false;
  server = await startServer({
    preferredPort: 0,
    webDir: resolve("dist/web"),
  });
});

test.afterEach(async () => {
  if (!closed) await server.close();
});

async function open(page: Page, data: Snapshot = snapshot()) {
  server.publish(data);
  await page.goto(server.loginUrl);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const section = (page: Page, name: RegExp) =>
  page.getByRole("region", { name });

test.describe("sign-in", () => {
  test("removes the token from the address bar and protects the cookie", async ({
    page,
    context,
  }) => {
    await open(page);

    expect(page.url()).toBe(`http://127.0.0.1:${String(server.port)}/`);
    const [cookie] = await context.cookies();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("a second browser cannot reuse the link", async ({ page, browser }) => {
    await open(page);
    const other = await browser.newPage();

    const response = await other.goto(server.loginUrl);

    expect(response?.status()).toBe(403);
    await other.close();
  });
});

test.describe("session groups", () => {
  test("places sessions in the right groups", async ({ page }) => {
    await open(page);

    const needsYou = section(page, /needs you/i);
    await expect(needsYou.getByText("prompting")).toBeVisible();
    await expect(needsYou.getByText("permission prompt")).toBeVisible();
    await expect(needsYou.getByText("needs input")).toBeVisible();
    await expect(
      section(page, /active/i).getByText("running", { exact: true }),
    ).toBeVisible();
    await expect(
      section(page, /finished/i).getByText("completed"),
    ).toBeVisible();
    await expect(page.getByText("abandoned")).toBeHidden();
  });

  test("shows the attention count in the tab title, without stale sessions", async ({
    page,
  }) => {
    await open(page);
    await expect(page).toHaveTitle("(2) Claude Code sessions");
  });

  test("shows the details from the requirements", async ({ page }) => {
    await open(page);
    const row = section(page, /active/i)
      .getByRole("listitem")
      .filter({ hasText: "running" })
      .first();

    for (const text of [
      "C:\\repos\\sample",
      "interactive",
      "main",
      "claude-sample",
      "Started",
      "Running for 2h 0m",
      "Last active 5m ago",
    ]) {
      await expect(row).toContainText(text);
    }
  });

  test("marks missing details as unavailable", async ({ page }) => {
    await open(page);
    const row = section(page, /active/i)
      .getByRole("listitem")
      .filter({ hasText: "bare" })
      .first();

    await expect(row).toContainText("Branch unavailable");
    await expect(row).toContainText("Model unavailable");
    await expect(row).toContainText("Last activity unavailable");
  });

  test("shows an empty state", async ({ page }) => {
    await open(page, snapshot({ sessions: [] }));
    await expect(page.getByText("No sessions to show.")).toBeVisible();
    await expect(page).toHaveTitle("Claude Code sessions");
  });

  test("displays markup in session names as plain text", async ({ page }) => {
    const hostile = toSessionView({
      name: '<img src=x onerror="window.hacked=true">',
      sessionId: "x",
      status: "busy",
    });
    await open(page, snapshot({ sessions: [hostile] }));

    await expect(page.getByText("<img src=x")).toBeVisible();
    expect(await page.evaluate(() => "hacked" in window)).toBe(false);
  });
});

test.describe("stale group", () => {
  test("expands with the mouse", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /stale \(1\)/i }).click();
    await expect(page.getByText("abandoned")).toBeVisible();
  });

  test("expands with the keyboard", async ({ page }) => {
    await open(page);
    const button = page.getByRole("button", { name: /stale \(1\)/i });
    await button.focus();
    await page.keyboard.press("Enter");

    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("abandoned")).toBeVisible();
  });
});

test.describe("live updates", () => {
  test("shows a published change within the 5 second requirement", async ({
    page,
  }) => {
    await open(page);

    const started = Date.now();
    server.publish(snapshot({ sessions: [] }));
    await expect(page.getByText("No sessions to show.")).toBeVisible({
      timeout: 5000,
    });

    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("updates running time as the clock advances", async ({ page }) => {
    await page.clock.install();
    await open(page);
    const row = section(page, /active/i)
      .getByRole("listitem")
      .filter({ hasText: "running" })
      .first();
    await expect(row).toContainText("Running for 2h 0m");

    await page.clock.fastForward(5 * 60_000);

    await expect(row).toContainText("Running for 2h 5m");
  });

  test("reports a lost connection", async ({ page }) => {
    await open(page);

    await server.close();
    closed = true;

    await expect(page.getByRole("alert")).toContainText("Not connected");
  });
});

test.describe("desktop notifications", () => {
  // A stand-in for the browser's Notification, which records what the page shows.
  const fakeNotifications = (permission: string) => {
    return `
      window.__shown = [];
      class FakeNotification {
        static permission = ${JSON.stringify(permission)};
        static requestPermission() {
          FakeNotification.permission = "granted";
          return Promise.resolve("granted");
        }
        constructor(title, options) {
          this.title = title;
          this.body = options.body;
          this.tag = options.tag;
          window.__shown.push(this);
        }
        close() {}
      }
      window.Notification = FakeNotification;
    `;
  };
  const shown = (page: Page) =>
    page.evaluate(() =>
      (
        window as unknown as {
          __shown: { title: string; body: string; tag: string }[];
        }
      ).__shown.map(({ title, body, tag }) => ({ title, body, tag })),
    );

  const busyOnly = (): Snapshot =>
    snapshot({
      sessions: [
        toSessionView({
          sessionId: "n1",
          kind: "interactive",
          status: "busy",
          cwd: "C:/repos/alpha",
          name: "Secret task name",
        }),
      ],
      seq: 1,
    });
  const waitingNow = (seq: number): Snapshot =>
    snapshot({
      sessions: [
        {
          ...toSessionView({
            sessionId: "n1",
            kind: "interactive",
            status: "waiting",
            waitingFor: "permission prompt",
            cwd: "C:/repos/alpha",
            name: "Secret task name",
          }),
          lastActivityAt: Date.now(),
        },
      ],
      seq,
    });

  test("turns on from the button, then notifies with the folder and reason only", async ({
    page,
  }) => {
    await page.addInitScript(fakeNotifications("default"));
    await open(page, busyOnly());

    await page
      .getByRole("button", { name: "Turn on desktop notifications" })
      .click();
    await expect(page.getByText("Desktop notifications are on.")).toBeVisible();

    server.publish(waitingNow(2));
    await expect
      .poll(() => shown(page))
      .toEqual([
        {
          title: "Claude Code session",
          body: "alpha: permission prompt",
          tag: "cc-session-manager-2",
        },
      ]);
  });

  test("doesn't send events from before notifications were turned on", async ({
    page,
  }) => {
    await page.addInitScript(fakeNotifications("default"));
    await open(page, busyOnly());
    server.publish(waitingNow(2));
    await expect(section(page, /needs you/i)).toBeVisible();

    await page
      .getByRole("button", { name: "Turn on desktop notifications" })
      .click();
    await expect(page.getByText("Desktop notifications are on.")).toBeVisible();
    expect(await shown(page)).toEqual([]);
  });

  test("notifies once across two tabs", async ({ page, context }) => {
    await context.addInitScript(fakeNotifications("granted"));
    await open(page, busyOnly());
    const second = await context.newPage();
    await second.goto(`http://127.0.0.1:${String(server.port)}/`);
    await expect(second.getByRole("heading", { level: 1 })).toBeVisible();

    server.publish(waitingNow(2));
    await expect(section(page, /needs you/i)).toBeVisible();
    await expect(section(second, /needs you/i)).toBeVisible();
    await expect
      .poll(
        async () => (await shown(page)).length + (await shown(second)).length,
      )
      .toBe(1);
  });

  test("highlights the session's row when the notification is clicked", async ({
    page,
  }) => {
    await page.addInitScript(fakeNotifications("granted"));
    await open(page, busyOnly());
    server.publish(waitingNow(2));
    await expect.poll(async () => (await shown(page)).length).toBe(1);

    await page.evaluate(() => {
      const list = (window as unknown as { __shown: { onclick: () => void }[] })
        .__shown;
      list[0]?.onclick();
    });
    await expect(
      section(page, /needs you/i).locator('[data-highlighted="true"]'),
    ).toContainText("Secret task name");
  });

  test("says when notifications are blocked or unavailable", async ({
    page,
  }) => {
    await page.addInitScript(fakeNotifications("denied"));
    await open(page);
    await expect(
      page.getByText(/Desktop notifications are blocked/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Turn on desktop notifications" }),
    ).toHaveCount(0);
  });
});

test.describe("screen reader announcements", () => {
  // Announcements fire after a short delay, so checking for silence sooner proves nothing.
  const waitPastAnnouncementDelay = (page: Page) => page.waitForTimeout(400);

  const announcement = (page: Page, text: string) =>
    page.getByRole("status").filter({ hasText: text });

  test("announces a session that starts needing attention", async ({
    page,
  }) => {
    await open(page, snapshot({ sessions: [] }));

    server.publish(
      snapshot({
        sessions: [
          toSessionView({
            name: "newly-blocked",
            sessionId: "n",
            status: "waiting",
            waitingFor: "permission prompt",
          }),
        ],
      }),
    );

    await expect(
      announcement(page, "newly-blocked needs you: permission prompt."),
    ).toBeAttached();
    await expect(page).toHaveTitle("(1) Claude Code sessions");
  });

  test("does not announce sessions already waiting when the page opens", async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByText("prompting").first()).toBeVisible();
    await waitPastAnnouncementDelay(page);
    await expect(
      page.getByRole("status").filter({ hasText: "needs you:" }),
    ).toHaveCount(0);
  });

  const waiting = (sessionId: string, name: string) =>
    toSessionView({
      name,
      sessionId,
      status: "waiting",
      waitingFor: "permission prompt",
    });

  const recordAnnouncements = (page: Page) =>
    page.evaluate(() => {
      const region = document.querySelector("[data-announcer]");
      if (!region) throw new Error("no announcer");
      const seen: string[] = [];
      new MutationObserver(() => {
        seen.push(region.textContent);
      }).observe(region, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      Object.assign(window, { announcements: seen });
    });

  const announcements = (page: Page) =>
    page.evaluate(
      () => (window as unknown as { announcements: string[] }).announcements,
    );

  test("does not announce sessions waiting before the first poll finishes", async ({
    page,
  }) => {
    await page.goto(server.loginUrl);
    await expect(page.getByText("Loading sessions")).toBeVisible();
    await recordAnnouncements(page);

    server.publish(snapshot({ sessions: [waiting("a", "already-waiting")] }));

    await expect(page.getByText("already-waiting")).toBeVisible();
    await waitPastAnnouncementDelay(page);
    expect(await announcements(page)).toEqual([]);
  });

  test("does not announce everything after a first poll that failed", async ({
    page,
  }) => {
    await page.goto(server.loginUrl);
    await expect(page.getByText("Loading sessions")).toBeVisible();
    server.publish(snapshot({ sessions: [], error: "Could not read." }));
    await expect(page.getByRole("alert")).toContainText("Could not read.");
    await recordAnnouncements(page);

    server.publish(snapshot({ sessions: [waiting("a", "already-waiting")] }));

    await expect(page.getByText("already-waiting")).toBeVisible();
    await waitPastAnnouncementDelay(page);
    expect(await announcements(page)).toEqual([]);
  });

  test("announces a second session with identical text", async ({ page }) => {
    await open(page, snapshot({ sessions: [] }));
    await recordAnnouncements(page);
    const text = "same-prompt needs you: permission prompt.";

    server.publish(snapshot({ sessions: [waiting("a", "same-prompt")] }));
    await expect(announcement(page, text)).toBeAttached();
    server.publish(
      snapshot({
        sessions: [waiting("a", "same-prompt"), waiting("b", "same-prompt")],
      }),
    );

    await expect
      .poll(async () =>
        (await announcements(page)).filter((value) => value === text),
      )
      .toHaveLength(2);
  });

  test("announces a session again when it comes back", async ({ page }) => {
    await open(page, snapshot({ sessions: [] }));
    await recordAnnouncements(page);
    const text = "returning needs you: permission prompt.";

    server.publish(snapshot({ sessions: [waiting("a", "returning")] }));
    await expect(announcement(page, text)).toBeAttached();
    server.publish(snapshot({ sessions: [] }));
    await expect(announcement(page, text)).toHaveCount(0);
    server.publish(snapshot({ sessions: [waiting("a", "returning")] }));

    await expect(announcement(page, text)).toBeAttached();
    expect(
      (await announcements(page)).filter((value) => value === text),
    ).toHaveLength(2);
  });

  test("leaves the announcement alone when waiting sessions only change order", async ({
    page,
  }) => {
    const now = Date.now();
    const at = (sessionId: string, name: string, lastActivityAt: number) => ({
      ...waiting(sessionId, name),
      lastActivityAt,
    });
    await open(page, snapshot({ sessions: [at("a", "alpha", now - 2000)] }));

    server.publish(
      snapshot({
        sessions: [at("a", "alpha", now - 2000), at("b", "beta", now - 1000)],
      }),
    );
    const text = "beta needs you: permission prompt.";
    await expect(announcement(page, text)).toBeAttached();

    server.publish(
      snapshot({
        sessions: [at("a", "alpha", now), at("b", "beta", now - 1000)],
      }),
    );

    await expect(
      section(page, /needs you/i)
        .getByRole("listitem")
        .first(),
    ).toContainText("beta");
    await expect(announcement(page, text)).toBeAttached();
  });

  test("keeps the announcement region out of the visible layout", async ({
    page,
  }) => {
    await open(page, snapshot({ sessions: [] }));
    const region = page.locator("[data-announcer]");

    await expect(region).toHaveAttribute("role", "status");
    const box = await region.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(1);
  });
});

test.describe("banners", () => {
  test("expands warning details", async ({ page }) => {
    await open(page, snapshot({ warnings: [WARNING] }));
    await expect(page.getByText(WARNING)).toBeHidden();

    await page.getByRole("button", { name: /may be missing/i }).click();

    await expect(page.getByText(WARNING)).toBeVisible();
  });

  test("shows poll errors in full, with the last known sessions", async ({
    page,
  }) => {
    await open(page, snapshot({ error: "Could not read sessions." }));

    await expect(page.getByRole("alert")).toContainText(
      "Could not read sessions.",
    );
    await expect(page.getByText("running", { exact: true })).toBeVisible();
  });
});

test.describe("hardening", () => {
  test("makes no external requests and has no policy violations", async ({
    page,
  }) => {
    const external: string[] = [];
    const problems: string[] = [];
    page.on("request", (request) => {
      if (
        !request.url().startsWith(`http://127.0.0.1:${String(server.port)}`) &&
        !request.url().startsWith(`ws://127.0.0.1:${String(server.port)}`)
      ) {
        external.push(request.url());
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));

    await open(page);
    await page.getByRole("button", { name: /stale \(1\)/i }).click();
    await expect(page.getByText("abandoned")).toBeVisible();

    expect(external).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("blocks inline styles that lack the nonce", async ({ page }) => {
    await open(page);

    const color = await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "body { color: rgb(1, 2, 3) !important; }";
      document.head.append(style);
      return getComputedStyle(document.body).color;
    });

    expect(color).not.toBe("rgb(1, 2, 3)");
  });

  test("lets the library's press style through with the nonce", async ({
    page,
  }) => {
    await open(page);

    const applied = await page
      .getByRole("button", { name: /stale \(1\)/i })
      .evaluate((button) => getComputedStyle(button).touchAction);

    // Chromium reports "pan-x pan-y pinch-zoom" by its equivalent name.
    expect(applied).toBe("manipulation");
  });

  test("blocks inline scripts through the policy", async ({ page }) => {
    await open(page);

    const ran = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.inlineRan = true";
      document.body.append(script);
      return "inlineRan" in window;
    });

    expect(ran).toBe(false);
  });
});

test.describe("accessibility", () => {
  const scan = async (page: Page) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      violations.map(({ id, nodes }) => ({ id, count: nodes.length })),
    ).toEqual([]);
  };

  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme} theme has no automated WCAG violations`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await open(page, snapshot({ warnings: [WARNING], error: "Failed." }));
      await page.getByRole("button", { name: /stale \(1\)/i }).click();
      await page.getByRole("button", { name: /may be missing/i }).click();
      await expect(page.getByText("abandoned")).toBeVisible();

      await scan(page);
    });

    test(`${colorScheme} theme fits a 320 px window without sideways scrolling`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.emulateMedia({ colorScheme });
      await open(page, snapshot({ warnings: [WARNING] }));

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );

      expect(overflow).toBeLessThanOrEqual(0);
      await scan(page);
    });
  }

  test("moves keyboard focus to the expandable sections with a visible outline", async ({
    page,
  }) => {
    await open(page, snapshot({ warnings: [WARNING] }));

    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveAccessibleName(/may be missing/i);
    const outline = await focused.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    );
    expect(outline).toBe("solid");

    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveAccessibleName(/stale/i);
  });
});
