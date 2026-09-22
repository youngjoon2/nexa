import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const launchers = ["setup", "start", "stop", "test-process-ownership", "test-session-settings"];

// Most cases replace PowerShell implementations with inert probes. The real
// stop-script case uses an empty process record; no live services are controlled.
const probe = `
[CmdletBinding()]
param(
    [string]$CachePath,
    [string]$DataDirectory,
    [switch]$CheckOnly,
    [switch]$NoModels,
    [switch]$Offline,
    [ValidateRange(0,255)][int]$ExitCode = 0
)
$result = @{
    script = $MyInvocation.MyCommand.Name
    scriptRoot = $PSScriptRoot
    workingDirectory = (Get-Location).ProviderPath
    cachePath = $CachePath
    dataDirectory = $DataDirectory
    checkOnly = [bool]$CheckOnly
    noModels = [bool]$NoModels
    offline = [bool]$Offline
    environmentDataDirectory = $env:NEXA_DATA_DIR
    environmentApiKey = $env:NEXA_API_KEY
    fileHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256 -ErrorAction Stop).Hash
}
[IO.File]::WriteAllText($env:NEXA_LAUNCHER_TEST_OUTPUT, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
exit $ExitCode
`;

describe.skipIf(process.platform !== "win32")("Windows CMD launchers", () => {
  let directory: string;
  let fixtureScripts: string;
  let workingDirectory: string;
  let output: string;
  let inheritedModules: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "nexa-cmd-launchers-"));
    fixtureScripts = join(directory, "프로젝트 with spaces & !", "scripts");
    workingDirectory = join(directory, "unrelated working directory");
    output = join(directory, "probe.json");
    inheritedModules = join(directory, "incompatible parent modules");
    mkdirSync(fixtureScripts, { recursive: true });
    mkdirSync(workingDirectory);
    // Emulate PowerShell 7 modules shadowing Windows PowerShell's own modules.
    // Clearing the inherited PSModulePath must restore the built-in Get-FileHash.
    const shadowModule = join(inheritedModules, "Microsoft.PowerShell.Utility");
    mkdirSync(shadowModule, { recursive: true });
    writeFileSync(join(shadowModule, "Microsoft.PowerShell.Utility.psm1"),
      "function Get-FileHash { throw 'Incompatible inherited Utility module loaded' }\nExport-ModuleMember -Function Get-FileHash\n");
    for (const name of launchers) {
      copyFileSync(join(scripts, `${name}.cmd`), join(fixtureScripts, `${name}.cmd`));
      writeFileSync(join(fixtureScripts, `${name}.ps1`), probe);
    }
  });

  afterEach(() => {
    const target = resolve(directory);
    if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith("nexa-cmd-launchers-")) {
      throw new Error(`Refusing to remove an unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  });

  function run(name: string, args: string[] = []) {
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    // Supply cmd.exe's command string verbatim, including its outer quote pair.
    // CALL would parse/expand the arguments a second time and hide quoting bugs.
    const command = `""${join(fixtureScripts, `${name}.cmd`)}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
    const result = spawnSync(executable, ["/d", "/s", "/c", command], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        PSModulePath: inheritedModules,
        NEXA_LAUNCHER_TEST_OUTPUT: output,
        NEXA_DATA_DIR: join(directory, "환경 데이터 & !"),
        NEXA_API_KEY: "fixture key & ! local only",
      },
      windowsVerbatimArguments: true,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    expect(result.signal).toBeNull();
    return result;
  }

  for (const name of launchers) {
    test(`${name}.cmd resolves its sibling, preserves inputs and loads built-in modules`, () => {
      const cachePath = join(directory, "캐시 path & !");
      const dataDirectory = join(directory, "데이터 path & !");
      const result = run(name, ["-CachePath", cachePath, "-DataDirectory", dataDirectory, "-CheckOnly", "-NoModels", "-Offline"]);
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        script: `${name}.ps1`,
        scriptRoot: fixtureScripts,
        workingDirectory,
        cachePath,
        dataDirectory,
        checkOnly: true,
        noModels: true,
        offline: true,
        environmentDataDirectory: join(directory, "환경 데이터 & !"),
        environmentApiKey: "fixture key & ! local only",
        fileHash: createHash("sha256").update(probe).digest("hex").toUpperCase(),
      });
    }, 20_000);

    test(`${name}.cmd propagates a nonzero script exit code`, () => {
      expect(run(name, ["-ExitCode", "37"]).status).toBe(37);
      expect(existsSync(output)).toBe(true);
    }, 20_000);

    test(`${name}.cmd propagates PowerShell parameter errors`, () => {
      const result = run(name, ["-ExitCode", "256"]);
      expect(result.status).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(existsSync(output)).toBe(false);
    }, 20_000);
  }

  test("stop.cmd reads UTF-8 session paths and preserves data across repeated stops", () => {
    for (const name of ["stop.ps1", "common.ps1"]) {
      copyFileSync(join(scripts, name), join(fixtureScripts, name));
    }
    const dataDirectory = join(directory, "보존할 데이터 & !");
    const statePath = join(dataDirectory, "run", "processes.json");
    const preservedFile = join(dataDirectory, "saved.txt");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(preservedFile, "보존된 사용자 데이터\n");
    // Write UTF-8 without a BOM, matching Write-NexaState in common.ps1.
    writeFileSync(statePath, JSON.stringify({ root: dirname(fixtureScripts), processes: [] }), "utf8");

    expect(run("stop", ["-DataDirectory", dataDirectory]).status).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(readFileSync(preservedFile, "utf8")).toBe("보존된 사용자 데이터\n");
    expect(run("stop", ["-DataDirectory", dataDirectory]).status).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(readFileSync(preservedFile, "utf8")).toBe("보존된 사용자 데이터\n");
  }, 35_000);
});
