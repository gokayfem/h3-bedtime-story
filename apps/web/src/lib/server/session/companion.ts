import "server-only";
import { createHash } from "node:crypto";

import type { LearnerProfile, LearningEvidence } from "@axiom/domain";
import {
  buildLearnerMemoryMessage,
  buildTutorInstructions,
  TUTOR_TOOL_DEFINITIONS,
  cardSchema,
  tutorToolCallSchema,
  type Card,
  type CardPurpose,
  type TutorToolCall,
} from "@axiom/protocol";
import { z } from "zod";

export type ScienceDiscipline =
  | "physics"
  | "chemistry"
  | "biology"
  | "astronomy"
  | "earth-science"
  | "environmental-science"
  | "general-science";

export type SafetyCategory = "dangerous-experiment" | "explicit-content" | "medical" | "weapons" | "self-harm";

export interface CompanionTurn {
  discipline: ScienceDiscipline;
  reply: string;
  safetyCategory?: SafetyCategory;
  cards: { purpose: CardPurpose; prompt: string; cards: Card[] };
  toolCalls: TutorToolCall[];
  evidence?: LearningEvidence;
}

export interface CompanionTurnContext {
  readonly turnNumber: number;
  readonly cardIdNamespace: string;
  readonly ageBand?: string;
  readonly learnerProfile?: LearnerProfile;
  readonly idempotencyKey?: string;
}

export interface CompanionTutorRequest {
  readonly question: string;
  readonly instructions: string;
  readonly learnerContext: string;
  readonly turnNumber: number;
  readonly idempotencyKey?: string;
}

export interface CompanionTutorProvider {
  generate(request: CompanionTutorRequest, signal?: AbortSignal): Promise<unknown>;
}
export type CompanionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class CompanionProviderUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("The science tutor is temporarily unavailable. Please try again.", options);
    this.name = "CompanionProviderUnavailableError";
  }
}

const disciplineSchema = z.enum([
  "physics",
  "chemistry",
  "biology",
  "astronomy",
  "earth-science",
  "environmental-science",
  "general-science",
]);

const companionDraftSchema = z.strictObject({
  discipline: disciplineSchema,
  reply: z.string().trim().min(1).max(4_000),
  toolCalls: z.array(tutorToolCallSchema).min(1).max(4),
}).superRefine((draft, context) => {
  const counts: Record<TutorToolCall["name"], number> = {
    show_visual: 0,
    present_cards: 0,
    record_learning_evidence: 0,
    stop_visual: 0,
  };
  for (const call of draft.toolCalls) counts[call.name] += 1;
  if (counts.present_cards !== 1) {
    context.addIssue({ code: "custom", message: "Exactly one present_cards intent is required", path: ["toolCalls"] });
  }
  if (counts.record_learning_evidence > 1) {
    context.addIssue({ code: "custom", message: "Only one record_learning_evidence intent is allowed", path: ["toolCalls"] });
  }
  const visualActions = counts.show_visual + counts.stop_visual;
  if (visualActions > 1) {
    context.addIssue({ code: "custom", message: "Only one visual action is allowed", path: ["toolCalls"] });
  }
});

const openAiResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.object({
    content: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

const SAFETY_PATTERNS: ReadonlyArray<readonly [SafetyCategory, RegExp]> = [
  ["self-harm", /\b(kill myself|suicide|end my life|take my life|end it all|hurt myself|self[- ]?harm|want to die|(?:do not|don['’]t) want to (?:live|be alive))\b/i],
  ["weapons", /(?:\b(build|make|design|improvise|assemble|recipe|guide)\b.{0,80}\b(bomb|weapon|gun|explosive|detonator|poison)\b|\b(how to|instructions|steps)\b.{0,80}\b(bomb|weapon|gun|explosive|detonator|poison)\b|\bpoison (someone|a person)\b)/i],
  ["dangerous-experiment", /\b(mix|combine|heat|make|synthesize|pour(?:ing)?|add(?:ing)?)\b.{0,80}\b(bleach|ammonia|chlorine gas|explosive|thermite|acid|toxic gas)\b/i],
  ["medical", /\b(diagnose|dose|dosage|prescribe|overdose|chest pain|can['’]t breathe|cannot breathe|medication)\b/i],
  ["explicit-content", /\b(show|generate|write|describe|send|make)\b.{0,50}\b(porn|explicit sex|sexual act|nudes?|genital content)\b/i],
];

const SAFETY_CONTENT: Record<SafetyCategory, {
  readonly reply: string;
  readonly prompt: string;
  readonly choices: readonly [string, string, string];
}> = {
  "self-harm": {
    reply: "I'm really glad you said something. I can't help with ways to hurt yourself. Please move near a trusted adult now and tell them plainly that you may not be safe. If there is immediate danger, call your local emergency number or crisis service now; in the U.S. or Canada, call or text 988. Stay with another person and move away from anything you could use to hurt yourself.",
    prompt: "Choose one safe next step now.",
    choices: ["Tell a trusted adult", "Call emergency support", "Move near other people"],
  },
  weapons: {
    reply: "I can't provide instructions for making a weapon or explosive. Those details could seriously injure you or other people. We can safely study the underlying science, such as energy transfer, pressure, or protective engineering, without construction steps or dangerous materials. If a real device or suspicious material is present, do not touch it; move away and tell a trusted adult or emergency service.",
    prompt: "Choose a safe science direction.",
    choices: ["Study energy safely", "Explore protective design", "Learn laboratory risk assessment"],
  },
  "dangerous-experiment": {
    reply: "That combination can release toxic gas, cause burns, or create dangerous pressure, so I won't give a procedure. Do not mix household chemicals or investigate by smell. Leave the area, get fresh air without re-entering, and tell a trusted adult; if exposure may have occurred, contact local poison control or emergency services. We can instead use a particle model to explain why incompatible chemicals are hazardous.",
    prompt: "Continue with a safe alternative.",
    choices: ["Use a particle model", "Learn hazard symbols", "Design a safe observation"],
  },
  "explicit-content": {
    reply: "I can't create or provide explicit sexual content. I can answer age-appropriate questions about human biology, reproduction, consent, development, or health using clear scientific language without graphic detail. For a personal health concern, talk with a trusted adult or qualified health professional.",
    prompt: "Choose an age-appropriate direction.",
    choices: ["Learn reproductive biology", "Discuss consent and health", "Ask a general biology question"],
  },
  medical: {
    reply: "I can explain general biology, but I can't diagnose symptoms or choose a medicine or dose. Symptoms can have many causes and need a qualified health professional who knows the person and context. Tell a trusted adult and contact a clinician or pharmacist; for severe chest pain, trouble breathing, loss of consciousness, or immediate danger, call local emergency services now.",
    prompt: "Choose a safe source of help.",
    choices: ["Tell a trusted adult", "Contact a clinician", "Learn general biology"],
  },
};

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["discipline", "reply", "toolCalls"],
  properties: {
    discipline: { type: "string", enum: disciplineSchema.options },
    reply: { type: "string", minLength: 1, maxLength: 4_000 },
    toolCalls: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        anyOf: TUTOR_TOOL_DEFINITIONS.map((tool) => ({
          type: "object",
          additionalProperties: false,
          required: ["name", "arguments"],
          properties: {
            name: { type: "string", enum: [tool.name] },
            arguments: tool.parameters,
          },
        })),
      },
    },
  },
} as const;

export class LocalCompanionTutor implements CompanionTutorProvider {
  async generate(request: CompanionTutorRequest): Promise<unknown> {
    const normalizedQuestion = request.question.toLowerCase();
    const rescue = /rescue|help|save|catch|star/u.test(normalizedQuestion);
    const puzzle = /puzzle|door|key|riddle|open/u.test(normalizedQuestion);
    const beat = rescue ? {
      reply: "Niko springs from a glowing root and bumps the falling star-seed toward Moss, who unfolds a leaf catcher as nearby lantern fungi flare gold. Moss cradles the humming seed while Niko plants it beside a trembling stone bud, and glowing roots curl into a tiny doorway beneath them.",
      choices: ["Plant the star-seed", "Follow the silver moths"],
    } : puzzle ? {
      reply: "Niko swings across the moon-vine and presses a sun-shaped stone while Moss spins his wheel inside the matching socket, opening the root-door in bright ripples. Beyond the doorway, Niko dives beneath a falling star-seed while Moss stretches a broad leaf between them, catching it as the hidden chamber glows awake.",
      choices: ["Leap for the star-seed", "Ask the lantern owls"],
    } : {
      reply: "Niko braces a tipping lantern mushroom while Moss winds its loose silver vine around his brass wheel, lifting blue leaves that reveal a tiny moon-key. The key skitters toward a mirror puddle, so Niko pins it beneath one paw while Moss projects an amber path toward the sleeping root-door.",
      choices: ["Swing on the moon-vine", "Build a leaf boat"],
    };
    const presentCards = {
      name: "present_cards",
      arguments: {
        purpose: "branch",
        prompt: "Where should we take this next?",
        cards: beat.choices.map((title, order) => ({
          title,
          description: `Continue by choosing ${title.toLocaleLowerCase()}.`,
          spokenAliases: [String(order + 1), title],
          order,
        })),
      },
    };
    const toolCalls: unknown[] = [presentCards];
    return { discipline: "general-science", reply: beat.reply, toolCalls };
  }
}

export class OpenAiCompanionTutor implements CompanionTutorProvider {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly fetchImpl: CompanionFetch = fetch,
  ) {}

  async generate(request: CompanionTutorRequest, signal?: AbortSignal): Promise<unknown> {
    if (!this.apiKey) throw new CompanionProviderUnavailableError();

    let response: Response;
    try {
      response = await this.fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          instructions: request.instructions,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: [
                    `Learner question: ${request.question}`,
                    `Turn number: ${request.turnNumber}`,
                    buildLearnerMemoryMessage(request.learnerContext) ?? "",
                    "Return exactly two short, sequential story sentences plus exactly one silent present_cards accessibility checkpoint. The first sentence is the child-guided clip and the second is its automatic continuation. Never ask a spoken question or offer spoken choices. Do not call show_visual because the transcript pipeline animates every completed sentence automatically. Call stop_visual with reason user_requested only when the learner explicitly asks to stop or end the visual story; never call it for interruption, topic change, or clip completion. Add record_learning_evidence only after meaningful observed learner reasoning or a demonstrated preference; never treat a question or self-report alone as mastery evidence. Never claim an intent has completed.",
                  ].filter(Boolean).join("\n"),
                },
              ],
            },
          ],
          max_output_tokens: 1_200,
          text: {
            format: {
              type: "json_schema",
              name: "typed_science_tutor_turn",
              strict: false,
              schema: RESPONSE_SCHEMA,
            },
          },
        }),
        signal,
      });
    } catch (error) {
      throw new CompanionProviderUnavailableError({ cause: error });
    }

    if (!response.ok) throw new CompanionProviderUnavailableError();
    const rawBody = await response.text();
    if (rawBody.length > 1_048_576) throw new CompanionProviderUnavailableError();

    try {
      const envelope = openAiResponseSchema.parse(JSON.parse(rawBody));
      const outputText = envelope.output_text
        ?? envelope.output?.flatMap((item) => item.content ?? []).map((content) => content.text).filter(Boolean).join("");
      if (!outputText) throw new Error("Provider returned no structured output");
      return JSON.parse(outputText);
    } catch (error) {
      throw new CompanionProviderUnavailableError({ cause: error });
    }
  }
}

export async function createCompanionTurn(
  text: string,
  context: CompanionTurnContext,
  provider: CompanionTutorProvider = createOpenAiProviderFromEnv(),
  signal?: AbortSignal,
): Promise<CompanionTurn> {
  const question = normalize(text);
  if (!question) throw new Error("A learner question is required");
  const cardIdNamespace = normalize(context.cardIdNamespace);
  if (!cardIdNamespace) throw new Error("A card id namespace is required");

  for (const [category, pattern] of SAFETY_PATTERNS) {
    if (pattern.test(question)) return safetyRedirect(category, cardIdNamespace);
  }

  const learnerContext = compileLearnerContext(context);
  let candidate: unknown;
  try {
    candidate = await provider.generate({
      question,
      instructions: buildTutorInstructions(learnerContext),
      learnerContext,
      turnNumber: context.turnNumber,
      ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
    }, signal);
  } catch (error) {
    if (error instanceof CompanionProviderUnavailableError) throw error;
    throw new CompanionProviderUnavailableError({ cause: error });
  }

  const parsed = companionDraftSchema.safeParse(candidate);
  if (!parsed.success) throw new CompanionProviderUnavailableError({ cause: parsed.error });
  const cardCall = parsed.data.toolCalls.find((call) => call.name === "present_cards");
  const evidenceCall = parsed.data.toolCalls.find((call) => call.name === "record_learning_evidence");
  if (!cardCall) throw new CompanionProviderUnavailableError();

  const toolCalls = parsed.data.toolCalls;
  const cards = {
    purpose: cardCall.arguments.purpose,
    prompt: cardCall.arguments.prompt,
    cards: materializeCards(cardCall.arguments, cardIdNamespace),
  };
  return {
    discipline: parsed.data.discipline,
    reply: parsed.data.reply,
    cards,
    toolCalls,
    ...(evidenceCall ? { evidence: evidenceCall.arguments } : {}),
  };
}

function createOpenAiProviderFromEnv(): CompanionTutorProvider {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey && process.env.LOCAL_TUTOR_ENABLED?.trim().toLowerCase() !== "false") {
    return new LocalCompanionTutor();
  }
  return new OpenAiCompanionTutor(
    apiKey,
    process.env.OPENAI_TEXT_MODEL ?? "gpt-4.1-mini",
  );
}

function compileLearnerContext(context: CompanionTurnContext): string {
  const profile = context.learnerProfile;
  const parts = [
    context.ageBand ? `Age band: ${normalize(context.ageBand)}.` : "",
    profile?.preferences.explanationMode ? `Preferred explanation mode: ${profile.preferences.explanationMode}.` : "",
    profile?.preferences.pace ? `Preferred pace: ${profile.preferences.pace}.` : "",
    profile?.preferences.challenge ? `Preferred challenge: ${profile.preferences.challenge}.` : "",
    profile?.preferences.interests.length ? `Interests: ${profile.preferences.interests.slice(0, 8).map(normalize).join(", ")}.` : "",
    profile?.mastery.length ? `Prior mastery: ${profile.mastery.slice(-8).map((item) => `${normalize(item.concept)} (${item.confidence.toFixed(2)})`).join(", ")}.` : "",
    profile?.misconceptions.length ? `Misconceptions to address without shaming: ${profile.misconceptions.slice(-5).map((item) => `${normalize(item.concept)} — ${normalize(item.description)}`).join("; ")}.` : "",
    profile?.recentSummaries.length ? `Recent learning summaries: ${profile.recentSummaries.slice(-3).map((item) => normalize(item.summary).slice(0, 500)).join(" | ")}.` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function safetyRedirect(category: SafetyCategory, cardIdNamespace: string): CompanionTurn {
  const safe = SAFETY_CONTENT[category];
  const cardInputs = safe.choices.map((title, order) => ({
    title,
    description: `Choose ${title.toLocaleLowerCase()}.`,
    spokenAliases: [String(order + 1), title],
    order,
  }));
  const toolCardSet = { purpose: "branch" as const, prompt: safe.prompt, cards: cardInputs };
  const cards = materializeCards(toolCardSet, cardIdNamespace);
  const cardSet = { purpose: toolCardSet.purpose, prompt: toolCardSet.prompt, cards };
  const toolCalls = tutorToolCallSchema.array().parse([
    { name: "present_cards", arguments: toolCardSet },
  ]);
  return {
    discipline: "general-science",
    safetyCategory: category,
    reply: safe.reply,
    cards: cardSet,
    toolCalls,
  };
}

type PresentCardsArguments = Extract<TutorToolCall, { name: "present_cards" }>["arguments"];

function materializeCards(arguments_: PresentCardsArguments, seed: string): Card[] {
  return arguments_.cards.map((card, index) => {
    const digest = createHash("sha256")
      .update(seed)
      .update("\u0000")
      .update(String(index))
      .update("\u0000")
      .digest("hex")
      .slice(0, 20);
    return cardSchema.parse({ ...card, id: `card-${digest}` });
  });
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
