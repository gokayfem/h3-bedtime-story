import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SessionEvent } from "@axiom/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSession } from "../types";
import { LiveLessonShell } from "../LiveLessonShell";

const harness = vi.hoisted(() => {
  const videoRef = vi.fn((element: HTMLVideoElement | null) => {
    if (element) element.src = "https://v3.fal.media/files/orbit.mp4";
  });
  return {
    onEvent: null as ((event: SessionEvent) => void) | null,
    start: vi.fn(),
    redirect: vi.fn(),
    replace: vi.fn(),
    stop: vi.fn(),
    sendText: vi.fn(),
    director: {
      status: "idle" as "idle" | "connecting" | "holding" | "generating",
      promptVersion: null as number | null,
      preservedPromptVersion: null as number | null,
      failure: null,
      videoRef,
      canGenerate: vi.fn(() => true),
    },
  };
});


vi.mock("@/hooks/useTutorSession", () => ({
  useTutorSession: (options: {
    onEvent?: (event: SessionEvent) => void;
  }) => {
    harness.onEvent = options.onEvent ?? null;
    return {
      state: "text_only",
      mode: "text",
      events: [],
      error: null,
      micMuted: false,
      open: vi.fn(),
      retry: vi.fn(),
      interrupt: vi.fn(),
      resume: vi.fn(),
      setMicrophoneMuted: vi.fn(),
      sendText: harness.sendText,
      selectCard: vi.fn(),
      close: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/useVisualDirector", () => ({
  useVisualDirector: () => ({
    ...harness.director,
    start: harness.start,
    redirect: harness.redirect,
    replace: harness.replace,
    stop: harness.stop,
  }),
}));

vi.mock("../LessonShell", () => ({
  LessonView: ({
    session,
    videoRef,
  }: {
    session: LessonSession;
    videoRef?: (element: HTMLVideoElement | null) => void;
  }) => (
    <div>
      {videoRef && <video data-testid="generated-video" ref={videoRef} />}
      <span data-testid="visual-state">
        {session.visual ? `${session.visual.phase}:${session.visual.spec.concept}` : "none"}
      </span>
      <button type="button" onClick={() => session.sendText("First question")}>First</button>
      <button type="button" onClick={() => session.sendText("Second question")}>Second</button>
      <ol data-testid="transcript">
        {session.turns.map((turn) => <li key={turn.turnId}>{`${turn.role}:${turn.text}`}</li>)}
      </ol>
    </div>
  ),
}));

const spec = {
  concept: "Orbital motion",
  teachingIntent: "Show gravity bending motion",
  visualDescription: "A planet following a curved orbit",
  durationSeconds: 5 as const,
  continuityKey: "astronomy",
};

describe("LiveLessonShell", () => {
  beforeEach(() => {
    harness.onEvent = null;
    harness.start.mockReset().mockResolvedValue(undefined);
    harness.redirect.mockReset();
    harness.replace.mockReset().mockResolvedValue(undefined);
    harness.stop.mockReset().mockResolvedValue(undefined);
    harness.sendText.mockReset().mockResolvedValue(undefined);
    harness.director.status = "idle";
    harness.director.promptVersion = null;
    harness.director.preservedPromptVersion = null;
    harness.director.canGenerate.mockReset().mockReturnValue(true);
    harness.director.videoRef.mockClear();
  });

  it("renders two learner and tutor turns in chronological order", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    fireEvent.click(screen.getByRole("button", { name: "First" }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-1",
      text: "First answer",
      interrupted: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-2",
      text: "Second answer",
      interrupted: false,
    }));

    expect(Array.from(screen.getByTestId("transcript").children, (item) => item.textContent)).toEqual([
      "learner:First question",
      "tutor:First answer",
      "learner:Second question",
      "tutor:Second answer",
    ]);
  });

  it("prepends deduplicated transcript backfill without remounting", () => {
    const recent: SessionEvent = {
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "tutor-recent",
      text: "Recent answer",
      interrupted: false,
    };
    render(
      <LiveLessonShell
        sessionId="session-1"
        learnerId="learner-1"
        initialEvents={[recent]}
        backfillEvents={[
          {
            protocolVersion: 1,
            type: "transcript.final",
            turnId: "tutor-old",
            text: "Old answer",
            interrupted: false,
          },
          recent,
        ]}
      />,
    );

    expect(Array.from(screen.getByTestId("transcript").children, (item) => item.textContent)).toEqual([
      "tutor:Old answer",
      "tutor:Recent answer",
    ]);
  });

  it("forwards revisioned visuals to the director and ignores stale redirects", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "canvas.cards.replace",
      revision: 3,
      purpose: "branch",
      prompt: "Where next?",
      cards: [{ id: "card-1", title: "Faster", description: "Increase speed", spokenAliases: [] }],
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.redirect",
      revision: 2,
      visualOperationId: "visual-op-2",
      spec,
    }));

    expect(harness.start).toHaveBeenCalledWith(
      spec,
      1,
      "visual-op-1",
    );
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it("ignores implicit visual stops and stops only on the learner's explicit request", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    }));

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.stop",
      revision: 2,
      reason: "complete",
    }));

    expect(harness.stop).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-state").textContent).toBe("live:Orbital motion");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.stop",
      revision: 3,
      reason: "user_requested",
    }));

    expect(harness.stop).toHaveBeenCalledOnce();
    expect(screen.getByTestId("visual-state").textContent).toBe("held:Orbital motion");
  });

  it("keeps the current video mounted while its replacement connects", () => {
    harness.director.status = "generating";
    const view = render(
      <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
    );
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-1",
      spec,
    }));
    const playingVideo = screen.getByTestId("generated-video");

    harness.director.status = "connecting";
    view.rerender(
      <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
    );

    expect(screen.getByTestId("generated-video")).toBe(playingVideo);
    expect(harness.director.videoRef).not.toHaveBeenCalledWith(null);
  });


  it("ignores a generic greeting, then sends each usable story subject", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "session.status",
      state: "listening",
    }));
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-state").textContent).toBe("none");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "generic-greeting",
      text: "Yes, I can hear you loud and clear! What science topic would you like to explore today?",
      interrupted: false,
    }));
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("visual-state").textContent).toBe("none");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "spoken-response-1",
      text: "Water boils at 99.97 degrees Celsius.",
      interrupted: false,
    }));
    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        concept: "Water boils at 99.97 degrees Celsius",
        continuityKey: "niko-moss-moonlit-forest",
        teachingIntent: "Continue the current story subject with a causal action and a stable handoff.",
        visualDescription: "Water boils at 99.97 degrees Celsius",
        durationSeconds: 5,
      }),
      1,
      expect.any(String),
    );
    const firstVisualDescription = harness.start.mock.calls[0]?.[0].visualDescription;
    expect(firstVisualDescription).toBe(
      "Water boils at 99.97 degrees Celsius",
    );
    expect(firstVisualDescription).not.toContain("REAL WORLD");
    expect(firstVisualDescription).not.toContain("0.00");

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "spoken-response-2",
      text: "Ancient surveyors measured circular buildings with rope.",
      interrupted: false,
    }));
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        continuityKey: "niko-moss-moonlit-forest",
        visualDescription:
          "Ancient surveyors measured circular buildings with rope",
        durationSeconds: 10,
      }),
      3,
      expect.any(String),
    );
    const continuingVisualDescription = harness.replace.mock.calls[0]?.[0].visualDescription;
    expect(continuingVisualDescription).toBe(
      "Ancient surveyors measured circular buildings with rope",
    );
    expect(continuingVisualDescription).not.toContain("HOW IT WORKS");
    expect(continuingVisualDescription).not.toContain("motion spine");
  });

  it("uses five and ten seconds for the first two clips and ignores later narration sentences", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "streaming-turn",
      text: "Niko braces the lantern while Moss winds the silver vine. ",
    }));

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Niko braces the lantern while Moss winds the silver vine",
        durationSeconds: 5,
      }),
      1,
      expect.any(String),
    );

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "streaming-turn",
      text: "The blue leaves lift to reveal a moon-key. ",
    }));

    expect(harness.redirect).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "The blue leaves lift to reveal a moon-key",
        continuityKey: "niko-moss-moonlit-forest",
        durationSeconds: 10,
      }),
      2,
      expect.any(String),
    );

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "streaming-turn",
      text: "A silver moth circles above the key. ",
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.redirect).toHaveBeenCalledOnce();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "streaming-turn",
      text: "Niko braces the lantern while Moss winds the silver vine. The blue leaves lift to reveal a moon-key. A silver moth circles above the key.",
      interrupted: false,
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.redirect).toHaveBeenCalledOnce();
  });

  it("guarantees a hidden second continuation when a completed tutor turn has only one visual sentence", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "one-sentence-turn",
      text: "Niko opens the glowing root-door while Moss holds the moon-key.",
      interrupted: false,
    }));

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Niko opens the glowing root-door while Moss holds the moon-key",
        durationSeconds: 5,
      }),
      1,
      expect.any(String),
    );
    expect(harness.redirect).toHaveBeenCalledWith(
      expect.objectContaining({
        continuityKey: "niko-moss-moonlit-forest",
        visualDescription: expect.stringContaining("Continue directly from the exact ending"),
        durationSeconds: 10,
      }),
      2,
      expect.any(String),
    );
  });

  it("warms up with five seconds, then rolls ten-second continuations until new guidance", () => {
    vi.useFakeTimers();
    let rollingSlotAvailable = false;
    harness.director.canGenerate.mockImplementation(() => rollingSlotAvailable);
    const view = render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "opening-turn",
      text: "Niko raises the moon-lantern beside the sealed root-door. Moss turns the silver key until blue vines unwind.",
      interrupted: false,
    }));

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 5 }),
      1,
      expect.any(String),
    );
    expect(harness.redirect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ durationSeconds: 10 }),
      2,
      expect.any(String),
    );

    rollingSlotAvailable = true;
    act(() => vi.advanceTimersByTime(750));
    expect(harness.redirect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        visualDescription: expect.stringContaining("same guided goal"),
        durationSeconds: 10,
      }),
      3,
      expect.any(String),
    );

    rollingSlotAvailable = false;
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    rollingSlotAvailable = true;
    act(() => vi.advanceTimersByTime(750));
    expect(harness.redirect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ durationSeconds: 10 }),
      4,
      expect.any(String),
    );
    rollingSlotAvailable = false;

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "guided-turn",
      text: "Niko pushes the opened root-door while Moss protects the moon-lantern.",
      interrupted: false,
    }));
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 10 }),
      5,
      expect.any(String),
    );

    view.unmount();
    vi.useRealTimers();
  });

  it("keeps requesting ten-second continuations while speech is interrupted", () => {
    vi.useFakeTimers();
    const view = render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "opening-turn",
      text: "Niko raises the moon-lantern beside the sealed root-door. Moss turns the silver key until blue vines unwind.",
      interrupted: false,
    }));

    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 5 }),
      1,
      expect.any(String),
    );
    expect(harness.redirect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ durationSeconds: 10 }),
      2,
      expect.any(String),
    );

    act(() => vi.advanceTimersByTime(750));
    expect(harness.redirect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ durationSeconds: 10 }),
      3,
      expect.any(String),
    );

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "opening-turn",
      text: "Niko raises the moon-lantern beside the sealed root-door.",
      interrupted: true,
    }));

    act(() => vi.advanceTimersByTime(750));
    expect(harness.redirect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ durationSeconds: 10 }),
      4,
      expect.any(String),
    );

    view.unmount();
    vi.useRealTimers();
  });

  it("replaces old playback when the next tutor conversation produces a video", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "first-conversation",
      text: "Gravity bends a moving planet into a curved orbit. ",
    }));
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "second-conversation",
      text: "Magnetic field lines curve around a bar magnet. ",
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Magnetic field lines curve around a bar magnet",
        durationSeconds: 10,
      }),
      2,
      expect.any(String),
    );
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it("does not generate from partial speech or duplicate the first beat before queuing its fallback", () => {
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "continuous-turn",
      text: "Gravity bends a moving planet into ",
    }));
    expect(harness.start).not.toHaveBeenCalled();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "continuous-turn",
      text: "a curved orbit. ",
    }));
    expect(harness.start).toHaveBeenCalledOnce();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "continuous-turn",
      text: "Gravity bends a moving planet into a curved orbit.",
      interrupted: false,
    }));
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.redirect).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: expect.stringContaining("Continue directly from the exact ending"),
        durationSeconds: 10,
      }),
      2,
      expect.any(String),
    );
  });

  it("keeps the current video playing until the interrupted topic is replaced", () => {
    vi.useFakeTimers();
    harness.director.canGenerate.mockReturnValue(false);
    const view = render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "interrupted-turn",
      text: "Gravity bends a moving planet into a curved orbit. ",
    }));
    expect(harness.start).toHaveBeenCalledOnce();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.final",
      turnId: "interrupted-turn",
      text: "Gravity bends a moving planet into a curved orbit.",
      interrupted: true,
    }));
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.redirect).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 10 }),
      2,
      expect.any(String),
    );
    act(() => vi.advanceTimersByTime(1_500));
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.redirect).toHaveBeenCalledOnce();

    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "transcript.delta",
      turnId: "replacement-turn",
      text: "Magnetic field lines curve around a bar magnet. ",
    }));

    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        visualDescription: "Magnetic field lines curve around a bar magnet",
        durationSeconds: 10,
      }),
      3,
      expect.any(String),
    );
    expect(harness.redirect).toHaveBeenCalledOnce();
    view.unmount();
    vi.useRealTimers();
  });
  it("resolves an abandoned redirect back to the clip that remains on screen", () => {
    const piSpec = {
      ...spec,
      concept: "Pi was discovered by measuring circles",
      visualDescription: "Pi was discovered by measuring circles",
      durationSeconds: 15 as const,
    };
    const surveyorSpec = {
      ...spec,
      concept: "Ancient surveyors measured circular buildings with rope",
      visualDescription: "Ancient surveyors measured circular buildings with rope",
      durationSeconds: 15 as const,
    };
    const view = render(
      <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
    );
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.start",
      revision: 1,
      visualOperationId: "visual-op-pi",
      spec: piSpec,
    }));
    expect(screen.getByTestId("visual-state").textContent).toBe(
      "live:Pi was discovered by measuring circles",
    );
    act(() => harness.onEvent?.({
      protocolVersion: 1,
      type: "visual.redirect",
      revision: 2,
      visualOperationId: "visual-op-surveyors",
      spec: surveyorSpec,
    }));
    expect(screen.getByTestId("visual-state").textContent).toBe(
      "redirecting:Ancient surveyors measured circular buildings with rope",
    );

    act(() => {
      harness.director.status = "generating";
      harness.director.preservedPromptVersion = 2;
      view.rerender(
        <LiveLessonShell sessionId="session-1" learnerId="learner-1" />,
      );
    });

    expect(screen.getByTestId("visual-state").textContent).toBe(
      "live:Pi was discovered by measuring circles",
    );
  });
  it("mounts the generated video when one visual revision resolves into holding state", async () => {
    harness.start.mockImplementation(async () => {
      harness.director.status = "holding";
      harness.director.promptVersion = 1;
      return true;
    });
    render(<LiveLessonShell sessionId="session-1" learnerId="learner-1" />);

    await act(async () => {
      harness.onEvent?.({
        protocolVersion: 1,
        type: "visual.start",
        revision: 1,
        visualOperationId: "visual-op-1",
        spec,
      });
      await Promise.resolve();
    });

    const video = screen.getByTestId("generated-video") as HTMLVideoElement;
    expect(video.src).toBe("https://v3.fal.media/files/orbit.mp4");
    expect(harness.director.videoRef).toHaveBeenCalledWith(video);
    expect(harness.start).toHaveBeenCalledOnce();
  });
});
