import { describe, expect, it } from "vitest";
import { classifySandboxFault, KERNEL_LOG_NOT_AVAILABLE, mayBeSandboxFault, parseSandboxPeak } from "~/domain/runs/sandbox-fault.js";

// docs/specs/sandbox-memory-and-size.md. A wrong call here either spends repairs on correct code
// or hides a real test failure as a sandbox fault.
const KILL = "[ 812.31] Out of memory: Killed process 4242 (dotnet) total-vm:5123456kB, anon-rss:3012345kB";

describe("classifySandboxFault", () => {
  it("names an exit 137 with a kill line as out of memory, with the killed process", () => {
    const reading = classifySandboxFault({ exitCode: 137, stoppedByFactoree: false, output: "" }, ["boot", KILL]);
    expect(reading.fault).toEqual({ kind: "sandbox_out_of_memory", killed: ["dotnet (pid 4242)"], kernelLines: [KILL] });
  });

  it("keeps an exit 137 with no kill line a plain failure", () => {
    expect(classifySandboxFault({ exitCode: 137, stoppedByFactoree: false, output: "" }, ["boot"])).toEqual({ fault: null, note: null });
  });

  it("guesses nothing when the kernel log is not available", () => {
    expect(classifySandboxFault({ exitCode: 137, stoppedByFactoree: false, output: "" }, null)).toEqual({ fault: null, note: KERNEL_LOG_NOT_AVAILABLE });
  });

  it("never calls a check Factoree stopped a sandbox fault", () => {
    expect(classifySandboxFault({ exitCode: 137, stoppedByFactoree: true, output: "" }, [KILL])).toEqual({ fault: null, note: null });
    expect(mayBeSandboxFault({ exitCode: 137, stoppedByFactoree: true, output: "" })).toBe(false);
  });

  it("reads a test failure with exit 1 as no fault, and never reads the kernel log for it", () => {
    expect(mayBeSandboxFault({ exitCode: 1, stoppedByFactoree: false, output: "1 test failed" })).toBe(false);
    expect(classifySandboxFault({ exitCode: 1, stoppedByFactoree: false, output: "1 test failed" }, [KILL])).toEqual({ fault: null, note: null });
  });

  it("names a step with no exit code out of memory only on a kill line", () => {
    expect(classifySandboxFault({ exitCode: null, stoppedByFactoree: false, output: "container exited" }, [KILL]).fault?.kind).toBe("sandbox_out_of_memory");
    expect(classifySandboxFault({ exitCode: null, stoppedByFactoree: false, output: "container exited" }, null)).toEqual({ fault: null, note: null });
  });

  it("names a full disk from the output", () => {
    const reading = classifySandboxFault({ exitCode: 1, stoppedByFactoree: false, output: "write /home/agent/x: no space left on device".replace("no", "No") }, []);
    expect(reading.fault?.kind).toBe("sandbox_disk_full");
  });
});

describe("parseSandboxPeak", () => {
  it("reads the sampler line and refuses a malformed one", () => {
    expect(parseSandboxPeak("3041 43386 7937 59768\n")).toEqual({ memoryMb: 3041, diskMb: 43386, totalMemoryMb: 7937, totalDiskMb: 59768 });
    expect(parseSandboxPeak("")).toBeNull();
    expect(parseSandboxPeak("3041 x 7937 59768")).toBeNull();
  });
});
