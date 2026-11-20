import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

/**
 * BUG-29 guard (0020): a terminal started by Open must not hold the tool's output open, so
 * something reading the tool's output through a pipe sees it end when the tool exits. It runs
 * the real launchDetached in a child Node process, compiled from open.ts, and starts a program
 * that outlives that child.
 */
const SOURCE = fileURLToPath(new URL("./open.ts", import.meta.url));
const OUTLIVES_MS = 4000;

let folder = "";
afterEach(() => {
  if (folder !== "") {
    rmSync(folder, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
  folder = "";
});

function buildChild(): string {
  folder = mkdtempSync(join(tmpdir(), "ccsm-bug29-"));
  const compiled = ts.transpileModule(readFileSync(SOURCE, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  writeFileSync(
    join(folder, "open.mjs"),
    compiled
      .replace('"./programs.js"', '"./programs.mjs"')
      .replace('"./posix-terminal.js"', '"./posix-terminal.mjs"'),
  );
  // launchDetached uses nothing from these; they only satisfy the imports.
  writeFileSync(
    join(folder, "programs.mjs"),
    "export const planOpen = () => undefined;\nexport const openArguments = () => [];\nexport const sessionLaunchEnv = (env) => env;\n",
  );
  writeFileSync(
    join(folder, "posix-terminal.mjs"),
    "export const openPosixTerminal = () => undefined;\n",
  );
  const child = join(folder, "child.mjs");
  writeFileSync(
    child,
    `import { launchDetached } from "./open.mjs";
await launchDetached(
  {
    file: process.execPath,
    args: ["-e", "setTimeout(() => {}, ${String(OUTLIVES_MS)})"],
    // Not the temporary folder, so it can be removed while this runs.
    cwd: ${JSON.stringify(tmpdir())},
  },
  process.env,
);
process.stdout.write("launched\\n");
`,
  );
  return child;
}

describe.runIf(process.platform === "win32")(
  "Open and the tool's output (BUG-29)",
  () => {
    it("lets the tool's output pipe close when the tool exits, while the started program runs on", async () => {
      const child = buildChild();
      const tool = spawn(process.execPath, [child], {
        cwd: folder,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      tool.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exited = new Promise<number>((resolve) => {
        tool.once("exit", () => {
          resolve(Date.now());
        });
      });
      const closed = new Promise<number>((resolve) => {
        tool.stdout.once("close", () => {
          resolve(Date.now());
        });
      });

      const exitedAt = await exited;
      const closedAt = await Promise.race([
        closed,
        new Promise<number>((resolve) =>
          setTimeout(() => resolve(Infinity), OUTLIVES_MS - 1000),
        ),
      ]);

      expect(output).toContain("launched");
      // Well before the started program ends, so it isn't holding the pipe.
      expect(closedAt - exitedAt).toBeLessThan(1000);
    }, 15_000);
  },
);
