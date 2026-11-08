# Autonomous UI/UX, Art Direction, and Motion Upgrade

Braden pasted this into the orchestrator chat on 2026-09-27 (session 37b). It's kept here word for word so the next session can work from it. Orchestrator scoping notes are at the end.

## 1. Mission and quality bar

Work inside the current project as its lead product designer, art director, UX architect, motion designer, and frontend engineering lead. Execute the upgrade; do not stop at an audit, proposal, moodboard, or static mockup.

Create a distinctive, exceptionally polished experience that expresses this project's mission and improves how people understand and use it. Aim for work worthy of a major public showcase, but optimize for the people using the product—not a recording at their expense.

Be creatively ambitious. Explore exceptional typography, composition, color, custom imagery, interaction, motion graphics, and appropriate dimensional or 3D experiences. Make the result feel authored specifically for this product rather than assembled from a generic template.

Quality means visual distinction, coherent art direction, intuitive workflows, accessibility, responsiveness, reliable behavior, strong performance, and maintainable implementation together. Do not trade away a critical requirement for spectacle.

Defaults: discover context from the project; make reversible creative decisions autonomously; preserve working product capabilities; use the existing stack unless a change is demonstrably necessary; complete at least three distinct post-implementation review passes; verify every completion claim.

## 2. Discover the product before designing

Read applicable project instructions, documentation, route structure, components, styles, dependencies, existing tests, and relevant product content. Inspect the running interface when possible. Respect instruction priority and preserve unrelated work.

Create a concise working brief containing:
- Product mission, intended users, primary jobs, and important user journeys.
- Surface types: marketing, transactional, application, mobile/native, dashboard, conversational/agentic, or a mixture.
- Brand constraints, current strengths, usability problems, and opportunities for differentiation.
- Existing frontend architecture, design tokens, assets, supported devices, and integration boundaries.
- In-scope routes, shared components, interaction states, and acceptance criteria.

Distinguish verified facts, reversible design assumptions, and unresolved product requirements. Cite project files or observed behavior for consequential decisions. Do not invent customers, capabilities, pricing, testimonials, statistics, or business requirements.

Map the complete presentation layer, not just the landing page. Include authentication, onboarding, settings, dialogs, forms, errors, and role-specific views where present. Do not add unrelated product features or a new frontend to a headless project without authorization.

For a greenfield interface, use the supplied product brief and existing architecture as the baseline. Mark nonexistent screens as not applicable and build the authorized presentation layer without inventing business requirements.

Before editing, record repository status and establish a baseline: representative screenshots, critical-flow behavior, available test results, and relevant performance measurements. Record pre-existing failures separately. Do not overwrite uncommitted work or reset the repository.

## 3. Establish original art direction

Before broadly implementing, develop three genuinely different visual directions suited to this product. Describe each direction's concept, typography, palette, composition, imagery, interaction language, and motion character. These must differ in design logic—not merely accent color.

When research is available, study a small set of relevant references. Extract principles such as editorial hierarchy, spatial composition, navigation clarity, and motion pacing. Record sources. Do not copy a site's identity, proprietary assets, or entire layout.

Use lightweight visual studies on the same representative screen to compare directions. Choose the strongest direction autonomously based on product fit, clarity, distinctiveness, feasibility, and performance. Render the selected direction at desktop and mobile sizes, or applicable native sizes, before scaling it across the project.

Define a compact art-direction specification: design thesis, palette roles, type hierarchy, layout/grid, density, shape language, imagery treatment, and motion principles. Identify one or two signature experiences that make the product memorable. Preserve these through implementation without compromising core workflows.

Avoid reflexive purple gradients, interchangeable card grids, arbitrary glass effects, oversized empty areas, excessive rounded containers, and decorative technical imagery unrelated to the mission. These techniques are not forbidden; they must earn their place.

Do not make every component different. Create one coherent design language with deliberate variation between surfaces. Familiar interaction conventions should remain understandable. Simplify weak ideas rather than making them more complicated.

## 4. Use real capabilities and disciplined delegation

Preferred lead designer: GPT-6 Astra, when genuinely available. Preferred implementation workers: Claude agents, when genuinely available. Use actual supported model identifiers and delegation tools; never pretend to switch models, invoke a worker, or receive an independent review.

If those models or delegation tools are unavailable, continue with the available agent and explicitly separate design, implementation, and critique stages. Report the actual execution arrangement.

When a swarm/orchestrator exists, use its established ownership and integration protocol. The lead owns product intent, shared tokens, component contracts, art direction, and final integration. Workers receive bounded tasks, file ownership, dependencies, acceptance criteria, and required evidence.

Parallelize independent work, not competing edits. Assign one owner to shared styles, navigation, dependency manifests, and lockfiles. Use isolated workspaces when supported. Integrate and test work before dependent tasks proceed. Scale concurrency only when ownership and dependency boundaries make it safe.

## 5. Upgrade the actual design system

Create or refine reusable semantic tokens for color, typography, spacing, layout, radii, borders, elevation, layering, and motion. Use platform-appropriate mechanisms and existing project conventions. Support existing themes; do not add themes merely to increase scope.

Build consistent primitives and patterns for the controls this product actually uses. Cover default, hover, focus, active, selected, disabled, loading, error, and success states as applicable. Unify iconography, alignment, component density, content width, and responsive behavior.

Replace scattered, conflicting hardcoded styling with intentional system values. Keep legitimate one-off compositions explicit instead of forcing every value into a token. Avoid competing component libraries or abstraction layers without demonstrated benefit.

Apply the system across all in-scope surfaces. A spectacular hero above inconsistent forms, dashboards, and settings is not a completed upgrade.

Create or update a lightweight component/state gallery using the project's existing tooling where possible. Keep application logic and data contracts separate from presentation changes.

## 6. Adapt UX to the surface

For marketing and storytelling: communicate the promise, explain the problem, demonstrate the product's mechanism, show verified proof, and guide the user to a clear next action. Give sections distinct narrative roles instead of repeating the same layout. Use truthful, specific copy.

For apps, dashboards, and operational tools: prioritize navigation, information hierarchy, scanability, task completion, progressive disclosure, and recovery. Respect power-user workflows and meaningful information density. Do not turn a working dashboard into a marketing page.

For mobile/native surfaces: respect platform navigation, safe areas, software keyboards, touch behavior, back gestures, orientation, and text scaling. Design for the actual platform rather than shrinking a desktop composition.

For chat, RAG, and agent interfaces: make message hierarchy, the composer, sources, attachments, streaming, cancellation, retries, and errors clear where supported. Handle long conversations, code, tables, and long answers. Preserve the user's reading position; do not force-scroll someone reading earlier messages.

Reflect actual retrieval, tool, approval, and execution states. Never invent citations, confidence percentages, progress percentages, or hidden reasoning. Present concise status summaries backed by real system events. Distinguish proposed actions from approved, running, completed, and failed actions. Unsupported capabilities remain clearly documented proposals—not decorative buttons pretending to work.

For transactional flows: preserve validation, confirmations, permissions, and protection from duplicate or accidental actions. Reduce unnecessary steps without bypassing safeguards.

Across all surfaces, design empty, first-use, loading, partial, offline, permission-denied, error, and success states where applicable. Test realistic content extremes, not only ideal demo data.

## 7. Create a purposeful motion and storytelling system

Where a marketing, onboarding, educational, or showcase surface benefits from it, create a mission-driven narrative experience. Story-driven scrolling is preferred only when scrolling is the right interaction; otherwise express the story through guided transitions, interactive exploration, or staged disclosure.

Before coding a narrative sequence, specify its beats: what users see, what changes, what they learn, what they can do, how the sequence progresses, and its mobile/static/reduced-motion alternative. The experience must communicate something specific about this product.

Consider techniques such as interactive product demonstrations, controlled 3D scenes, layered depth, SVG animation, masking, dissolves, image sequences, cinematic transitions, custom illustration, and responsive data visualization. Select a coherent subset rather than stacking every technique.

For each substantial effect, define purpose, trigger, duration/easing or spring behavior, interruption/reversal behavior, resource cost, and fallback. Use consistent motion tokens. Keep everyday interaction feedback immediate; never add artificial waiting to make animations noticeable.

Preserve normal navigation and scrolling. Avoid scroll hijacking, trapped sections, forced pointer behavior, hover-only information, unnecessary cursor replacement, or required animation viewing before completing a task. Sticky sequences must work with short viewports, keyboard navigation, and reverse scrolling.

Honor reduced-motion preferences through genuinely reduced or static alternatives. Provide appropriate controls for ongoing automatic motion. Keep essential content readable and available when decorative media, animation code, or 3D rendering fails.

Pause offscreen or background effects. Clean up animation loops, listeners, observers, and graphics resources. Verify the experience by playing and interacting with it, not by judging a still screenshot alone.

## 8. Use tools and assets intentionally

Discover available tools, MCP integrations, model catalogs, browser automation, asset libraries, and design/generation capabilities. Verify access and supported operations before planning around them. Do not assume that a named service is connected, a credential exists, or a subscription includes a particular capability. Consult current official documentation for selected libraries, providers, and platform APIs instead of guessing versions or integration details.

Use Higgsfield and supported image/video models, such as Kling, when available, authorized, and useful. Research alternatives when they solve a concrete gap. Do not make a particular provider mandatory for completing the design.

Before generating or acquiring assets, define an asset brief: narrative purpose, composition, focal point, visual style, aspect ratios, intended placement, responsive crops, file budget, and fallback. Start with economical drafts. Select and refine assets against the art direction before producing final variants.

Inspect every final asset for artifacts, readability, crop behavior, consistency, and relevance. Keep interactive controls and important text in real accessible UI—not baked into imagery or video. Optimize delivery and provide suitable poster/static alternatives.

Record asset provenance, license or applicable usage terms, attribution, generation recipe when relevant, and output variants. Do not treat a publicly downloadable asset as automatically licensed for this project. Do not send private project data to external services without authorization.

Use existing authorized resources within known budgets and quotas. With no spending authorization, default to no new paid spend. Add vetted project-local dependencies only when justified; preserve reproducibility. Do not create paid accounts, expand access, expose secrets, or connect new services without required consent.

If a tool needs authentication or approval, defer that dependency, implement the strongest available fallback, and continue unblocked work. Never claim an unavailable tool was used.

## 9. Implement in controlled, complete slices

Start with the shared foundation and one representative end-to-end journey. Validate the direction in the real application, then roll it across the remaining scope using a coverage matrix.

Preserve working authentication, authorization, API contracts, persistence, analytics events, routing, localization, and business rules. Where a UX improvement requires a contract change, identify it explicitly; do not silently rewrite the backend or security model.

Use real existing integrations. Keep synthetic fixtures clearly separated from live functionality. Interactive mockups must either work as implemented or be unmistakably labeled demonstrations.

Avoid unnecessary framework migrations, duplicated state, giant components, broad CSS overrides, and dependency accumulation. Prefer the simplest implementation that achieves the intended quality. Remove superseded code only after verifying it is unused.

Keep public content discoverable and semantic where relevant. Test direct route loads and browser navigation. Do not expose secrets through frontend bundles, logs, screenshots, or generated documentation.

Run the project throughout implementation. Inspect actual rendered output with the available browser, simulator, or device tools. Code inspection alone does not establish visual quality or working interaction.

## 10. Accessibility and performance are design constraints

For web surfaces, target WCAG 2.2 AA and applicable project requirements. Include semantic controls, accessible names, keyboard operation, logical focus, contrast, zoom/reflow, meaningful errors, and appropriately sized targets. Add reduced-motion support as an explicit project requirement. Use platform-equivalent accessibility practices for native surfaces.

Combine automated checks with interactive review. Test dialogs, menus, validation, focus restoration, dynamic announcements, and overlays where present. Do not claim comprehensive accessibility conformance from an automated score alone. Record assistive-technology checks that could not be performed.

Before heavy visual work, establish explicit budgets for relevant routes: initial JavaScript, images/video, fonts, startup/loading, interaction latency, and animation work. Base budgets on the current baseline, target devices, and product needs. Do not relax them after implementation simply to declare success.

For web field performance, target LCP <= 2.5 seconds, INP <= 200 milliseconds, and CLS <= 0.1 at the 75th percentile, segmented by mobile and desktop when real-user data is available. Treat these as field targets, not results a local test can certify.

For local verification, record the production-build configuration, browser/device profile, network/CPU conditions, routes, and repeated-run results. Separate lab metrics from field metrics. A Lighthouse navigation run does not establish field INP; report available interaction measurements or proxies honestly.

For native apps, use appropriate startup, rendering, interaction, memory, and frame-time measurements instead of web-only scores. For chat, distinguish frontend responsiveness from model/network time to first content; do not manufacture apparent speed by hiding delays.

Profile representative motion and long-content scenarios. Use appropriate loading priorities, responsive media, code splitting, and lazy loading. Avoid making primary content wait on decorative assets. Report meaningful before/after changes, regressions, limitations, and tradeoffs.

## 11. Complete three real post-implementation passes

The initial build is not an iteration pass. Complete all three passes below after a coherent implementation exists. Continue beyond three when consequential defects remain and can be addressed within available resources.

Every pass must inspect the rendered product, record specific findings, fix relevant defects, and re-render/retest affected behavior. Preserve evidence showing what changed and why. If a reviewed area needs no change, document the checks performed rather than inventing defects or cosmetic churn.

PASS 1 — Art direction and visual craftsmanship
Review composition, hierarchy, typography, line lengths, spacing, color relationships, imagery, optical alignment, responsive layouts, and design-system consistency. Compare against the selected direction and baseline. Strengthen the signature experience and remove generic, weak, or overdesigned elements.

PASS 2 — UX, states, and accessibility
Exercise critical journeys and realistic edge cases. Inspect discoverability, navigation, feedback, validation, recovery, keyboard/touch behavior, focus, text scaling, and reduced motion. Check loading, empty, failure, long-content, and role-specific states. Improve task clarity without changing unsupported product behavior.

PASS 3 — Motion, performance, and integrated reliability
Review motion in action, including interruption, reverse scrolling, route changes, low-resource fallbacks, and repeated use. Profile relevant bottlenecks. Check production builds, runtime errors, layout shifts, missing assets, resource cleanup, and integrated flows. Verify that earlier fixes did not create regressions.

After the final change, rerun affected checks and the integrated critical-flow smoke test. Earlier passing evidence does not cover later untested changes.

## 12. Evidence-based preflight and completion

Maintain a preflight table with: criterion, scope, status, evidence, and unresolved issue. Allowed statuses are PASS, FAIL, BLOCKED, NOT RUN, and NOT APPLICABLE with a reason.

Cover scope completion; design-system consistency; critical journeys and states; responsive/native layouts; accessibility and reduced motion; motion/media fallbacks; performance budgets; applicable type/lint/test/build checks; runtime/network errors; preserved integrations; asset usage rights; and all three iteration passes.

Test every critical journey and changed interaction. Use representative coverage for repeated layouts while explicitly identifying untested routes, devices, roles, and states. Distinguish simulation from real-device and real-service verification.

PASS requires evidence from an executed check or documented inspection appropriate to that criterion. Subjective visual judgments must be labeled judgments, not measured facts. Never delete tests, weaken assertions, hide regressions, or mark unrun checks green.

The goal is all required release checks passing with no unresolved critical or major issues. If that cannot be established, deliver the completed work and state NOT READY / PARTIALLY VERIFIED with precise blockers. Do not silently narrow the scope or claim the project is finished.

## 13. Capture reusable improvements without derailing delivery

Capture useful components, motion patterns, asset recipes, and review procedures discovered through this build. Prefer improving an existing project skill over creating duplicates. Keep documentation compact and implementation-focused.

For each reusable skill, record its purpose, trigger, inputs/outputs, prerequisites, permissions, workflow, failure modes, and a verification example exercised on this project. Separate validated patterns from experimental candidates. Do not claim cross-project generality without broader testing.

Use the repository's established skill format and location. If none exists, save a project-local candidate document rather than silently installing global agent instructions. Never include secrets, client data, or unlicensed assets in reusable materials.

## 14. Autonomy, handoff, and final standard

Proceed without routine approval requests for reversible, in-scope design and implementation decisions. Give concise progress updates at meaningful milestones. Resolve noncritical design ambiguity using project evidence and document assumptions. Do not invent material requirements to avoid reporting a blocker.

Respect permissions for consequential actions. Unless separately authorized, do not commit, push, merge, deploy publicly, modify production data, or publish assets. Prepare a reviewable local result and documented handoff.

Keep a compact execution record with the brief, selected direction, scope/coverage, decisions, evidence, and remaining work. Update existing project documentation where suitable; avoid proliferating process files.

The final handoff must state what changed and why, which surfaces and flows were covered, where to inspect the result, available before/after screenshots or recordings, measured performance changes, findings and fixes from all three passes, preflight status, reusable outputs, and any blockers or external setup requirements.

Only provide paths, URLs, measurements, and artifacts that actually exist. Clearly distinguish implemented, tested, unverified, and proposed work. Do not let documentation replace implementation.

Final standard: build a product-specific experience that is striking at first glance, understandable on first use, efficient on repeated use, and technically credible under inspection. Refine until the evidence supports completion—not merely until the interface looks different.

---

## Orchestrator scoping notes (s37b, 2026-09-27)

- Target surface: `desktop-app` (the Rig: full app, quick box, orb, onboarding, sign-in, Connect, Settings, Activity, Scoreboard, chat and the ask-first cards). OASIS has no marketing site, so marketing sections are NOT APPLICABLE unless Braden says otherwise.
- Prior art in the repo: T19 UI upgrade (`prompts/20-ui-upgrade.md`, `repos/desktop-app/docs/design/{system.md,audit.md,contract.md,critique-*.md,pass-1.md}`); decisions #74–#79 (orb, avatars, themes), #116; queued T22 (avatar library), T23 (themes), T31 (opening splash), T40 (Enter the OASIS).
- Model arrangement: Codex / GPT-6 Astra has been out of credits since 2026-09-26, so the lead-design and art-direction jobs run on Opus. Report this honestly.
- desktop-app takes one ticket at a time (T29 desktop was in flight when this was written).
- Braden's answers: decision #166 (T45; after T29; T23/T31/T40 stay separate; Higgsfield existing credits only; standing merge rules apply).
