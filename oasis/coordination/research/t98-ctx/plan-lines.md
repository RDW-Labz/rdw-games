12:- **Knows the company.** Reads company data across every venture Cluer owns and operates, through one shared pipeline with one drawer per venture. Answers with sources. Respects role gates so each person sees only what their role allows.
19:Under the agents sits the Journals: one shared, secure RAG pipeline that is the company's source of truth. Data is stored under our control, organized by venture, tagged by sensitivity, searchable across ventures for those allowed. It is modular: any model (Claude, OpenAI, xAI, Ollama, OpenRouter, later our own hardware) and any tool (MCP servers, CLI tools, connectors) plugs in through one interface, so we swap parts without rebuilding agents.
33:  P2 --> P3[Phase 3<br/>Shared RAG pipeline]
110:| `remote` (Zemeckis) | Scrubber with a leak test suite; proxy that records on Windows; macro file format v1 | 0 secrets leak across 200 recorded test traces; one real macro recorded and replayed |
115:| `playbooks` (Garage) | This plan, decisions log, agent-template skeleton | Repo exists and project-swarm can read it |
117:**Memory, defined now so every agent shares it.** Four kinds, all in the person's own drawer, all readable by the person in the app:
143:| 3 | remote | Scrubber: header, cookie, key, query and high-entropy masking; 200-trace leak test | 0 leaks, fails toward hiding |
144:| 4 | remote | Local proxy on Windows: install cert, record HTTP, write raw trace to scrubber | Records Edge, Chrome and Outlook traffic on a test box |
148:| 8 | agent-core | Memory: profile, working, log, notes in the person's drawer; secrets interface over OS keychain | Profile survives restart; a secret is stored and read without ever being printed |
176:- Which data she reaches for and where it lives (this becomes the first venture data drawers).
205:**Part 4: her own docs.** A Docs area in the app where she writes anything she wants the agent to know: how a process works, a checklist she keeps in her head, notes about a venture. Plain text or talk-to-type. Everything she writes goes into her personal drawer and is searchable by her agent right away.
238:| Macro files in a folder | Same files, kept in the person's private drawer (never git: they hold client names and task data). Versioned locally. A macro becomes shareable only after it is turned into a skill with company data replaced by arguments and test fixtures using fakes |
264:## Phase 3 — The shared RAG pipeline
274:  OR --> RT[Retrieval<br/>search + role gate]
275:  RT --> V1[(Venture A drawer)]
276:  RT --> V2[(Venture B drawer)]
277:  RT --> VH[(Holdings drawer)]
283:**Data layout: one drawer per venture.** Each venture gets its own store (documents, embeddings, metadata) with the same folder shape. A Holdings drawer holds what is shared across ventures. Every document carries: venture, source, owner, date, sensitivity level. Agents search one drawer or many; the role gate decides which.
285:First drawers, one per venture, plus Holdings:
287:| Drawer | Venture | What it is | Note |
290:| rdw | RDW, LLC | Owns all retail locations as DBAs | One drawer, a folder per location |
294:| jmac | JMAC Construction | Construction | No revenue yet; small drawer |
299:Adding a venture later is adding a row here and running the new-drawer script.
305:**Retrieval.** Hybrid search (keyword plus embeddings) with reranking. Return chunks with their source so every answer can show where it came from. Log every query and which chunks came back; this is how we tune it.
307:**Ingest.** Connectors that watch a source (a shared drive, email, a SaaS export, an agent's own notes), chunk it, tag it, and drop it in the right drawer. Re-ingest on change. Start with whatever Amber and Michael reached for most in Phases 1 and 2.
309:**UI.** One clean chat screen per employee: talk to your agent, see what it did today, approve or reject proposals, see which sources an answer used. Admin view for adding drawers, connectors, tools and roles.
311:Storage and hosting: Azure, because the team already lives in Microsoft 365. One VM we control running containers, Azure Postgres with pgvector for the drawers, Blob storage for files, Entra ID for employee sign-in. Everything in Docker so it is portable; nothing tied to Azure-only services. Encrypt at rest, backups nightly, no company data sent to a model provider that trains on it. Moving to our own hardware later is then a move, not a rebuild.
313:Done when: Amber's and Michael's agents run on the pipeline instead of local files, every answer shows its sources, and a new venture drawer can be added in a day.
333:**The orb.** A small round button pinned above every window, like a chat head. Drag it anywhere. It is the agent's face and it is always there.
423:| 3 | Storage | Dropbox, Box | Click Allow |
538:- **Role gate.** Each employee has a role; each role has a list of drawers and sensitivity levels it can read and tools it can use. The retrieval layer filters by role before search, not after, so restricted chunks never reach the model.
553:  A -->|can read| D[Drawer]
569:| Drawer | venture\_id, doc\_count, last\_ingest | rdw |
581:| can\_read | Agent → Drawer | Role gate says yes |
583:| reads | Skill → Drawer | The skill searched here |
585:| belongs\_to | Drawer → Venture | Which venture's data |
595:| Member (default) | Their person, their agent, its skills, its connectors, the drawers it can read, the models it runs on |
599:**Where it lives.** Two Postgres tables in the Journals (`nodes`, `links`) plus the `events` table, with the venture and sensitivity columns the role gate filters on. Phase 0 writes events to a local file per agent; Phase 3 ships them to Postgres. The Stacks, when built, reads a filtered graph through one endpoint: `GET /graph?as=<person>`, and the filter is applied on the server, never in the UI.
601:Done when (Phase 3): every agent, skill, connector, drawer and model in use appears in the graph with correct links, and a member's `GET /graph` returns nothing they could not already read.
618:| `rag-pipeline` | **Journals** | Halliday's Journals: the archive of everything |
