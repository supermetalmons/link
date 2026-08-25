import { describe, expect, it } from "vitest";
import * as entrypoint from "../src/index.ts";
import { EventProgressWorkflow } from "../src/eventProgressWorkflow.ts";
import worker from "../src/workerHandler.ts";

describe("Worker entrypoint", () => {
  it("exports the Worker handler and event progress Workflow", () => {
    expect(entrypoint.default).toBe(worker);
    expect(entrypoint.EventProgressWorkflow).toBe(EventProgressWorkflow);
    expect(typeof entrypoint.default.fetch).toBe("function");
    expect(typeof entrypoint.default.queue).toBe("function");
    expect(typeof entrypoint.default.scheduled).toBe("function");
  });
});
