import type { VisualSpec } from "@axiom/protocol";
import { AgeAppropriateSafetyPolicy, type SafetyCategory, type SafetyPolicy } from "./safety-policy";
export const PERMANENT_VIDEO_STYLE = [
  "STORY BIBLE: premium hand-drawn 2D storybook cel animation in every frame.",
  "Recurring heroes: Niko, a small russet fox child with a cobalt scarf and cream muzzle; Moss, a round knee-high brass-and-moss robot with one warm amber eye. Preserve their exact size, colors, clothing, faces, and proportions.",
  "World: an enchanted moonlit forest of giant blue leaves, warm lantern fungi, cream paper grain, rough ink contours, restrained screen-print texture, halftone shadows, torn graphic shapes, and shallow layered parallax.",
  "Stable palette: deep cobalt, dry crimson, moss green, muted ochre, warm ivory, amber, and hard black.",
  "Use expressive character acting, clear silhouettes, decisive action poses, graphic smear drawings during fast moves, environmental reactions, and a brief readable stillness when the beat lands.",
  "Keep every frame illustrated: no photorealism, live action, glossy 3D, generic anime faces, modern app graphics, fake interfaces, or text-like marks.",
].join(" ");

export class UnsafeVisualPromptError extends Error {
  constructor(readonly category: SafetyCategory, readonly guidance: string) {
    super(`Visual request rejected by safety policy: ${category}`);
    this.name = "UnsafeVisualPromptError";
  }
}

export interface VisualPromptCompiler {
  compile(spec: VisualSpec, options?: { conditioned?: boolean }): string;
}

export class H3PromptCompiler implements VisualPromptCompiler {
  constructor(private readonly safetyPolicy: SafetyPolicy = new AgeAppropriateSafetyPolicy()) {}

  compile(spec: VisualSpec, options: { conditioned?: boolean } = {}): string {
    const decision = this.safetyPolicy.assess(spec);
    if (!decision.allowed) throw new UnsafeVisualPromptError(decision.category, decision.guidance);
    const concept = normalize(spec.concept);
    const intent = normalize(spec.teachingIntent);
    const description = normalize(spec.visualDescription);
    const continuityKey = normalize(spec.continuityKey);
    if (!concept || !intent || !description || !continuityKey) throw new Error("Visual prompt fields must not be blank");

    const opening = options.conditioned
      ? "For the target video, at 0.00 seconds into the target video, <Picture 1> is fully referenced. Continue directly from its exact character poses, positions, lighting, camera direction, and environment; do not reset the scene."
      : "Open immediately in the enchanted forest with Niko and Moss already engaged in the action; establish them in one clear wide composition.";
    return [
      PERMANENT_VIDEO_STYLE,
      opening,
      `STORY BEAT: ${concept}. NARRATIVE PURPOSE: ${intent}. ACTION: ${description}.`,
      `Create exactly ${spec.durationSeconds} seconds in 16:9. Stage one readable causal mini-sequence: setup, committed action, visible consequence, then a stable two-second ending pose that can begin the next beat. Give Niko and Moss distinct purposeful actions; let the environment react. Maintain screen direction and spatial geography. No cuts that jump time, no montage, no new characters, no captions, dialogue text, logos, or written marks.`,
      "SOUND: gentle forest ambience, character movement and tactile prop effects synchronized to action; whimsical instrumental underscore only, no spoken dialogue.",
    ].join(" ");
  }
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, " "); }
