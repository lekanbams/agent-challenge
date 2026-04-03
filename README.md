# Alexi — Personal Project Coach

An AI-powered personal project coach built on [ElizaOS](https://elizaos.com) and deployed on [Nosana](https://nosana.com)'s decentralized GPU network. Built for the Nosana x ElizaOS Agent Challenge.

## Why Alexi Exists

I'm on a journey to level up my expertise in AI and automation. Every week there's a new project to build, a new framework to learn, a new challenge to enter. The problem isn't ideas; it's execution. I'd start a project, get lost halfway through, skip the fundamentals, or lose track of what I was supposed to do next.

What I needed was a structured plan that balances learning with building. Not just a task list, but something that finds the right tutorials first, sequences them before the hands-on work, blocks out realistic time slots, and keeps me accountable throughout the week. A coach that understands technical projects and treats learning as part of the build process, not separate from it.

That's Alexi. It was originally a Python Telegram bot (v1), but the Nosana x ElizaOS challenge gave me the opportunity to rebuild it as a proper AI agent with web search, multi-platform support, and decentralized infrastructure. The result is a tool I actually use every week to plan and ship my projects.

## What Alexi Does

Alexi helps you plan, schedule, and execute weekly technical projects. Instead of vague to-do lists, Alexi:

1. **Researches your project** — searches the web for real tutorials, documentation, and YouTube guides
2. **Creates a structured weekly plan** — breaks the project into daily time-blocked tasks (12PM-7PM WAT) with learning resources inline
3. **Syncs to Notion** — approved tasks auto-populate your Notion database with dates, times, status, and resource links
4. **Works across platforms** — plan on the web UI, get reminders on Telegram, update progress from either

### Example Flow

```
You:   "I want to build a Python web scraper that tracks AI trends"
Alexi: [asks clarifying questions about scope, data sources, tech stack]
You:   [answers]
Alexi: [searches Tavily for real resources, creates 5-day plan with inline links]
       "Review the plan. Say 'approve' to save to Notion."
You:   "approve"
Alexi: "13 tasks synced to Notion Calendar."
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Nosana Decentralized GPU            │
│  ┌───────────────────────────────────────────┐   │
│  │  Qwen/Qwen3.5-4B (LLM Inference)    │   │
│  └──────────────────┬────────────────────────┘   │
│                     │                            │
│  ┌──────────────────▼────────────────────────┐   │
│  │          ElizaOS Agent (Alexi)            │   │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐  │   │
│  │  │ Web UI  │ │ Telegram │ │  Notion   │  │   │
│  │  │ :3000   │ │   Bot    │ │   Sync    │  │   │
│  │  └─────────┘ └──────────┘ └───────────┘  │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │     Custom Alexi Plugin             │  │   │
│  │  │  PLAN_PROJECT | SCHEDULE_TASKS      │  │   │
│  │  │  TODAYS_TASKS | MARK_DONE           │  │   │
│  │  │  DAILY_REPORT | WEEKLY_SUMMARY      │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
         │                    │
    ┌────▼────┐         ┌────▼────┐
    │ Tavily  │         │ Notion  │
    │  Search │         │   API   │
    └─────────┘         └─────────┘
```

## Tech Stack

- **Framework:** ElizaOS v1.7.2 (TypeScript)
- **LLM:** Qwen/Qwen3.5-4B via Nosana inference endpoint
- **Search:** Tavily API for real-time resource discovery
- **Chat:** ElizaOS built-in web UI + Telegram bot
- **Storage:** Notion API for task/calendar management, SQLite for local state
- **Deployment:** Docker on Nosana decentralized GPU network

## Custom Plugin

The Alexi plugin (`src/index.ts`) adds 6 actions and 1 provider to ElizaOS:

| Component | Purpose |
|-----------|---------|
| `PLAN_PROJECT` | Searches web, generates structured weekly plan with inline resources |
| `SCHEDULE_TASKS` | Parses plan, syncs tasks to Notion with dates/times/status |
| `TODAYS_TASKS` | Shows current day's time-blocked tasks |
| `MARK_DONE` | Marks tasks complete, shows remaining |
| `DAILY_REPORT` | End-of-day summary with carry-overs |
| `WEEKLY_SUMMARY` | Saturday stats, progress bars, project breakdown |
| `schedule-provider` | Injects current tasks/progress into every LLM response |

## Setup

### Prerequisites
- Node.js 23+
- pnpm
- Docker (for deployment)

### Local Development

```bash
git clone https://github.com/lekanbams/agent-challenge.git
cd agent-challenge
cp .env.example .env
# Edit .env with your API keys (Tavily, Telegram, Notion)
pnpm install
node node_modules/typescript/lib/tsc.js
cp dist/index.js node_modules/nosana-eliza-agent/index.js
bash node_modules/.bin/elizaos dev --character ./characters/agent.character.json
```

Open http://localhost:3000

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Set to `nosana` for Nosana endpoint |
| `OPENAI_BASE_URL` | Nosana Qwen3.5 inference URL |
| `OPENAI_SMALL_MODEL` | `Qwen/Qwen3.5-4B` |
| `OPENAI_LARGE_MODEL` | `Qwen/Qwen3.5-4B` |
| `TAVILY_API_KEY` | Web search for resource discovery |
| `TELEGRAM_BOT_TOKEN` | Telegram bot integration |
| `NOTION_API_KEY` | Notion integration for task sync |
| `NOTION_DATABASE_ID` | Target Notion database |

### Docker Build & Deploy

```bash
docker build -t yourusername/alexi-agent:latest .
docker push yourusername/alexi-agent:latest
```

### Nosana Deployment

```bash
npm install -g @nosana/cli
nosana job post \
  --file ./nos_job_def/nosana_eliza_job_definition.json \
  --market nvidia-4090 \
  --timeout 300
```

## Nosana Integration

Alexi uses Nosana at multiple levels:

- **LLM Inference:** All AI reasoning runs through Nosana's hosted Qwen3.5 endpoint
- **Container Deployment:** The agent runs as a Docker container on Nosana's decentralized GPU network
- **Decentralized Architecture:** No centralized cloud dependency — compute is distributed across Nosana nodes

## Project Structure

```
characters/          Agent personality and configuration
src/index.ts         Custom Alexi plugin (actions, providers)
patches/apply.js     Post-install patches for Qwen3.5 compatibility
nos_job_def/         Nosana deployment job definition
Dockerfile           Container build configuration
.env.example         Environment variable template
```

## License

MIT
