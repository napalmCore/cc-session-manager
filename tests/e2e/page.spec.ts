/// <reference lib="dom" />
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { toSessionView } from "../../src/server/rules.js";
import type { ActionRequest, ActionResult } from "../../src/server/actions.js";
import type { Search, SearchStatus } from "../../src/server/search.js";
import { startServer, type RunningServer } from "../../src/server/server.js";
import type { SessionView, Snapshot } from "../../src/shared/protocol.js";

const HOUR = 3_600_000;
const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const PAST_ID = "33333333-3333-4333-8333-333333333333";
const LISTED_PAST_ID = "44444444-4444-4444-8444-444444444444";
const SEARCH_ID = "0123456789abcdef0123456789abcdef";

function sessions(now: number): SessionView[] {
  return [
    {
      ...toSessionView({
        name: "editor",
        sessionId: LIVE_ID,
        cwd: "C:\\repos\\sample",
        kind: "interactive",
        status: "busy",
        pid: 4321,
        startedAt: now - HOUR,
      }),
      lastActivityAt: now - 60_000,
    },
    {
      ...toSessionView({
        name: "worker",
        id: "abcd1234",
        cwd: "C:\\repos\\sample",
        kind: "background",
        state: "working",
        startedAt: now - HOUR,
      }),
    },
  ];
}

const snapshot = (): Snapshot => ({
  sessions: sessions(Date.now()),
  error: null,
  warnings: [],
});

function historyReply(page = 0, pages = 2): ActionResult {
  const now = Date.now();
  return {
    outcome: "succeeded",
    message: "History read.",
    history: {
      page,
      pages,
      total: 52,
      sessions: [
        {
          sessionId:
            page === 0 ? PAST_ID : "55555555-5555-4555-8555-555555555555",
          folder: "C:\\repos\\old",
          startedAt: now - 30 * HOUR,
          lastActivityAt: now - 29 * HOUR,
          gitBranch: "main",
          inList: false,
        },
        {
          sessionId: LISTED_PAST_ID,
          folder: "C:\\repos\\sample",
          startedAt: now - 3 * HOUR,
          lastActivityAt: now - 2 * HOUR,
          inList: true,
        },
      ],
    },
  };
}

let server: RunningServer;
let requests: ActionRequest[];
let reply: (request: ActionRequest) => ActionResult;
let searchQueries: string[];
let polls: SearchStatus[];
let cancels: number;

test.beforeEach(async () => {
  requests = [];
  searchQueries = [];
  cancels = 0;
  polls = [
    { status: "running", filesDone: 3, filesTotal: 10 },
    {
      status: "done",
      filesDone: 10,
      filesTotal: 10,
      stopped: false,
      sessions: [
        {
          sessionId: PAST_ID,
          count: 2,
          snippets: ["…the needle in a <b>haystack</b>…", "another needle"],
          folder: "C:\\repos\\old",
          lastActivityAt: Date.now() - 29 * HOUR,
          inList: false,
        },
      ],
    },
  ];
  reply = (request) => {
    if (request.action === "history") return historyReply(request.page ?? 0);
    if (request.action === "listFolders") {
      return request.folder === "C:\\repos"
        ? {
            outcome: "succeeded",
            message: "Folders listed.",
            folder: "C:\\repos",
            folders: ["alpha", "beta"],
            drives: ["C:\\"],
          }
        : {
            outcome: "succeeded",
            message: "Folders listed.",
            folder: "C:\\Users\\me",
            folders: ["repos", "Documents"],
            drives: ["C:\\", "D:\\"],
          };
    }
    if (request.action === "start" || request.action === "fork") {
      return { outcome: "started", message: "The session started." };
    }
    return { outcome: "succeeded", message: "Done." };
  };
  const search = {
    start: (query: string) => {
      searchQueries.push(query);
      return query.trim().length >= 2 ? SEARCH_ID : null;
    },
    poll: () => polls.shift() ?? { status: "gone" },
    cancel: () => {
      cancels += 1;
      return true;
    },
  };
  server = await startServer({
    preferredPort: 0,
    webDir: resolve("dist/web"),
    onAction: (request) => {
      requests.push(request);
      return Promise.resolve(reply(request));
    },
    search: search as unknown as Search,
  });
});

test.afterEach(async () => {
  await server.close();
});

async function open(page: Page) {
  server.publish(snapshot());
  await page.goto(server.loginUrl);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Loading sessions…")).toHaveCount(0);
}

const views = (page: Page) => page.getByRole("navigation", { name: "Views" });

test.describe("views (0025)", () => {
  test("moves between Sessions, History, and Search by address, and Back returns", async ({
    page,
  }) => {
    await open(page);
    await expect(views(page).getByRole("link")).toHaveText([
      "Sessions",
      "History",
      "Search",
    ]);
    await expect(
      views(page).getByRole("link", { name: "Sessions" }),
    ).toHaveAttribute("aria-current", "page");

    await views(page).getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL(/#history$/);
    await expect(page.getByRole("heading", { name: /^History/ })).toBeFocused();
    await expect(page.getByText("editor")).toHaveCount(0);

    await views(page).getByRole("link", { name: "Search" }).click();
    await expect(page.getByRole("heading", { name: "Search" })).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(/#history$/);
    await expect(page.getByRole("heading", { name: /^History/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: /^History/ })).toBeVisible();
    // The page key survives the reload, so History still loads.
    await expect(page.getByText("C:\\repos\\old").first()).toBeVisible();
  });
});

test.describe("New session (FR-32)", () => {
  test("starts a background session from the form, and focus returns to the button", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "New session…" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(dialog.getByLabel("Folder")).toBeFocused();
    await dialog.getByLabel("Folder").fill("C:\\repos\\sample");
    await dialog.getByLabel("Name (optional)").fill("tidy");
    await dialog.getByLabel("Prompt", { exact: true }).fill("Tidy the README");
    await dialog.getByRole("button", { name: "Start session" }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests.at(-1)).toEqual({
      action: "start",
      folder: "C:\\repos\\sample",
      kind: "background",
      name: "tidy",
      prompt: "Tidy the README",
    });
    await expect(page.locator("[data-announcer]")).toHaveText(
      "New session: The session started.",
    );
    await expect(
      page.getByRole("button", { name: "New session…" }),
    ).toBeFocused();
  });

  test("a terminal session sends no prompt, and a refusal stays in the form", async ({
    page,
  }) => {
    reply = () => ({ outcome: "refused", message: "A name can't contain %." });
    await open(page);
    await page.getByRole("button", { name: "New session…" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await dialog.getByLabel("Folder").fill("C:\\repos\\sample");
    await dialog.getByText("In a new terminal").click();
    await expect(dialog.getByLabel("Prompt", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Name (optional)").fill("50%");
    await dialog.getByRole("button", { name: "Start session" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "A name can't contain %.",
    );
    expect(requests.at(-1)).toEqual({
      action: "start",
      folder: "C:\\repos\\sample",
      kind: "interactive",
      name: "50%",
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "New session…" }),
    ).toBeFocused();
  });

  test("Browse lists folders through the server and fills the folder in", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "New session…" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await dialog.getByRole("button", { name: "Browse…" }).click();
    await expect(dialog.getByText("C:\\Users\\me")).toBeVisible();
    await expect(
      dialog.getByRole("list", { name: "Drives" }).getByRole("button"),
    ).toHaveText(["C:\\", "D:\\"]);
    await dialog.getByRole("button", { name: "Up one level" }).click();
    expect(requests.at(-1)).toEqual({
      action: "listFolders",
      folder: "C:\\Users",
    });
    reply = (request) =>
      request.action === "listFolders"
        ? {
            outcome: "succeeded",
            message: "Folders listed.",
            folder: "C:\\repos",
            folders: ["alpha", "beta"],
            drives: [],
          }
        : { outcome: "succeeded", message: "Done." };
    await dialog.getByRole("button", { name: "Up one level" }).click();
    await expect(dialog.getByText("C:\\repos", { exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Use this folder" }).click();
    await expect(dialog.getByLabel("Folder")).toHaveValue("C:\\repos");
    await expect(dialog.getByLabel("Folder")).toBeFocused();
  });
});

test.describe("Fork (FR-33)", () => {
  test("is offered on rows with a session ID, and runs in the session's own folder", async ({
    page,
  }) => {
    await open(page);
    const editor = page.getByRole("group", { name: /"editor"/ });
    await expect(editor.getByRole("button", { name: "Fork…" })).toBeVisible();
    await expect(
      page.getByRole("group", { name: /"worker"/ }).getByRole("button", {
        name: "Fork…",
      }),
    ).toHaveCount(0);

    await editor.getByRole("button", { name: "Fork…" }).click();
    const dialog = page.getByRole("dialog", { name: "Fork session" });
    await expect(dialog).toContainText("Folder: C:\\repos\\sample");
    await expect(dialog.getByLabel("Folder")).toHaveCount(0);
    await dialog.getByText("In a new terminal").click();
    await dialog.getByRole("button", { name: "Fork session" }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests.at(-1)).toEqual({
      action: "fork",
      key: LIVE_ID,
      kind: "interactive",
    });
    await expect(editor.getByRole("button", { name: "Fork…" })).toBeFocused();
  });
});

test.describe("History (FR-35)", () => {
  test("lists past sessions with Resume and Fork, pages, and leaves Resume to the list for listed ones", async ({
    page,
  }) => {
    await open(page);
    await views(page).getByRole("link", { name: "History" }).click();
    await expect(
      page.getByRole("heading", { name: "History (52)" }),
    ).toBeVisible();
    const past = page.getByRole("group", { name: /C:\\repos\\old/ });
    const listed = page.getByRole("group", { name: /C:\\repos\\sample/ });
    await expect(past.getByRole("button")).toHaveText(["Resume", "Fork…"]);
    await expect(listed.getByRole("button")).toHaveText(["Fork…"]);
    await expect(
      page.getByText("Also in the session list, where it can be resumed."),
    ).toBeVisible();

    await past.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText("Resume: Done.")).toBeVisible();
    expect(requests.at(-1)).toEqual({ action: "resume", key: PAST_ID });

    await page.getByRole("button", { name: "Older" }).click();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    expect(requests.at(-1)).toEqual({ action: "history", page: 1 });
    await expect(
      page.getByRole("heading", { name: "History (52)" }),
    ).toBeFocused();
  });
});

test.describe("Search (FR-36)", () => {
  test("searches, shows progress, then matches as plain text, with Resume and Fork", async ({
    page,
  }) => {
    await open(page);
    await views(page).getByRole("link", { name: "Search" }).click();
    const box = page.getByRole("searchbox", {
      name: "Search your prompts and Claude's replies",
    });
    await box.fill("needle");
    await box.press("Enter");
    await expect(
      page
        .getByRole("region", { name: "Search" })
        .getByText("1 conversation matches."),
    ).toBeVisible();
    expect(searchQueries).toEqual(["needle"]);
    const matches = page.getByRole("list", { name: /Matches in/ });
    // Snippets are shown as text, never as markup.
    await expect(matches.getByRole("listitem")).toHaveText([
      "…the needle in a <b>haystack</b>…",
      "another needle",
    ]);
    await expect(page.getByText("2 matches")).toBeVisible();
    await expect(
      page.getByRole("group", { name: /C:\\repos\\old/ }).getByRole("button"),
    ).toHaveText(["Resume", "Fork…"]);
    await expect(page.locator("[data-announcer]")).toHaveText(
      "1 conversation matches.",
    );
  });

  test("cancels a running search when asked, and when leaving the view", async ({
    page,
  }) => {
    polls = Array.from({ length: 100 }, () => ({
      status: "running" as const,
      filesDone: 1,
      filesTotal: 10,
    }));
    await open(page);
    await views(page).getByRole("link", { name: "Search" }).click();
    const box = page.getByRole("searchbox");
    await box.fill("needle");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("1 of 10 conversations read")).toBeVisible();
    await page.getByRole("button", { name: "Cancel search" }).click();
    await expect.poll(() => cancels).toBe(1);

    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("1 of 10 conversations read")).toBeVisible();
    await views(page).getByRole("link", { name: "Sessions" }).click();
    await expect.poll(() => cancels).toBe(2);
  });
});

test.describe("accessibility (NFR-16)", () => {
  const check = async (page: Page) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(violations).toEqual([]);
  };

  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme} theme has no automated WCAG violations in the new views and forms`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await open(page);
      await page.getByRole("button", { name: "New session…" }).click();
      const dialog = page.getByRole("dialog", { name: "New session" });
      await dialog.getByRole("button", { name: "Browse…" }).click();
      await expect(dialog.getByText("C:\\Users\\me")).toBeVisible();
      await check(page);
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await page
        .getByRole("group", { name: /"editor"/ })
        .getByRole("button", { name: "Fork…" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Fork session" }),
      ).toBeVisible();
      await check(page);
      await page.getByRole("button", { name: "Cancel" }).click();

      await views(page).getByRole("link", { name: "History" }).click();
      await expect(page.getByText("Page 1 of 2")).toBeVisible();
      await check(page);

      await views(page).getByRole("link", { name: "Search" }).click();
      await page.getByRole("searchbox").fill("needle");
      await page.getByRole("searchbox").press("Enter");
      await expect(
        page
          .getByRole("region", { name: "Search" })
          .getByText("1 conversation matches."),
      ).toBeVisible();
      await check(page);
    });
  }
});
