import { describe, it, expect } from "vitest";
import { bookProductionLine } from "../../src/compass/line-booking/commands.js";
import { givenUpTo, eventLogged } from "../helpers/world.js";

describe("Book Production Line", () => {
  it("Given a build is RELEASED, When the production planner books a line, Then a line_booking row with status BOOKED is created", async () => {
    const w = await givenUpTo("after_release_to_site");
    const booking = await bookProductionLine(
      {
        lineId: "line-A1",
        buildId: w.buildId,
        plannedStart: "2026-04-21T08:00:00Z",
        plannedEnd: "2026-04-25T17:00:00Z",
      },
      "Production Planner",
    );
    expect(booking.status).toBe("BOOKED");
    expect(booking.lineId).toBe("line-A1");
    expect(await eventLogged("#/domainEvents/ProductionLineBooked")).toBe(true);
  });

  it("rejects when build is not RELEASED", async () => {
    const w = await givenUpTo("after_lock");
    await expect(
      bookProductionLine(
        {
          lineId: "line-A1",
          buildId: w.buildId,
          plannedStart: "2026-04-21T08:00:00Z",
          plannedEnd: "2026-04-25T17:00:00Z",
        },
        "Production Planner",
      ),
    ).rejects.toThrow(/only RELEASED builds/);
  });
});
