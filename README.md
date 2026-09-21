<div align="center">

# AgentHub

### One person. One Agent team.

**AgentHub is an API-driven multi-Agent orchestration and management platform for building a personal AI team around the tools you already use.**

[中文](./README.zh-CN.md) · **English**

> Development / testing version — core capabilities are working, but the project is still under active development and is not yet a complete end-user release.

</div>

---

## What is AgentHub?

AgentHub is designed to turn multiple AI Agents into a coordinated team instead of a collection of isolated tools.

It provides a unified control layer for Agent roles, tasks, scheduling, execution, review, and Provider integration. Each Agent can have its own role and responsibility, allowing a single user to organize a practical "AI team" around real development work.

AgentHub is built around an API-first architecture. Desktop clients, future Web clients, mobile apps, and remote nodes can all communicate with the same authoritative Backend instead of duplicating orchestration logic in every client.

The long-term goal is simple:

> **Give one person a manageable, reviewable, extensible team of AI Agents.**

---

## Why AgentHub?

Modern AI coding tools are powerful, but they are usually isolated from each other. AgentHub focuses on the coordination layer between them.

### Core ideas

- **Unified multi-Agent management** — manage multiple Agents, roles, responsibilities, and runtime states from one control plane.
- **Automatic task decomposition and scheduling** — plans can be materialized into tasks and dispatched through the Backend lifecycle.
- **Review / approval loop** — execution is not treated as automatically correct; review and human approval remain part of the workflow.
- **Provider abstraction** — different Agent tools can be integrated behind a common Provider layer.
- **Role-based Agent team** — Agents can be organized by position and responsibility instead of being anonymous parallel workers.
- **Multi-computer oriented architecture** — the API-first design makes remote clients and multi-node workflows possible without moving orchestration authority into the UI.
- **High extensibility through APIs** — new clients, automations, integrations, and future device transports can reuse the same Backend contracts.

---

## Current Provider integrations

The current AgentHub Backend contains Provider integrations for:

- **Claude**
- **OpenAI Codex**
- **Cursor**
- **Antigravity**

More Providers may be added later as the abstraction layer evolves.

---

## Architecture

AgentHub follows a simple authority model:

```text
Human decides.
Backend owns truth.
Desktop presents and mediates.
Providers execute.
Agents do work.
Review validates.
Office visualizes.
```

High-level architecture:

```text
                         ┌─────────────────────┐
                         │        Human        │
                         │     Human Boss      │
                         └──────────┬──────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │     AgentHub Desktop      │
                    │ UI / Drafts / User Intent │
                    └─────────────┬─────────────┘
                                  │
                      HTTP API + WebSocket
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │     AgentHub Backend      │
                    │   Authoritative State     │
                    ├───────────────────────────┤
                    │ Plans / Tasks / Agents    │
                    │ Scheduler / Dispatcher    │
                    │ Review / Recovery         │
                    │ Provider Abstraction      │
                    └─────────────┬─────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
          ┌──────────┐      ┌──────────┐      ┌──────────┐
          │  Claude  │      │  Codex   │      │  Cursor  │
          └──────────┘      └──────────┘      └──────────┘
                                  │
                                  ▼
                           ┌─────────────┐
                           │ Antigravity │
                           └─────────────┘
```

The Desktop does **not** become a second Backend. Authoritative lifecycle state belongs to the Backend. Clients submit intent, then resynchronize from Backend state.

Realtime events are used as invalidation / resync signals rather than as a second source of truth.

---

## Desktop

AgentHub Desktop is the visual and interaction layer of the project.

It provides the human-facing workspace for viewing Agents, lifecycle state, tasks, reviews, Provider information, and the office-style visualization.

The Desktop project is maintained separately:

**Repository:** `704986409/AgentHub-Desktop`

AgentHub Desktop is based on the Munder Difflin desktop project. Provenance and baseline audit information are maintained in the Desktop repository.

---

## Project status

AgentHub currently has a working testing/development version, but the feature set is not complete.

The Backend has progressed far beyond the original data-foundation prototype and now includes lifecycle execution, scheduling, assignment management, Provider integration, review flows, recovery logic, authoritative state APIs, and realtime invalidation.

The project should still be treated as **under active development**:

- APIs and UI may still change.
- Security hardening for general public-network exposure is not complete.
- There is not yet a finished consumer release / installer flow.
- Source builds are currently the recommended way to experiment with the project.

> **Do not expose the current development Backend directly to the public Internet without an appropriate security layer.**

---

## Screenshots

<!-- Replace these placeholders with real screenshots later. -->

> **Desktop overview placeholder**  
> Suggested path: `docs/images/agenthub-desktop-overview.png`

> **Lifecycle / task management placeholder**  
> Suggested path: `docs/images/agenthub-lifecycle.png`

> **Agent office visualization placeholder**  
> Suggested path: `docs/images/agenthub-office.png`

> **Architecture diagram placeholder**  
> Suggested path: `docs/images/agenthub-architecture.png`

---

## Run from source

At the moment, AgentHub is intended primarily for developers who want to build and test it from source.

### 1. Backend

Requirements:

- Node.js **20+**
- npm
- Supported Agent tools installed locally as needed

```bash
git clone https://github.com/704986409/AgentHub.git
cd AgentHub

npm install
npm run check
npm run build

node dist/cli.js serve
```

Default Backend address:

```text
http://127.0.0.1:3210
```

Useful Backend commands:

```bash
npm run typecheck
npm run build
npm run lint
npm test
npm run check
```

Codex environment diagnostics:

```bash
node dist/cli.js doctor
```

### 2. Desktop

```bash
git clone https://github.com/704986409/AgentHub-Desktop.git
cd AgentHub-Desktop

npm install
npm run dev
```

The Desktop communicates with AgentHub Backend through HTTP APIs and a realtime WebSocket channel.

---

## API-first design

AgentHub intentionally keeps the orchestration authority in the Backend.

That means new clients can be built without reimplementing scheduling, review, recovery, and assignment truth.

Potential clients include:

```text
Desktop App
Web Management UI
Mobile App
Remote Control Client
Other AgentHub Nodes
Automation / Integration Services
```

This design also makes AgentHub suitable for future "personal Agent team" scenarios where a user can issue work from one device while Agents execute on another machine.

---

## Roadmap

The current roadmap includes, among other things:

- **Mobile App** — a personal Agent team / private Agent assistant interface.
- **Web management interface** — manage AgentHub from a browser.
- **P2P device connectivity** — explore a more private device-to-device communication model.
- **QR-code device pairing** — simplify trusted device onboarding.
- **Multi-computer / multi-node AgentHub** — coordinate AgentHub clients and execution nodes across machines.
- **More private messaging transport** — future transport design is still being evaluated; no specific protocol is committed yet.
- **JevAI integration** — integrate JevAI into the AgentHub ecosystem and routing / reflex layer.
- **More Providers** — expand the Provider abstraction as integrations mature.
- **Release packaging** — move from source-only development toward installable releases when the system is ready.

The roadmap is intentionally flexible while the architecture is still being validated.

---

## Mobile vision

The planned mobile experience is not just a remote desktop.

The goal is a **personal Agent team / private Agent assistant**:

```text
You
 │
 │ Create task / approve / review
 ▼
Mobile AgentHub
 │
 │ Secure remote transport
 ▼
AgentHub Backend
 │
 ├─ Plans
 ├─ Tasks
 ├─ Scheduler
 ├─ Dispatcher
 ├─ Review
 └─ Providers
      │
      ▼
Your Agent Team
```

A user should eventually be able to create tasks, monitor progress, review results, approve changes, and manage a personal Agent team from a phone while execution happens on another trusted machine.

---

## Design principles

AgentHub is developed around a few non-negotiable boundaries:

1. **The human is the final decision maker.**
2. **The Backend owns authoritative state.**
3. **Clients present, mediate, and submit intent; they do not invent lifecycle truth.**
4. **Providers execute work behind a common abstraction.**
5. **Review is part of the lifecycle, not an optional visual decoration.**
6. **Recovery must fail closed when execution side effects are uncertain.**
7. **Extensibility should come from stable contracts instead of duplicating orchestration logic in every client.**

---

## Repositories

| Repository | Purpose |
|---|---|
| `704986409/AgentHub` | Authoritative Backend, lifecycle, scheduling, Providers, review, recovery, API |
| `704986409/AgentHub-Desktop` | Desktop visualization, interaction, lifecycle workspace, developer-facing UI |

---

## Contributing

The project is still evolving quickly.

Issues, testing feedback, architectural discussion, Provider integration ideas, and reproducible bug reports are welcome.

When contributing, please avoid moving authoritative lifecycle logic into clients. The Backend should remain the source of truth.

---

## Usage and license notice

AgentHub is currently made available for **personal, non-commercial use**.

**Commercial use is not permitted without separate authorization from the project owner.**

This is a source-available personal-use policy and should not be interpreted as an OSI-approved open-source license. A dedicated license document may define the complete legal terms.

---

## Acknowledgements

AgentHub Desktop is based on the Munder Difflin desktop project. The upstream project, its contributors, and its original work are acknowledged in the Desktop repository together with provenance and baseline documentation.

---

<div align="center">

### Build your own Agent team.

**One person can still have a team.**

[中文](./README.zh-CN.md)

</div>
