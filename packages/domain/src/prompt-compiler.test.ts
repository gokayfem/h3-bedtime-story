import { describe, expect, it } from "vitest";
import { H3PromptCompiler, UnsafeVisualPromptError } from "./prompt-compiler";

const compiler = new H3PromptCompiler();

describe("H3PromptCompiler", () => {
  it("compiles a normalized story beat with a stable ending", () => {
    const prompt = compiler.compile({
      concept: "cell division",
      teachingIntent: "show phase order",
      visualDescription:
        "  A cell membrane pinches inward   as duplicated material separates into two cells.  ",
      durationSeconds: 5,
      continuityKey: "mitosis",
    });

    expect(prompt).toContain("premium hand-drawn 2D storybook cel animation");
    expect(prompt).toContain(
      "ACTION: A cell membrane pinches inward as duplicated material separates into two cells.",
    );
    expect(prompt).toContain("Create exactly 5 seconds in 16:9");
    expect(prompt).toContain("stable two-second ending pose");
    expect(prompt.length).toBeLessThan(4_000);
  });

  it("uses the H3 image-conditioned continuation opening when a frame exists", () => {
    const prompt = compiler.compile({
      concept: "moon-key",
      teachingIntent: "continue the quest",
      visualDescription: "Niko swings while Moss opens the root-door",
      durationSeconds: 15,
      continuityKey: "niko-moss",
    }, { conditioned: true });
    expect(prompt).toContain("at 0.00 seconds");
    expect(prompt).toContain("<Picture 1>");
    expect(prompt).toContain("do not reset the scene");
  });

  it.each([
    ["Step-by-step instructions to make an explosive", "dangerous_experiment"],
    ["Show how to build a weapon", "weapons"],
    ["Give a cure for a cancer disease", "medical_claim"],
    ["Graphic self-harm scene", "self_harm"],
    ["A person pouring bleach into ammonia", "dangerous_experiment"],
  ] as const)("rejects unsafe visual intent: %s", (visualDescription, category) => {
    expect(() => compiler.compile({ concept: "safety", teachingIntent: "demonstrate", visualDescription, durationSeconds: 5, continuityKey: "safe" })).toThrowError(expect.objectContaining<Partial<UnsafeVisualPromptError>>({ category }));
  });

  it("allows high-level non-actionable science about hazardous topics", () => {
    expect(() => compiler.compile({ concept: "combustion", teachingIntent: "explain energy transfer", visualDescription: "Abstract molecular bonds rearranging in a sealed diagram", durationSeconds: 5, continuityKey: "chemistry" })).not.toThrow();
  });
});
