import { describe, expect, it } from "vitest";
import { parseSessions } from "./schema.js";

const interactive = {
  cwd: "C:/work",
  kind: "interactive",
  startedAt: 1,
  status: "busy",
};
const background = {
  cwd: "C:/work",
  kind: "background",
  startedAt: 1,
  state: "working",
  id: "abc",
};

function without(source: Record<string, unknown>, field: string) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== field),
  );
}

function parse(entries: unknown) {
  return parseSessions(JSON.stringify(entries));
}

describe("parseSessions", () => {
  it("accepts documented sessions without warnings", () => {
    const result = parse([interactive, background]);
    expect(result.sessions).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("drops fields that are not on the allow-list, without warning", () => {
    const result = parse([
      {
        ...interactive,
        newField: "future",
        message: { content: "private text" },
      },
    ]);

    expect(result.sessions[0]).toEqual(interactive);
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private text");
  });

  it("rejects output that is not a JSON array", () => {
    expect(() => parseSessions("{}")).toThrow();
    expect(() => parseSessions("not json")).toThrow();
  });

  it("keeps a session and warns when an always-present field is missing", () => {
    const withoutStart = without(interactive, "startedAt");
    const result = parse([withoutStart]);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.cwd).toBe("C:/work");
    expect(result.warnings).toEqual([expect.stringContaining("startedAt")]);
  });

  it("treats a wrongly typed field as missing and warns", () => {
    const result = parse([{ ...interactive, startedAt: "yesterday" }]);

    expect(result.sessions[0]?.startedAt).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("startedAt")]);
  });

  it("keeps an unrecognized status for display and warns", () => {
    const result = parse([{ ...interactive, status: "hibernating" }]);

    expect(result.sessions[0]?.status).toBe("hibernating");
    expect(result.warnings).toEqual([expect.stringContaining("status")]);
  });

  it("does not put session values into warnings", () => {
    const result = parse([{ ...interactive, status: "C:/private/path" }]);
    expect(JSON.stringify(result.warnings)).not.toContain("private");
  });

  it("does not require status on a background session whose process has exited", () => {
    expect(parse([background]).warnings).toEqual([]);
  });

  it("warns when a background session has no state", () => {
    const withoutState = without(background, "state");
    expect(parse([withoutState]).warnings).toEqual([
      expect.stringContaining("state"),
    ]);
  });

  describe("an interactive session with no status", () => {
    const identified = { ...without(interactive, "status"), sessionId: "a" };
    const parseKnown = (known: string[]) =>
      parseSessions(JSON.stringify([identified]), new Set(known));

    it("is excused on its first listing", () => {
      expect(parseKnown([]).warnings).toEqual([]);
    });

    it("gets a warning once the session is known", () => {
      expect(parseKnown(["a"]).warnings).toEqual([
        expect.stringContaining("status"),
      ]);
    });

    it("gets a warning straight away if it can't be identified", () => {
      expect(parse([without(interactive, "status")]).warnings).toEqual([
        expect.stringContaining("status"),
      ]);
    });
  });

  it("reports which sessions it listed", () => {
    const { listed } = parse([
      { ...interactive, sessionId: "a" },
      { ...background, sessionId: undefined, id: "b" },
      interactive,
    ]);
    expect([...listed].sort()).toEqual(["a", "b"]);
  });

  it("warns when a waiting session has no reason", () => {
    expect(parse([{ ...interactive, status: "waiting" }]).warnings).toEqual([
      expect.stringContaining("waitingFor"),
    ]);
  });

  it("skips an entry that is not an object and warns", () => {
    const result = parse([interactive, "oops", null]);
    expect(result.sessions).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("reports each warning once across sessions", () => {
    const withoutStart = without(interactive, "startedAt");
    expect(parse([withoutStart, withoutStart]).warnings).toHaveLength(1);
  });
});
