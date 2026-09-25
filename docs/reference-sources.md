# Local reference source trees

ServUO and ClassicUO are comparison sources for parity audits and selected
content extractors. They are not server or client runtime dependencies.
`templates/` is Git-ignored and absent from a clean NodeUO clone. Game client
files are also absent and must be supplied separately for asset extraction.

To run reference-based audits, put the source trees at these exact paths:

```text
templates/ServUO/Scripts/
templates/ServUO/Server/Network/PacketHandlers.cs
templates/ClassicUO/src/
```

The upstream source repositories are
[ServUO](https://github.com/ServUO/ServUO) and
[ClassicUO](https://github.com/ClassicUO/ClassicUO). Clone them into those
paths, record the exact upstream commit of each clone, and keep that pair of
commits fixed while comparing audit runs. Follow each project's license and
keep copied reference code out of NodeUO commits.

From the NodeUO root, check the trees and capture content fingerprints:

```bash
pnpm audit:references
pnpm audit:servuo:map:check
pnpm audit:classicuo:map:check
```

`audit:references` records the number and SHA-256 fingerprint of the C# source
files used by the parity comparisons in `artifacts/reference-sources.json`.
Keep that ignored artifact alongside an audit report so later runs can detect
reference drift. ServUO data/spawn extraction also reads non-C# files; record
the source commit for those comparisons.

`pnpm test`, `pnpm lint`, and `pnpm build` run on a clean clone without either
reference tree. The parity commands require local references and now fail when
their input tree is missing or empty, rather than reporting zero open gaps.
The CI workflow runs the clean-clone checks; parity and asset visual checks
remain separate because their reference and game asset inputs are local.
