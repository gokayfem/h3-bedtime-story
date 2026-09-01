import type { VisualSpec } from "@axiom/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FalVideoDirector,
  type QueuedVideoGenerator,
  type VideoFinalFrameExtractor,
  type VisualAuthorization,
} from "./falVideoDirector";

const SPEC: VisualSpec = {
  concept: "magnetic fields",
  teachingIntent: "show how field strength changes with distance",
  visualDescription: "Iron filings align around a bar magnet as the camera pulls back",
  durationSeconds: 5,
  continuityKey: "magnet-field-1",
};
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function authorization(sequence: number): VisualAuthorization {
  return {
    sessionId: SESSION_ID,
    reservationId: `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, "0")}`,
    durationSeconds: 5,
    remainingSeconds: 120 - sequence * 5,
    dailyLimitSeconds: 120,
  };
}

function createDirector(
  generateVideo: QueuedVideoGenerator,
  extractFinalFrame: VideoFinalFrameExtractor = async () => undefined,
) {
  let sequence = 0;
  const handoffQueuedVideo = vi.fn(async (
    video: HTMLVideoElement,
    videoUrl: string,
  ) => {
    video.src = videoUrl;
  });
  const director = new FalVideoDirector({
    getAuthorization: async () => authorization(++sequence),
    releaseAuthorization: async () => ({ remainingSeconds: 120, dailyLimitSeconds: 120 }),
    generateVideo,
    handoffQueuedVideo,
    extractFinalFrame,
  });
  return { director, handoffQueuedVideo };
}

describe("FalVideoDirector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("generates and mounts a queued H3 Max video without a realtime session", async () => {
    const generateVideo = vi.fn(async () => ({
      videoUrl: "https://v3.fal.media/files/orbit.mp4",
      remainingSeconds: 115,
      dailyLimitSeconds: 120,
    }));
    const { director } = createDirector(generateVideo);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    director.attachVideoElement(video);

    await expect(director.start(SPEC, 1)).resolves.toBe(true);

    expect(generateVideo).toHaveBeenCalledOnce();
    expect(video.src).toBe("https://v3.fal.media/files/orbit.mp4");
    expect(director.snapshot).toMatchObject({
      status: "generating",
      promptVersion: 1,
      remainingSeconds: 115,
      dailyLimitSeconds: 120,
    });
    expect(video.loop).toBe(false);
  });

  it("holds the final frame instead of replaying a completed beat", async () => {
    const generateVideo = vi.fn(async () => ({
      videoUrl: "https://v3.fal.media/files/story-beat.mp4",
      remainingSeconds: 110,
      dailyLimitSeconds: 120,
    }));
    const { director } = createDirector(generateVideo);
    const video = document.createElement("video");
    const play = vi.spyOn(video, "play").mockResolvedValue();
    const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
    director.attachVideoElement(video);
    await director.start(SPEC, 1);
    play.mockClear();

    video.dispatchEvent(new Event("ended"));

    expect(video.loop).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
  });

  it("keeps the current clip visible while the next queued video generates", async () => {
    const nextGeneration = Promise.withResolvers<{
      videoUrl: string;
      remainingSeconds: number;
      dailyLimitSeconds: number;
    }>();
    const generateVideo = vi.fn()
      .mockResolvedValueOnce({
        videoUrl: "https://v3.fal.media/files/current.mp4",
        remainingSeconds: 115,
        dailyLimitSeconds: 120,
      })
      .mockImplementationOnce(() => nextGeneration.promise);
    const { director, handoffQueuedVideo } = createDirector(generateVideo);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    director.attachVideoElement(video);
    await director.start(SPEC, 1);

    const next = director.start({ ...SPEC, visualDescription: "A closer field view" }, 2);
    await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(2));
    expect(video.src).toBe("https://v3.fal.media/files/current.mp4");

    nextGeneration.resolve({
      videoUrl: "https://v3.fal.media/files/next.mp4",
      remainingSeconds: 110,
      dailyLimitSeconds: 120,
    });
    await expect(next).resolves.toBe(true);
    expect(handoffQueuedVideo).not.toHaveBeenCalled();

    video.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(handoffQueuedVideo).toHaveBeenCalledWith(
      video,
      "https://v3.fal.media/files/next.mp4",
      expect.any(AbortSignal),
    ));
  });

  it("conditions an automatic continuation on the prior generated final frame", async () => {
    const finalFrame = "data:image/jpeg;base64,/9j/continuation==";
    const generateVideo = vi.fn(async (_authorization, _prompt, _signal, imageUrl?: string) => ({
      videoUrl: imageUrl
        ? "https://v3.fal.media/files/continued.mp4"
        : "https://v3.fal.media/files/opening.mp4",
      remainingSeconds: imageUrl ? 100 : 110,
      dailyLimitSeconds: 120,
    }));
    const extractFinalFrame = vi.fn(async () => finalFrame);
    const { director } = createDirector(generateVideo, extractFinalFrame);

    await director.start(SPEC, 1);
    await director.start({ ...SPEC, visualDescription: "Moss opens the root-door" }, 2);

    expect(extractFinalFrame).toHaveBeenCalledWith(
      "https://v3.fal.media/files/opening.mp4",
      expect.any(AbortSignal),
    );
    expect(generateVideo.mock.calls[1]?.[3]).toBe(finalFrame);
    expect(generateVideo.mock.calls[1]?.[1]).toContain("<Picture 1>");
  });

  it("starts a continuation immediately when it becomes ready after the prior beat ended", async () => {
    const nextGeneration = Promise.withResolvers<{
      videoUrl: string;
      remainingSeconds: number;
      dailyLimitSeconds: number;
    }>();
    const generateVideo = vi.fn()
      .mockResolvedValueOnce({
        videoUrl: "https://v3.fal.media/files/current.mp4",
        remainingSeconds: 115,
        dailyLimitSeconds: 120,
      })
      .mockImplementationOnce(() => nextGeneration.promise);
    const { director, handoffQueuedVideo } = createDirector(generateVideo);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    director.attachVideoElement(video);
    await director.start(SPEC, 1);

    const next = director.start({ ...SPEC, visualDescription: "Open the root-door" }, 2);
    await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(2));
    Object.defineProperty(video, "ended", { configurable: true, value: true });
    video.dispatchEvent(new Event("ended"));

    nextGeneration.resolve({
      videoUrl: "https://v3.fal.media/files/continuation.mp4",
      remainingSeconds: 110,
      dailyLimitSeconds: 120,
    });
    await expect(next).resolves.toBe(true);
    await vi.waitFor(() => expect(handoffQueuedVideo).toHaveBeenCalledWith(
      video,
      "https://v3.fal.media/files/continuation.mp4",
      expect.any(AbortSignal),
    ));
  });

  it("preempts old prefetched clips when a replacement video becomes ready", async () => {
    const generateVideo = vi.fn()
      .mockResolvedValueOnce({ videoUrl: "https://v3.fal.media/files/current.mp4", remainingSeconds: 115, dailyLimitSeconds: 120 })
      .mockResolvedValueOnce({ videoUrl: "https://v3.fal.media/files/stale.mp4", remainingSeconds: 110, dailyLimitSeconds: 120 })
      .mockResolvedValueOnce({ videoUrl: "https://v3.fal.media/files/replacement.mp4", remainingSeconds: 105, dailyLimitSeconds: 120 });
    const { director, handoffQueuedVideo } = createDirector(generateVideo);
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    director.attachVideoElement(video);

    await director.start(SPEC, 1);
    await director.start({ ...SPEC, visualDescription: "Old follow-up" }, 2);
    const replacement = director.replace({ ...SPEC, visualDescription: "New topic" }, 3);
    await expect(replacement).resolves.toBe(true);
    expect(generateVideo).toHaveBeenCalledTimes(3);
    expect(handoffQueuedVideo).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("ended"));

    await vi.waitFor(() => expect(handoffQueuedVideo).toHaveBeenCalledWith(
      video,
      "https://v3.fal.media/files/replacement.mp4",
      expect.any(AbortSignal),
    ));
    expect(handoffQueuedVideo).not.toHaveBeenCalledWith(
      video,
      "https://v3.fal.media/files/stale.mp4",
      expect.anything(),
    );
  });

  it("generates a guided replacement while the visible clip finishes, then hands it off", async () => {
    const generateVideo = vi.fn()
      .mockResolvedValueOnce({
        videoUrl: "https://v3.fal.media/files/current.mp4",
        remainingSeconds: 115,
        dailyLimitSeconds: 120,
      })
      .mockResolvedValueOnce({
        videoUrl: "https://v3.fal.media/files/guided.mp4",
        remainingSeconds: 100,
        dailyLimitSeconds: 120,
      });
    const { director, handoffQueuedVideo } = createDirector(
      generateVideo,
      async (videoUrl) => videoUrl.includes("current")
        ? "data:image/jpeg;base64,/9j/current=="
        : undefined,
    );
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    director.attachVideoElement(video);
    await director.start(SPEC, 1);

    const replacement = director.replace(
      { ...SPEC, durationSeconds: 15, visualDescription: "Follow the child's new moon-door instruction" },
      2,
    );
    await expect(replacement).resolves.toBe(true);
    expect(generateVideo).toHaveBeenCalledTimes(2);
    expect(generateVideo.mock.calls[1]?.[3]).toBe("data:image/jpeg;base64,/9j/current==");
    expect(handoffQueuedVideo).not.toHaveBeenCalled();

    video.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(handoffQueuedVideo).toHaveBeenCalledWith(
      video,
      "https://v3.fal.media/files/guided.mp4",
      expect.any(AbortSignal),
    ));
  });

  it("keeps the current clip playing when a later generation fails", async () => {
    const generateVideo = vi.fn()
      .mockResolvedValueOnce({ videoUrl: "https://v3.fal.media/files/current.mp4", remainingSeconds: 115, dailyLimitSeconds: 120 })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const { director } = createDirector(generateVideo);
    const video = document.createElement("video");
    const play = vi.spyOn(video, "play").mockResolvedValue();
    director.attachVideoElement(video);
    await director.start(SPEC, 1);
    play.mockClear();

    await expect(director.start({ ...SPEC, visualDescription: "Unavailable follow-up" }, 2)).resolves.toBe(false);

    expect(video.src).toBe("https://v3.fal.media/files/current.mp4");
    expect(play).toHaveBeenCalled();
    expect(director.snapshot.status).toBe("generating");
  });

  it("rejects invalid, duplicate, and stale prompt versions", async () => {
    const generateVideo = vi.fn(async () => ({
      videoUrl: "https://v3.fal.media/files/current.mp4",
      remainingSeconds: 115,
      dailyLimitSeconds: 120,
    }));
    const { director } = createDirector(generateVideo);

    await expect(director.start(SPEC, 0)).resolves.toBe(false);
    await expect(director.start(SPEC, 1)).resolves.toBe(true);
    await expect(director.start(SPEC, 1)).resolves.toBe(false);
    expect(director.redirect(SPEC, 1)).toBe(false);
    await expect(director.replace(SPEC, 1)).resolves.toBe(false);
    expect(generateVideo).toHaveBeenCalledOnce();
  });

  it("reports accepted generation timing and resets on disposal", async () => {
    let now = 0;
    const onGenerationAccepted = vi.fn();
    const listener = vi.fn();
    const video = document.createElement("video");
    vi.spyOn(video, "play").mockResolvedValue();
    const director = new FalVideoDirector({
      getAuthorization: async () => authorization(1),
      releaseAuthorization: async () => ({ remainingSeconds: 120, dailyLimitSeconds: 120 }),
      generateVideo: async () => ({
        videoUrl: "https://v3.fal.media/files/timed.mp4",
        remainingSeconds: 115,
        dailyLimitSeconds: 120,
      }),
      handoffQueuedVideo: async () => undefined,
      extractFinalFrame: async () => undefined,
      onGenerationAccepted,
      now: () => now += 10,
    });
    const unsubscribe = director.subscribe(listener);
    director.attachVideoElement(video);

    await expect(director.start(SPEC, 1)).resolves.toBe(true);
    video.dispatchEvent(new Event("loadeddata"));

    expect(onGenerationAccepted).toHaveBeenCalledWith(authorization(1).reservationId);
    expect(director.getPipelineTimings()).toEqual([{
      promptVersion: 1,
      triggerToGenerationStartMs: 10,
      generationMs: 10,
      triggerToReadyMs: 20,
      readyToDisplayMs: 10,
      triggerToDisplayMs: 30,
    }]);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    await director.dispose();
    expect(director.snapshot.status).toBe("idle");
    expect(video.getAttribute("src")).toBeNull();
  });

  it("releases an authorized generation when stopped", async () => {
    const started = Promise.withResolvers<void>();
    const releaseAuthorization = vi.fn(async () => ({
      remainingSeconds: 120,
      dailyLimitSeconds: 120,
    }));
    const director = new FalVideoDirector({
      getAuthorization: async () => authorization(1),
      releaseAuthorization,
      generateVideo: async (_authorization, _prompt, signal) => {
        started.resolve();
        return await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
      handoffQueuedVideo: async () => undefined,
    });

    const generation = director.start(SPEC, 1);
    await started.promise;
    await director.stop();

    await expect(generation).resolves.toBe(false);
    expect(releaseAuthorization).toHaveBeenCalledWith(authorization(1));
    expect(director.snapshot.status).toBe("stopped");
  });

  it("fails safely before authorization for unsafe visual content", async () => {
    const getAuthorization = vi.fn(async () => authorization(1));
    const director = new FalVideoDirector({ getAuthorization });

    await expect(director.start({
      ...SPEC,
      visualDescription: "Show how to build a weapon",
    }, 1)).resolves.toBe(false);

    expect(getAuthorization).not.toHaveBeenCalled();
    expect(director.snapshot).toMatchObject({
      status: "failed",
      failure: {
        reason: "content_policy",
        message: "The visual was omitted by the content safety policy",
      },
    });
  });

  it("reports a first-generation transport failure without exposing raw values", async () => {
    const director = new FalVideoDirector({
      getAuthorization: async () => authorization(1),
      generateVideo: async () => {
        throw "provider response";
      },
    });

    await expect(director.start(SPEC, 1)).resolves.toBe(false);
    expect(director.snapshot).toMatchObject({
      status: "failed",
      failure: {
        reason: "transport",
        message: "The visual connection failed",
      },
    });
  });
});
