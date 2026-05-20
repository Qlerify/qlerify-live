import { describe, it, expect } from "vitest";
import { recordBoardTestPass, recordFAIPass } from "../../src/test/test-result/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Record Board Test Pass", () => {
  it("Given production is IN_PROGRESS, When board test passes, Then a test_result row with test_type BOARD and result PASS is created per produced unit", async () => {
    const w = await givenUpTo("after_production_started");
    const tr = await recordBoardTestPass(
      { buildId: w.buildId, unitSerial: "B1-SN-0001", executedAt: "2026-04-22T10:00:00Z" },
      "Test Engineer",
    );
    expect(tr.testType).toBe("BOARD");
    expect(tr.result).toBe("PASS");
    expect(await eventLogged("#/domainEvents/BoardTestPassed")).toBe(true);
  });

  it("rejects when build is not IN_PROGRESS", async () => {
    const w = await givenUpTo("after_kit_ready");
    await expect(
      recordBoardTestPass(
        { buildId: w.buildId, unitSerial: "B1-SN-0001", executedAt: "2026-04-22T10:00:00Z" },
        "Test Engineer",
      ),
    ).rejects.toThrow(/IN_PROGRESS/);
  });
});

describe("Record FAI Pass", () => {
  it("Given board tests have passed, When FAI passes, Then a test_result row with test_type FAI and result PASS is created", async () => {
    const w = await givenUpTo("after_board_tests");
    const tr = await recordFAIPass(
      { buildId: w.buildId, unitSerial: "B1-SN-0001", executedAt: "2026-04-23T14:00:00Z" },
      "Quality Engineer",
    );
    expect(tr.testType).toBe("FAI");
    expect(tr.result).toBe("PASS");
    expect(await eventLogged("#/domainEvents/FirstArticleInspectionPassed")).toBe(true);
  });
});
