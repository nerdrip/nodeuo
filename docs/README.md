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
| [scripting/getting-started.md](scripting/getting-started.md) | Polish quickstart and authoring workflow |
| [scripting/gumps.md](scripting/gumps.md) | server/client gumps, JSON layouts and compatibility |
| [scripting/configuration.md](scripting/configuration.md) | config identity, data taxonomy and publishing |
| [scripting/examples.md](scripting/examples.md) | complete script patterns and checklist |
| [../apps/server/src/content/ARCHITECTURE.md](../apps/server/src/content/ARCHITECTURE.md) | engine vs scripts split |
| [../apps/server/src/systems/README.md](../apps/server/src/systems/README.md) | gameplay systems overview |
| [../apps/scripts/SCRIPTING.md](../apps/scripts/SCRIPTING.md) | script package notes |
| [../apps/scripts/src/skills/README.md](../apps/scripts/src/skills/README.md) | skill command mapping |
| [../apps/scripts/src/data/README.md](../apps/scripts/src/data/README.md) | data taxonomy and loaders |

## Assets And Client

| Document | Purpose |
| --- | --- |
| [../packages/extractor/ktx2-readme.md](../packages/extractor/ktx2-readme.md) | KTX2/Basis post-processing |
| [../apps/client/CLIENT_OPTIMIZATION_BACKLOG.md](../apps/client/CLIENT_OPTIMIZATION_BACKLOG.md) | client performance backlog |

## Maintenance Rules

- Keep root docs focused on onboarding and public project expectations.
- Keep module-specific docs next to the module they describe.
- Update documentation in the same change as public behavior changes.
- Never document a workflow that requires committed proprietary UO assets.
- If a README becomes stale, fix it or link to the canonical current document.
