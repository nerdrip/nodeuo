# Documentation Index

This directory keeps documentation that is larger than the root quickstart.

## Start Here

| Document | Purpose |
| --- | --- |
| [../README.md](../README.md) | project overview, architecture, public repo rules |
| [../QUICKSTART.md](../QUICKSTART.md) | shortest local setup path |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | contribution rules and review checklist |
| [../LICENSE](../LICENSE) | project license summary and SPDX identifier |
| [../tools/README.md](../tools/README.md) | Windows/Linux launchers, ports, environment variables |

## Engine And Scripting

| Document | Purpose |
| --- | --- |
| [server-scripting.md](server-scripting.md) | current server scripting API |
| [scripting/getting-started.md](scripting/getting-started.md) | script quickstart and authoring workflow |
| [scripting/gumps.md](scripting/gumps.md) | server/client gumps, JSON layouts and compatibility |
| [scripting/script-studio.md](scripting/script-studio.md) | advanced script discovery, generation, validation and hot reload |
| [scripting/configuration.md](scripting/configuration.md) | config identity, data taxonomy and publishing |
| [scripting/examples.md](scripting/examples.md) | complete script patterns and checklist |
| [../apps/server/src/content/ARCHITECTURE.md](../apps/server/src/content/ARCHITECTURE.md) | engine vs scripts split |
| [../apps/server/src/systems/README.md](../apps/server/src/systems/README.md) | gameplay systems overview |
| [architecture/performance-slo.md](architecture/performance-slo.md) | live SLO, adaptive budgets and client quality pressure |
| [architecture/nodeuo-extensions.md](architecture/nodeuo-extensions.md) | NodeUO JSON v2, classic UO fallbacks and compatibility matrix |
| [architecture/platform-operations.md](architecture/platform-operations.md) | moderation, approvals, previews, live events and operational safety |
| [architecture/multis-housing-boats.md](architecture/multis-housing-boats.md) | multi representation, housing, custom foundations, boats and classic compatibility |
| [audits/gameplay-systems-audit-2026-09-05.md](audits/gameplay-systems-audit-2026-09-05.md) | death, ghosts, skills, magic, crafting, NPC AI, and merchant audit |
| [../apps/scripts/SCRIPTING.md](../apps/scripts/SCRIPTING.md) | script package notes |
| [../apps/scripts/src/skills/README.md](../apps/scripts/src/skills/README.md) | skill command mapping |
| [../apps/scripts/src/data/README.md](../apps/scripts/src/data/README.md) | data taxonomy and loaders |

## Assets And Client

| Document | Purpose |
| --- | --- |
| [assets-workbench.md](assets-workbench.md) | Admin Assets, decoded resource editing, PNG overrides and safety model |
| [../packages/extractor/ktx2-readme.md](../packages/extractor/ktx2-readme.md) | KTX2/Basis post-processing |

## Maintenance Rules

- Keep root docs focused on onboarding and public project expectations.
- Keep module-specific docs next to the module they describe.
- Update documentation in the same change as public behavior changes.
- Never document a workflow that requires committed proprietary UO assets.
- If a README becomes stale, fix it or link to the canonical current document.
