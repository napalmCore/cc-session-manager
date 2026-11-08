import { describe, expect, it, vi } from "vitest";
import type { Session, SessionView } from "../shared/protocol.js";
import { createFolderWatch, FOLDER_CHECK_MS, MAX_CHECKS } from "./folders.js";
import { toSessionView } from "./rules.js";

const ID = "11111111-1111-4111-8111-111111111111";

const finished = (cwd: string, fields: Session = {}): SessionView => ({
  ...toSessionView({ sessionId: ID, kind: "interactive", cwd, ...fields }),
  finished: true,
});

/** Lets the background checks settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(exists: (path: string) => boolean) {
  let clock = 1_000;
  const onChange = vi.fn();
  const isFolder = vi.fn((path: string) => Promise.resolve(exists(path)));
  const watch = createFolderWatch({ onChange, isFolder, now: () => clock });
  return {
    watch,
    onChange,
    isFolder,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createFolderWatch", () => {
  it("counts a folder as present until it has been checked, then reports it gone", async () => {
    const { watch, onChange } = setup(() => false);
    const sessions = [finished("C:\\gone")];

    expect(watch.missing(sessions)).toEqual([]);
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watch.missing(sessions)).toEqual([ID]);
  });

  it("reports nothing and doesn't resend for a folder that exists", async () => {
    const { watch, onChange } = setup(() => true);
    watch.missing([finished("C:\\here")]);
    await settle();

    expect(onChange).not.toHaveBeenCalled();
    expect(watch.missing([finished("C:\\here")])).toEqual([]);
  });

  it("checks each folder once per interval, however many sessions share it", async () => {
    const { watch, isFolder, advance } = setup(() => true);
    const sessions = [
      finished("C:\\same"),
      finished("C:\\same", { sessionId: "x" }),
    ];

    watch.missing(sessions);
    watch.missing(sessions);
    await settle();
    watch.missing(sessions);
    expect(isFolder).toHaveBeenCalledTimes(1);

    advance(FOLDER_CHECK_MS);
    watch.missing(sessions);
    expect(isFolder).toHaveBeenCalledTimes(2);
  });

  it("notices a folder deleted later, and resends once", async () => {
    let present = true;
    const { watch, onChange, advance } = setup(() => present);
    const sessions = [finished("C:\\later")];
    watch.missing(sessions);
    await settle();

    present = false;
    advance(FOLDER_CHECK_MS);
    watch.missing(sessions);
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(watch.missing(sessions)).toEqual([ID]);
  });

  it("gives both keys of a session that has them", async () => {
    const { watch } = setup(() => false);
    const sessions = [finished("C:\\gone", { id: "abcd1234" })];
    watch.missing(sessions);
    await settle();

    expect(watch.missing(sessions)).toEqual(["abcd1234", ID]);
  });

  it.each([
    [
      "a live interactive session",
      { ...finished("C:\\gone"), finished: false },
    ],
    [
      "a background session",
      { ...finished("C:\\gone", { kind: "background" }) },
    ],
    [
      "a session with no folder",
      toSessionView({ sessionId: ID, kind: "interactive" }),
    ],
  ])("ignores %s", async (_label, session) => {
    const { watch, isFolder } = setup(() => false);
    watch.missing([session]);
    await settle();

    expect(isFolder).not.toHaveBeenCalled();
    expect(watch.missing([session])).toEqual([]);
  });

  it.each(["\\\\server\\share\\proj", "//server/share/proj"])(
    "never checks a network folder such as %s",
    async (cwd) => {
      const { watch, isFolder } = setup(() => false);
      watch.missing([finished(cwd)]);
      await settle();

      expect(isFolder).not.toHaveBeenCalled();
    },
  );

  it("runs at most a few checks at once, so a hung drive can't take every thread", () => {
    const isFolder = vi.fn(() => new Promise<boolean>(() => undefined));
    const watch = createFolderWatch({ onChange: vi.fn(), isFolder });
    watch.missing(["C:/a", "C:/b", "C:/c", "C:/d"].map((cwd) => finished(cwd)));

    expect(isFolder).toHaveBeenCalledTimes(MAX_CHECKS);
  });

  it("keeps running when resending the snapshot throws", async () => {
    const watch = createFolderWatch({
      onChange: () => {
        throw new Error("send failed");
      },
      isFolder: () => Promise.resolve(false),
    });
    watch.missing([finished("C:/gone")]);
    await settle();

    expect(watch.missing([finished("C:/gone")])).toEqual([ID]);
  });

  it("treats a check that fails as a missing folder", async () => {
    const onChange = vi.fn();
    const watch = createFolderWatch({
      onChange,
      isFolder: () => Promise.reject(new Error("EACCES")),
    });
    watch.missing([finished("C:\\locked")]);
    await settle();

    expect(watch.missing([finished("C:\\locked")])).toEqual([ID]);
  });
});
