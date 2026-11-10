import { beforeEach, describe, expect, it, vi } from "vitest";
import { seafloorAPI, type SeafloorAnswer } from "./seafloor";

vi.mock("./client", () => ({
  apiClient: { get: vi.fn() },
}));

const { apiClient } = await import("./client");
const get = vi.mocked(apiClient.get);

const FAILED: SeafloorAnswer = {
  status: "failed",
  source: null,
  grid: null,
  attempts: [
    {
      source: "gmrt",
      outcome: "failed",
      cell_size_meters: 60,
      cols: null,
      rows: null,
      resolution_meters: null,
      known_fraction: null,
      wet_fraction: null,
      error: "timed out",
    },
  ],
};

const rejection = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

beforeEach(() => {
  get.mockReset();
});

describe("seafloorAPI.lookUp", () => {
  it("passes the point and span as query parameters, with the caller's signal", async () => {
    const dry: SeafloorAnswer = {
      status: "dry",
      source: null,
      grid: null,
      attempts: [],
    };
    get.mockResolvedValue({ status: 200, data: dry });
    const signal = new AbortController().signal;

    await expect(seafloorAPI.lookUp(48.85, 2.35, 2000, signal)).resolves.toBe(
      dry,
    );
    expect(get).toHaveBeenCalledWith("/seafloor", {
      params: { lat: 48.85, lon: 2.35, span: 2000 },
      signal,
    });
  });

  // A failure is a 503, but its body is the whole answer: the attempts are what
  // tell the diver why there is nothing to draw, so they must not be thrown away.
  it("returns a 503's answer, attempts and all, rather than throwing", async () => {
    get.mockRejectedValue(
      rejection(503, {
        ...FAILED,
        detail: "No seafloor data could be fetched",
      }),
    );

    const answer = await seafloorAPI.lookUp(0, 0, 1000);

    expect(answer.status).toBe("failed");
    expect(answer.attempts).toEqual(FAILED.attempts);
  });

  it("throws a 503 that carries no answer, and every other refusal", async () => {
    get.mockRejectedValueOnce(
      rejection(503, { detail: "Service Unavailable" }),
    );
    await expect(seafloorAPI.lookUp(0, 0, 2000)).rejects.toThrow("503");

    get.mockRejectedValueOnce(rejection(429, { detail: "Too many requests" }));
    await expect(seafloorAPI.lookUp(0, 0, 2000)).rejects.toThrow("429");
  });
});
