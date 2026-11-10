import { describe, expect, it } from "vitest";
import type { Session } from "../shared/protocol.js";
import { toSessionView } from "./rules.js";
import { createSessionMemory, STARTING_MS } from "./session-memory.js";

function setup() {
  let time = 1_000_000;
  const memory = createSessionMemory(() => time);
  return {
    memory,
    advance: (ms: number) => {
      time += ms;
    },
    time: () => time,
  };
}

describe("createSessionMemory", () => {
  it("keeps the first start time seen, and leaves startedAt as listed (BUG-23)", () => {
    const { memory } = setup();
    const before: Session = { id: "bg", kind: "background", startedAt: 100 };
    memory.observe([before]);
    const after: Session = { ...before, startedAt: 3_100, pid: 9 };
    memory.observe([after]);

    const [view] = memory.recall([toSessionView(after)]);

    expect(view?.firstStartedAt).toBe(100);
    expect(view?.startedAt).toBe(3_100);
  });

  it("keeps the first start time when the session gains a session ID with its process", () => {
    const { memory } = setup();
    memory.observe([{ id: "bg", kind: "background", startedAt: 100 }]);
    const after: Session = {
      id: "bg",
      sessionId: "uuid",
      kind: "background",
      startedAt: 3_100,
      pid: 9,
    };
    memory.observe([after]);

    expect(memory.recall([toSessionView(after)])[0]?.firstStartedAt).toBe(100);
  });

  it("starts over for a resumed session, which keeps its session ID", () => {
    const { memory, advance } = setup();
    const first: Session = { sessionId: "a", pid: 1, startedAt: 100 };
    memory.observe([first]);
    advance(20_000);
    memory.observe([]);
    // Within 30 seconds of the first start, so only the new process ID makes it a new run.
    const resumed: Session = { sessionId: "a", pid: 2, startedAt: 20_100 };
    memory.observe([resumed]);

    expect(memory.recall([toSessionView(resumed)])[0]?.firstStartedAt).toBe(
      20_100,
    );
  });

  it("starts over when the start time moves far, even with the same process ID", () => {
    const { memory } = setup();
    memory.observe([{ id: "bg", startedAt: 100 }]);
    const later: Session = { id: "bg", startedAt: 100 + 60_000 };
    memory.observe([later]);

    expect(memory.recall([toSessionView(later)])[0]?.firstStartedAt).toBe(
      60_100,
    );
  });

  it("keeps the last known activity when a transcript can't be read (BUG-13)", () => {
    const { memory } = setup();
    const session: Session = { sessionId: "a", kind: "interactive" };
    memory.observe([session]);
    memory.recall([{ ...toSessionView(session), lastActivityAt: 42 }]);

    const [view] = memory.recall([toSessionView(session)]);

    expect(view?.lastActivityAt).toBe(42);
  });

  it("treats a session as starting only if it started near when it was first seen", () => {
    const { memory, time, advance } = setup();
    const fresh: Session = { pid: 1, startedAt: time() - 2_000 };
    const existing: Session = { pid: 2, startedAt: time() - 60_000 };

    expect(memory.isStarting(fresh)).toBe(true);
    expect(memory.isStarting(existing)).toBe(false);

    memory.observe([fresh]);
    advance(STARTING_MS);
    expect(memory.isStarting(fresh)).toBe(false);
  });

  it("knows a process by ID and start time, whatever its session ID (BUG-20)", () => {
    const { memory, time, advance } = setup();
    const first: Session = { pid: 1, startedAt: time() };
    memory.observe([first]);
    advance(STARTING_MS);

    expect(memory.isStarting({ ...first, sessionId: "new" })).toBe(false);
  });

  it("forgets sessions unlisted for 10 minutes", () => {
    const { memory, advance } = setup();
    const session: Session = { sessionId: "a", startedAt: 5 };
    memory.observe([session]);
    advance(10 * 60 * 1000);
    memory.observe([]);

    const [view] = memory.recall([toSessionView({ ...session, startedAt: 9 })]);
    expect(view?.firstStartedAt).toBeUndefined();
  });
});
