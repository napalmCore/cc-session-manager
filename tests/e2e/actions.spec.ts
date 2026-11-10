/// <reference lib="dom" />
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { toSessionView } from "../../src/server/rules.js";
import type { ActionRequest, ActionResult } from "../../src/server/actions.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import type {
  LeftoverOffer,
  SessionView,
  Snapshot,
} from "../../src/shared/protocol.js";

const HOUR = 3_600_000;
const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const ENDED_ID = "22222222-2222-4222-8222-222222222222";

function sessions(now: number): SessionView[] {
  const base = {
    cwd: "C:\\repos\\sample",
    startedAt: now - 2 * HOUR,
    lastActivityAt: now - 60_000,
  };
  const view = (fields: Parameters<typeof toSessionView>[0]) => ({
    ...base,
    ...toSessionView({ cwd: base.cwd, startedAt: base.startedAt, ...fields }),
  });
  return [
    view({
      name: "worker",
      id: "abcd1234",
      kind: "background",
      state: "working",
    }),
    view({ id: "beef0001", kind: "background", state: "working" }),
    view({
      name: "editor",
      sessionId: LIVE_ID,
      kind: "interactive",
      status: "busy",
      pid: 4321,
    }),
    {
      ...view({
        name: "earlier",
        sessionId: ENDED_ID,
        kind: "interactive",
        state: "done",
      }),
      finished: true,
      finishedAt: now - HOUR,
    },
  ];
}

const snapshot = (fields: Partial<Snapshot> = {}): Snapshot => ({
  sessions: sessions(Date.now()),
  error: null,
  warnings: [],
  ...fields,
});

let server: RunningServer;
let requests: ActionRequest[];
let reply: (request: ActionRequest) => ActionResult;
let hold: Promise<void> | null;

test.beforeEach(async () => {
  requests = [];
  hold = null;
  reply = () => ({ outcome: "succeeded", message: "Done." });
  server = await startServer({
    preferredPort: 0,
    webDir: resolve("dist/web"),
    onAction: async (request) => {
      requests.push(request);
      if (hold !== null) await hold;
      return reply(request);
    },
  });
});

test.afterEach(async () => {
  await server.close();
});

async function open(page: Page, data: Snapshot = snapshot()) {
  server.publish(data);
  await page.goto(server.loginUrl);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The data arrives over the live connection after the heading, so wait for it. Otherwise a test
  // that publishes again straight away could replace it before the page ever sees it.
  await expect(page.getByText("Loading sessions…")).toHaveCount(0);
}

const row = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ hasText: name }).first();
const actionsFor = (page: Page, label: RegExp) =>
  page.getByRole("group", { name: label });

test.describe("row actions", () => {
  test("offers each session's actions, and a live session's process ID instead of Open", async ({
    page,
  }) => {
    await open(page);

    const worker = actionsFor(page, /"worker"/);
    await expect(worker.getByRole("button")).toHaveText([
      "Open",
      "Stop…",
      "Delete…",
    ]);
    const editor = actionsFor(page, /"editor"/);
    await expect(editor.getByRole("button")).toHaveText(["End…"]);
    await expect(row(page, "editor")).toContainText("Process ID 4321");
    await expect(actionsFor(page, /"earlier"/).getByRole("button")).toHaveText([
      "Resume",
    ]);
  });

  test("runs Open straight away, with no dialog", async ({ page }) => {
    reply = () => ({ outcome: "started", message: "Terminal started." });
    await open(page);

    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Open" })
      .click();

    await expect(row(page, "worker")).toContainText("Open: Terminal started.");
    expect(requests).toEqual([{ action: "open", key: "abcd1234" }]);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("asks before stopping, names the session, and sends nothing on Cancel", async ({
    page,
  }) => {
    await open(page);

    const stop = actionsFor(page, /"worker"/).getByRole("button", {
      name: "Stop…",
    });
    await stop.click();
    const dialog = page.getByRole("alertdialog", {
      name: "Stop this session?",
    });
    await expect(dialog).toContainText('"worker" in sample');
    await expect(dialog).toContainText("The conversation is kept");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(stop).toBeFocused();
    expect(requests).toEqual([]);
  });

  test("closes the dialog with Escape and returns focus to the button", async ({
    page,
  }) => {
    await open(page);
    const del = actionsFor(page, /"worker"/).getByRole("button", {
      name: "Delete…",
    });
    await del.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("alertdialog", { name: "Delete this session?" }),
    ).toContainText("worktree");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(del).toBeFocused();
    expect(requests).toEqual([]);
  });

  test("names an unnamed session by folder, kind, and start time", async ({
    page,
  }) => {
    await open(page);

    await actionsFor(page, /Unnamed background session/)
      .getByRole("button", { name: "Stop…" })
      .click();

    await expect(page.getByRole("alertdialog")).toContainText(
      /Unnamed background session in sample, started \S/,
    );
  });

  test("stops after confirming with the keyboard, shows the result, and keeps focus", async ({
    page,
  }) => {
    let release = () => {};
    hold = new Promise((resolve) => {
      release = resolve;
    });
    reply = () => ({
      outcome: "succeeded",
      message: "Stopped. The conversation is kept.",
    });
    await open(page);

    const stop = actionsFor(page, /"worker"/).getByRole("button", {
      name: "Stop…",
    });
    await stop.click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Stop session" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");

    const pending = actionsFor(page, /"worker"/).getByRole("button", {
      name: /Stopping/,
    });
    await expect(pending).toBeVisible();
    await expect(
      actionsFor(page, /"worker"/).getByRole("button", { name: "Open" }),
    ).toBeDisabled();
    release();

    await expect(row(page, "worker")).toContainText(
      "Stop: Stopped. The conversation is kept.",
    );
    await expect(page.locator("[data-announcer]")).toHaveText(
      /Stop, "worker" in sample: Stopped/,
    );
    await expect(stop).toBeFocused();
    expect(requests).toEqual([{ action: "stop", key: "abcd1234" }]);
  });

  test("moves focus to the group heading when a deleted row goes, and keeps the result visible", async ({
    page,
  }) => {
    reply = () => ({ outcome: "succeeded", message: "Deleted." });
    await open(page);

    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Delete…" })
      .click();
    await page.getByRole("button", { name: "Delete session" }).click();
    await expect(row(page, "worker")).toContainText("Delete: Deleted.");

    server.publish(
      snapshot({
        sessions: sessions(Date.now()).filter(
          (session) => session.name !== "worker",
        ),
      }),
    );
    await expect(page.getByText("worker", { exact: false })).toHaveCount(1);
    await expect(
      page.getByText(/Delete, "worker" in sample: Deleted\./),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: /Active/ }),
    ).toBeFocused();
  });

  test("shows a refusal in the tool's words", async ({ page }) => {
    reply = () => ({
      outcome: "refused",
      message: "The session list is out of date. Try again when it refreshes.",
    });
    await open(page);

    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Stop…" })
      .click();
    await page.getByRole("button", { name: "Stop session" }).click();

    await expect(row(page, "worker")).toContainText(
      "Stop: The session list is out of date.",
    );
  });

  test("says the result is unknown when the answer can't be read", async ({
    page,
  }) => {
    await open(page);
    await page.route("**/api/actions", (route) =>
      route.fulfill({ status: 500, body: "oops" }),
    );

    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Open" })
      .click();

    await expect(row(page, "worker")).toContainText(
      "Open: The tool's answer couldn't be read, so the result is unknown.",
    );
  });
});

test.describe("End and Force end", () => {
  test("warns about lost work and the batch prompt, then offers Force end when the session stays", async ({
    page,
  }) => {
    reply = (request) =>
      request.action === "end"
        ? {
            outcome: "not-closed",
            message:
              "The session is still running. You can Force end it, which may lose work in progress.",
            closeRecord: { pid: 4321, processStartMs: 1 },
          }
        : { outcome: "succeeded", message: "Force ended." };
    await open(page);

    await actionsFor(page, /"editor"/)
      .getByRole("button", { name: "End…" })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "End this session?" });
    await expect(dialog).toContainText("Work in progress can be lost");
    await expect(dialog).toContainText("Terminate batch job (Y/N)?");
    await expect(dialog).toContainText("Git Bash");
    await dialog.getByRole("button", { name: "End session" }).click();

    await expect(row(page, "editor")).toContainText(
      "End: The session is still running.",
    );
    const force = actionsFor(page, /"editor"/).getByRole("button", {
      name: "Force end…",
    });
    await force.click();
    const second = page.getByRole("alertdialog", {
      name: "Force end this session?",
    });
    await expect(second).toContainText("dev servers");
    await expect(second).toContainText('"editor" in sample');
    await second.getByRole("button", { name: "Force end session" }).click();

    await expect(row(page, "editor")).toContainText("Force end: Force ended.");
    await expect(
      actionsFor(page, /"editor"/).getByRole("button", { name: "Force end…" }),
    ).toHaveCount(0);
    expect(requests).toEqual([
      { action: "end", key: LIVE_ID },
      { action: "forceEnd", key: LIVE_ID },
    ]);
  });

  test("doesn't offer Force end after a normal close", async ({ page }) => {
    reply = () => ({
      outcome: "succeeded",
      message: "Ended. The conversation is kept.",
    });
    await open(page);

    await actionsFor(page, /"editor"/)
      .getByRole("button", { name: "End…" })
      .click();
    await page.getByRole("button", { name: "End session" }).click();

    await expect(row(page, "editor")).toContainText("End: Ended.");
    await expect(page.getByRole("button", { name: "Force end…" })).toHaveCount(
      0,
    );
  });
});

test.describe("after the review", () => {
  test("keeps Force end offered when a second End is refused", async ({
    page,
  }) => {
    let calls = 0;
    reply = () => {
      calls += 1;
      return calls === 1
        ? {
            outcome: "not-closed",
            message: "The session is still running.",
            closeRecord: { pid: 4321, processStartMs: 1 },
          }
        : {
            outcome: "refused",
            message: "Another action on this session is still running.",
          };
    };
    await open(page);
    const actions = actionsFor(page, /"editor"/);

    for (let i = 0; i < 2; i += 1) {
      await actions.getByRole("button", { name: "End…", exact: true }).click();
      await page.getByRole("button", { name: "End session" }).click();
      await expect(row(page, "editor")).toContainText(
        i === 0 ? "still running" : "still running.",
      );
    }
    await expect(row(page, "editor")).toContainText("Another action");
    await expect(
      actions.getByRole("button", { name: "Force end…" }),
    ).toBeVisible();
  });

  test("closes the dialog when the session becomes protected while it's open", async ({
    page,
  }) => {
    await open(page);
    const end = actionsFor(page, /"editor"/).getByRole("button", {
      name: "End…",
    });
    await end.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();

    server.publish(snapshot({ protectedSessions: [LIVE_ID] }));

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.locator("[data-announcer]")).toHaveText(
      'End is no longer available for "editor" in sample.',
    );
    expect(requests).toEqual([]);
    // React Aria moves focus on when its trigger has gone, so it isn't lost.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .not.toBe("BODY");
  });

  test("doesn't pull keyboard focus back once the user has moved on", async ({
    page,
  }) => {
    await open(page);
    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Open" })
      .press("Enter");
    await expect(row(page, "worker")).toContainText("Open: Done.");

    const elsewhere = actionsFor(page, /Unnamed background session/).getByRole(
      "button",
      { name: "Open" },
    );
    await elsewhere.focus();
    await elsewhere.evaluate((node) => {
      (node as HTMLElement).blur();
    });
    server.publish(snapshot({ warnings: ["changed"] }));
    await expect(page.getByText(/may be missing/)).toBeVisible();

    await expect(
      actionsFor(page, /"worker"/).getByRole("button", { name: "Open" }),
    ).not.toBeFocused();
  });
});

test.describe("a finished session whose folder has gone", () => {
  test("offers no Resume", async ({ page }) => {
    await open(page, snapshot({ missingFolders: [ENDED_ID] }));

    await expect(row(page, "earlier")).toBeVisible();
    await expect(actionsFor(page, /"earlier"/)).toHaveCount(0);
    await expect(
      actionsFor(page, /"worker"/).getByRole("button", { name: "Open" }),
    ).toBeVisible();
  });
});

test.describe("self-protection on the page (FR-22)", () => {
  test("hides Stop, Delete, and End for every session while actions are turned off, and says why", async ({
    page,
  }) => {
    await open(page, snapshot({ actionsBlocked: "Actions are turned off." }));

    await expect(page.getByText("Actions are turned off.")).toBeVisible();
    await expect(actionsFor(page, /"worker"/).getByRole("button")).toHaveText([
      "Open",
    ]);
    await expect(actionsFor(page, /"editor"/)).toHaveCount(0);
  });

  test("hides them for the session that started the tool, and says so on its row", async ({
    page,
  }) => {
    await open(page, snapshot({ protectedSessions: [LIVE_ID] }));

    await expect(row(page, "editor")).toBeVisible();
    await expect(actionsFor(page, /"editor"/)).toHaveCount(0);
    await expect(row(page, "editor")).toContainText(
      "The dashboard was started from this session",
    );
    await expect(actionsFor(page, /"worker"/).getByRole("button")).toHaveText([
      "Open",
      "Stop…",
      "Delete…",
    ]);
  });
});

const DELETED_ID = "33333333-3333-4333-8333-333333333333";

/** A deleted session's leftover programs, with more than a row lists. */
function deletedOffer(count = 12): LeftoverOffer {
  const programs = Array.from({ length: count }, (_, index) => ({
    pid: 5000 + index,
    name: index === 0 ? "node.exe" : `tool${String(index)}.exe`,
  }));
  return {
    key: "dead0001",
    keys: ["dead0001", DELETED_ID],
    deleted: true,
    session: {
      ...toSessionView({
        id: "dead0001",
        sessionId: DELETED_ID,
        kind: "background",
        state: "stopped",
        cwd: "C:\\repos\\sample",
        name: "dev server",
      }),
    },
    programs,
    count,
  };
}

/** Leftover programs of the listed, finished "earlier" session. */
const endedOffer = (): LeftoverOffer => ({
  key: ENDED_ID,
  keys: [ENDED_ID],
  deleted: false,
  session: sessions(Date.now())[3] as SessionView,
  programs: [{ pid: 6001, name: "ping.exe" }],
  count: 1,
});

test.describe("leftover programs (FR-27)", () => {
  test("shows a deleted session at the top of Finished, with only its programs and the offer", async ({
    page,
  }) => {
    await open(page, snapshot({ leftovers: [deletedOffer()] }));
    const finished = page.getByRole("region", { name: /Finished/ });
    await expect(
      finished.getByRole("heading", { name: "Finished (2)" }),
    ).toBeVisible();
    const first = finished.getByRole("listitem").first();
    await expect(first).toContainText("dev server");
    await expect(first).toContainText("Deleted");
    await expect(first).toContainText("Programs still running");
    await expect(first).toContainText("node.exe, process 5000");
    await expect(first).toContainText("tool9.exe, process 5009");
    await expect(first).not.toContainText("tool10.exe");
    await expect(first).toContainText("and 2 more");
    await expect(
      first.getByRole("button", { name: "End leftover programs…" }),
    ).toBeVisible();
    // A deleted row isn't counted in the totals: they read the same without it.
    const usage = page.getByRole("region", { name: "Usage" });
    const withDeleted = await usage.innerText();
    server.publish(snapshot({ leftovers: [] }));
    await expect(page.getByText("Deleted", { exact: true })).toHaveCount(0);
    expect(await usage.innerText()).toBe(withDeleted);
    expect(withDeleted).toMatch(/4 sessions/);
  });

  test("lists every program in the dialog, says unsaved work is lost, and sends only the session", async ({
    page,
  }) => {
    reply = () => ({
      outcome: "succeeded",
      message: "Ended 12 of 12 programs.",
    });
    await open(page, snapshot({ leftovers: [deletedOffer()] }));
    await actionsFor(page, /Leftover programs of "dev server"/)
      .getByRole("button", { name: "End leftover programs…" })
      .click();
    const dialog = page.getByRole("alertdialog", {
      name: "End the programs this session left running?",
    });
    await expect(dialog).toContainText('"dev server" in sample');
    await expect(dialog).toContainText("tool11.exe, process 5011");
    await expect(dialog).toContainText("Unsaved work in them is lost");
    await expect(dialog).toContainText("the list may grow");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "End programs" }).click();

    await expect(
      page.getByRole("listitem").filter({ hasText: "Deleted" }),
    ).toContainText("End leftover programs: Ended 12 of 12 programs.");
    expect(requests).toEqual([{ action: "endLeftovers", key: "dead0001" }]);

    // Once nothing runs, the row goes, and the result stays above the list.
    server.publish(snapshot({ leftovers: [] }));
    await expect(page.getByText("Deleted", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(/End leftover programs, .*Ended 12 of 12/),
    ).toBeVisible();
  });

  test("shows a listed session's leftover programs on its own row", async ({
    page,
  }) => {
    await open(page, snapshot({ leftovers: [endedOffer()] }));
    const earlier = row(page, "earlier");
    await expect(earlier).toContainText("Programs still running");
    await expect(earlier).toContainText("ping.exe, process 6001");
    await expect(
      actionsFor(page, /Leftover programs of "earlier"/).getByRole("button", {
        name: "End leftover programs…",
      }),
    ).toBeVisible();
  });

  test("closes the dialog when the programs have all exited", async ({
    page,
  }) => {
    await open(page, snapshot({ leftovers: [endedOffer()] }));
    await actionsFor(page, /Leftover programs of "earlier"/)
      .getByRole("button", { name: "End leftover programs…" })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    server.publish(snapshot({ leftovers: [] }));
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("doesn't offer the button for a protected session, or while actions are turned off", async ({
    page,
  }) => {
    await open(
      page,
      snapshot({ leftovers: [endedOffer()], protectedSessions: [ENDED_ID] }),
    );
    await expect(row(page, "earlier")).toContainText("Programs still running");
    await expect(
      page.getByRole("button", { name: "End leftover programs…" }),
    ).toHaveCount(0);

    server.publish(
      snapshot({
        leftovers: [deletedOffer()],
        actionsBlocked: "Actions are turned off.",
      }),
    );
    await expect(page.getByText("Deleted", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "End leftover programs…" }),
    ).toHaveCount(0);
  });
});

test.describe("actions accessibility", () => {
  const scan = async (page: Page) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      violations.map(({ id, nodes }) => ({ id, count: nodes.length })),
    ).toEqual([]);
  };

  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme} theme has no automated WCAG violations with results and an open dialog`, async ({
      page,
    }) => {
      reply = () => ({ outcome: "kept", message: "Kept to protect its work." });
      await page.emulateMedia({ colorScheme });
      await open(page, snapshot({ protectedSessions: [LIVE_ID] }));
      await actionsFor(page, /"worker"/)
        .getByRole("button", { name: "Delete…" })
        .click();
      await page.getByRole("button", { name: "Delete session" }).click();
      await expect(row(page, "worker")).toContainText("Delete: Kept");
      await scan(page);

      await actionsFor(page, /"worker"/)
        .getByRole("button", { name: "Stop…" })
        .click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await scan(page);
    });

    test(`${colorScheme} theme has no automated WCAG violations with leftover programs and their dialog`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await open(page, snapshot({ leftovers: [deletedOffer(), endedOffer()] }));
      await expect(page.getByText("Deleted", { exact: true })).toBeVisible();
      await scan(page);
      await actionsFor(page, /Leftover programs of "dev server"/)
        .getByRole("button", { name: "End leftover programs…" })
        .click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await scan(page);
    });
  }

  test("the dialog fits a 320 px window and keeps focus inside", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 600 });
    await open(page);
    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Delete…" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((node) => node.contains(document.activeElement)),
      ).toBe(true);
    }
  });

  test("has no policy violations while using a dialog", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    await open(page);

    await actionsFor(page, /"worker"/)
      .getByRole("button", { name: "Stop…" })
      .click();
    await page.getByRole("button", { name: "Stop session" }).click();
    await expect(row(page, "worker")).toContainText("Stop: Done.");

    expect(problems).toEqual([]);
  });
});
