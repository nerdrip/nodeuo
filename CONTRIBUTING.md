# Contributing

Thanks for helping make this shard/client better. This is a public AGPL project,
so contributions are expected to remain available to the community under the
same license.

## Ground Rules

- Be respectful and specific. Critique code and behavior, not people.
- Keep issues and pull requests focused. One behavioral change per PR is easier
  to review than a mixed pile of refactors and features.
- Do not commit proprietary Ultima Online client files, generated assets, save
  files, account dumps, passwords, or private shard data.
- Do not paste code from projects whose license is incompatible with
  `AGPL-3.0-or-later`.
- When porting behavior from ServUO/ClassicUO references, write our own
  implementation and explain the parity target.

## License Agreement For Contributions

By contributing, you confirm that:

- you wrote the contribution or have the right to submit it;
- the contribution can be licensed as `AGPL-3.0-or-later`;
- if your change is based on another project, you clearly disclose the source
  and its license in the PR.

## Development Setup

```bash
pnpm install
UO_SRC="/path/to/Ultima Online Classic" tools/sh/extract-assets.sh
tools/sh/run-server.sh
tools/sh/run-client.sh
```

Windows equivalents:

```powershell
pnpm install
$env:UO_SRC="C:\Path\To\Ultima Online Classic"
tools\bats\extract-assets.bat
tools\bats\run-server.bat
tools\bats\run-client.bat
```

## What To Test

Run the narrowest useful test first, then broaden if the change affects shared
behavior.

| Change area | Suggested checks |
| --- | --- |
| server engine | `pnpm --filter @uo/server test` |
| script content | `pnpm --filter @uo/server test` and in-game `[reload` |
| protocol package | `pnpm --filter @uo/protocol test` |
| browser client | `pnpm --filter @uo/client build` |
| asset extractor | `pnpm --filter @uo/extractor run ktx2:dry-run` or a narrow extract |
| repo-wide refactor | `pnpm test` and `pnpm build` |

## Coding Guidelines

- Prefer existing module boundaries over new global helpers.
- Use indexed world APIs and script APIs instead of scanning all mobiles/items
  in hot paths.
- Keep gameplay content in `apps/scripts` when it can live there.
- Keep engine code in `apps/server/src` generic and reusable.
- Make script registrations hot-reload-safe through lifecycle disposers.
- Do not commit generated `apps/client/public/assets`, `saves`, or local logs.
- Add focused tests for regressions and protocol behavior.
- Update docs when changing commands, launchers, env vars, or public APIs.

## Pull Request Checklist

- [ ] The PR explains what changed and why.
- [ ] Tests or manual verification are listed.
- [ ] Docs are updated when public behavior changed.
- [ ] No proprietary assets or local saves are included.
- [ ] New dependencies are justified.
- [ ] License compatibility is clear for copied or ported ideas.

## Reporting Issues

Good bug reports include:

- operating system and Node/pnpm versions;
- launcher or command used;
- relevant env vars, with secrets removed;
- expected behavior;
- actual behavior;
- logs or screenshots when useful.

Security-sensitive issues should not be posted publicly. Use a private channel
with the maintainer until a fix is ready.
