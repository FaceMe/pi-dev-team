---
name: factory-ui-design
description: Prepare a factory UI preview, design system, and frontend handoff from an approved specification. Use for the factory designer role or a frontend ticket that consumes docs/design.
---

# Factory UI design

Read the approved spec and the architecture decisions before design work.
For an existing application, inspect its components and visual conventions.
Keep the required user journeys and requirement IDs in the handoff.

Use the design tools enabled in the worker context.
Read a tool's schema before use. A bridge can add a prefix to its tool names.

- Paper operates on the open Desktop file. Inspect its identity before editing.
- OpenDesign supplies read-only references and design systems. Use references to support design decisions.
- Doop requires its guide before editing. Call the loaded `get_guide` tool first.

Report a missing connection as unavailable. Do not claim an external preview exists without a successful tool result.
Complete the local preview and handoff when external tools are unavailable.

For a designer assignment, write these files inside the assigned design scope:

- `design-system.md`: color, typography, spacing, layout, component states, and accessibility rules.
- `handoff.md`: journeys, screens, components, requirement IDs, and implementation guidance.
- `preview.html`: a responsive preview with main, empty, loading, error, and success states.
- `evidence.json`: provider status, successful tool calls, preview paths, and limitations.

Evaluate a preview against its journeys. Check labels, hierarchy, keyboard access, visible focus, reflow, and contrast.
Use browser evidence for interaction claims. A screenshot alone cannot prove that controls work.

For a frontend ticket, read `docs/design/handoff.md`, `docs/design/design-system.md`, and the preview before implementation.
Preserve the design tokens and component states. Report a conflict with the specification.
Keep changes inside the ticket's file scope.

Write the handoff in Simplified Technical English. Use short sentences and consistent terms.
End with artifact paths, observed checks, unavailable integrations, and unresolved decisions.

Provider references: [Paper](https://paper.design/docs/mcp), [OpenDesign](https://opendesign.cc/mcp/), [Doop](https://doop.design/docs/get-started).
Accessibility reference: [WCAG 2.2](https://www.w3.org/TR/WCAG22/).
