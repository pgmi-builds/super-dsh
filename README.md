# Super D

Super Dash combines native [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) tools with a Foreign Agent Hub: Codex, Claude, OMP, Pi, Hermes and Antigravity in the same DSH Web UI.

This repository develops and releases two packages together:

| Package | Source | What installing it provides |
| --- | --- | --- |
| `super-dsh` | [Super Dash](./super-dsh/) | Better Dash tools and native Web policies, plus the Hub and foreign-agent adapters |
| `better-dsh` | [Better Dash](./better-dsh/) | Native DSH tools and Web policies independently |

Super Dash and Better Dash are independent packages. On first use, Super requests Better through the native DSH Plugin Manager: its own installed version first, then `better-dsh@latest`, then bare `better-dsh` if each preceding request fails. User disable/removal choices survive restarts and upgrades; Hub Settings offers explicit reinstall. Both retain independent YAML, Plugin Manager rows and component switches; dev WebMCP remains separate.

The two packages share test iteration **0.3.0-f** (unpublished). Earlier npm releases retain their original versions. The old Better Dash checkout remains intact for historical reference; active development happens here.

## Development

```sh
npm run version:release -- 0.3.0-f  # synchronize both packages and their exact edge
npm run pack                      # always build both from this repository
npm test
npm run test:4999                  # native consumer, delivered Super Dash tarball
```

The existing upstream checkout and real development dependencies are required. Test homes and artifacts are ignored. Delivery acceptance serves the verified local pair through a test-only registry; never substitute source links or an older public Better release. See [the development guide](docs/07-cordis-dsh-dev-test-guides.md) for setup, native-peer alignment and target-machine testing.

| Path | Role |
| --- | --- |
| `super-dsh/` | Hub, adapters and full pack |
| `better-dsh/` | Independently installable native tool pack |
| `dev-webmcp/` | Test-only browser tools; excluded from both release tarballs |
| `scripts/`, `test/` | Version coordination and artifact-pair delivery checks |
| `docs/` | Shared design, specs, references and reports; [navigation](docs/README.md) |
| `upstream/`, `.tests/`, `.scratch/` | Local upstream, test homes and artifacts; ignored |
| `archive/` | Frozen earlier experiments |

GitHub uses this repository as the product root; Better Dash has its [own directory URL](https://github.com/pgmi-builds/super-dsh/tree/master/better-dsh). Historical branches/tags are kept with their source prefixes; the migration preserves both original Git roots.

[Domain glossary](CONTEXT.md) · [Super Dash details](super-dsh/README.md) · [Better Dash details](better-dsh/README.md)

MIT
