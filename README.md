# Storytime

Realtime, interruptible stories that children steer by speaking or typing, with continuously generated H3 Max animation.

The storyteller begins with a five-second opening, then runs a rolling chain of causal ten-second beats without stopping to ask what should happen next. Each clip plays once; if its continuation is not ready yet, it stops on its final frame until the handoff. When a child interrupts or adds guidance, stale unseen beats are discarded, the clip already on screen finishes, and its final frame becomes the start of the guided branch without restarting Niko, Moss, or the forest.

## Project demo

https://github.com/user-attachments/assets/48bba979-9c30-438c-871c-73c37431bff3

## Features

- Realtime voice storytelling with automatic barge-in and a typed fallback
- Automatic 5s → continuous 10s H3 Max story pipeline
- Automatic text-to-video opening and image-to-video continuation
- Stable Story Bible for Niko, Moss, and the moonlit forest
- Automatic causal continuation with free-form child steering at any moment
- Seamless decoded-video handoffs with no blank canvas
- Stale-queue cancellation and visible-frame replacement after an interruption
- Transcript, lesson cards, progress state, and reduced-motion support
- Per-learner and global video quotas
- Local in-memory development mode
- Optional PostgreSQL, Redis, and realtime-gateway deployment

## Stack

- Next.js 16, React 19, TypeScript
- fal Grok Voice Realtime and MiniMax H3 Max
- pnpm workspaces and Turborepo
- Vitest
- Optional Neon PostgreSQL, Upstash Redis, and a Node.js realtime gateway

## How story beats become H3 prompts

The application does not use a separate prompt-writing service. The story contract makes every narration sentence a compact continuation brief:

1. Grok Voice narrates exactly two chronological micro-beats in 40–64 words without asking a question or waiting for permission: one child-guided beat and one automatic continuation.
2. The first usable narration creates a five-second opening and the second creates a ten-second bridge. If the voice model ends after one usable sentence, the browser silently derives the bridge from the opening.
3. `H3PromptCompiler` applies child-safety checks and combines the action with the permanent Story Bible, causal motion rules, sound direction, and a stable ending-pose requirement.
4. The opening uses `minimax/h3-max/text-to-video`.
5. Every later clip is a ten-second automatic continuation. The preceding generated clip's final frame is sent to `minimax/h3-max/image-to-video` with prompt expansion disabled.
6. The director keeps at most two clips in flight, generates serially from ending frames, and continues until new child guidance arrives. A steer cancels only unseen work, lets the visible clip finish, and generates the next guided ten-second clip from that exact final frame.
7. The 480p endpoints run with `sync_mode: false`, so FAL returns a CDN URL that can begin loading without waiting for a base64 response.

Every generated prompt follows this structure:

```text
STORY BIBLE: stable Niko, Moss, moonlit forest, hand-drawn storybook cel
animation, paper grain, ink contours, and cobalt/moss/amber palette.

STORY BEAT: <what changes in this turn>
NARRATIVE PURPOSE: <why the beat matters>
ACTION: <distinct Niko action + distinct Moss action + environmental consequence>

Create exactly the requested duration: setup, committed action, visible consequence,
then a stable two-second ending pose that can begin the next beat.
```

The storyteller supplies the action chain; application code owns canon, safety, duration, final-frame continuity, queue invalidation, and generation constraints.

## Quick start

Requirements:

- Node.js 22
- pnpm 11.21.0 through Corepack
- A current Chrome or Edge browser
- A fal API key for realtime voice and generated video

```sh
git clone https://github.com/gokayfem/h3-bedtime-story.git
cd h3-bedtime-story
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

Add your fal key to `.env`; nothing else is required for the local demo:

```dotenv
FAL_KEY=your-fal-key
```

Start only the self-contained web demo:

```sh
pnpm dev
```

Open [http://localhost:3000/learn](http://localhost:3000/learn), allow microphone access, and tell Niko and Moss what to do. If voice is unavailable, the same story can be steered with the text box.

Local development uses in-memory sessions when database and Redis variables are absent. Data resets when the process exits.

## Full workspace

The repository also includes the optional realtime gateway and production persistence adapters:

```text
apps/web                 Next.js application and fal visual director
apps/realtime-gateway    Stateful realtime gateway
packages/domain          Lesson and visual domain logic
packages/protocol        Versioned session and tutor contracts
packages/persistence     In-memory, PostgreSQL, and Redis adapters
packages/science-eval    Tutor evaluation utilities
database/migrations      Forward-only PostgreSQL migrations
deploy                   Vercel and Fly.io deployment configuration
```

To run the complete local infrastructure, configure the database and Redis values in `.env`, start the compatibility services, migrate, then launch the workspace:

```sh
docker compose up -d --wait
.github/scripts/start-local-neon-proxy.sh
REDIS_REST_TLS_DIR=/tmp/h3-max-redis-rest-tls \
  UPSTASH_REDIS_REST_TOKEN=local-development-token \
  .github/scripts/start-redis-rest-tls.sh
export NODE_OPTIONS="--import=file://$PWD/.github/scripts/configure-local-neon.mjs"
export NODE_EXTRA_CA_CERTS=/tmp/h3-max-redis-rest-tls/cert.pem
pnpm exec dotenvx run -f .env -- pnpm --filter @axiom/persistence migrate
pnpm dev:full
```

## Environment

The local web demo requires only `FAL_KEY`. When that key is present:

- Grok Voice and queued H3 Max video generation are enabled automatically.
- The browser-safe feature flags are derived during the Next.js build; the fal key itself remains server-only.
- Typed fallback uses a deterministic local story guide when no OpenAI key is configured.
- Sessions, quotas, and lesson state use in-memory storage.

Optional kill switches remain available for debugging: set `FAL_GROK_VOICE_ENABLED=false`, `FAL_QUEUE_ENABLED=false`, or `LOCAL_TUTOR_ENABLED=false`. You do not need to add them otherwise.

A public production deployment intentionally needs durable security infrastructure in addition to `FAL_KEY`:

- `DATABASE_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `TRANSCRIPT_ENCRYPTION_KEY`

The optional standalone realtime gateway additionally requires provider, signing, origin, and Redis configuration. The self-contained local web demo does not use that infrastructure.
Set the optional standalone gateway's `METRICS_AUTH_TOKEN` to a random value of at least 32 characters when Prometheus scraping is required. `/metrics` returns `404` when the token is unset and requires `Authorization: Bearer <token>` when enabled.

Never add a `NEXT_PUBLIC_` prefix to a secret. Configure production values in the hosting provider rather than committing them.

## Commands

```sh
pnpm dev                # self-contained FAL-only web demo
pnpm dev:full           # web, gateway, and all workspace packages
pnpm lint               # ESLint
pnpm typecheck          # TypeScript
pnpm test               # unit and integration tests
pnpm test:coverage      # coverage thresholds
pnpm build              # production builds
pnpm check              # lint, types, tests, and build
```

## Deployment

- Web: Vercel using `deploy/vercel.json`
- Realtime gateway: Fly.io using `deploy/fly.toml`
- Persistence: Neon PostgreSQL and Upstash Redis

Configure deployment secrets in the hosting provider, not in repository files. Apply `database/migrations` before a production release.

## Safety and privacy

Storytime is a generative storytelling prototype for children. Voice audio is sent to configured realtime providers while the microphone is active, and generated visual prompts and continuity frames are sent to fal. Review and update the included privacy and terms pages before a public child-facing deployment.

## Repository policy

- `.env`, `.env.keys`, caches, build output, coverage, and local design artifacts are ignored.
- CI runs lint, type checks, tests, production builds, and credential scanning.
- Do not commit provider keys, database URLs, Redis tokens, generated certificates, or learner data.
