import { describe, expect, it } from "vitest";
import { isContainerNotFound } from "./errors.js";

const httpErr = (message: string, status: number, body?: unknown) =>
  Object.assign(new Error(message), { status, body });

describe("isContainerNotFound", () => {
  it("matches a 404 whose message names the container", () => {
    expect(isContainerNotFound(httpErr("Container not found", 404))).toBe(true);
  });
  it("matches a 404 with a structured container code", () => {
    expect(isContainerNotFound(httpErr("Not Found", 404, { code: "CONTAINER_NOT_FOUND" }))).toBe(true);
  });
  it("rejects other 404s, non-404s and non-errors", () => {
    expect(isContainerNotFound(httpErr("Route not found", 404))).toBe(false);
    expect(isContainerNotFound(httpErr("Container not found", 500))).toBe(false);
    expect(isContainerNotFound({ status: 404, message: "container" })).toBe(false);
  });
});
