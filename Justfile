set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

# Generate Lazuli syntax artifacts and install Helix highlighting for .lz files.
install: install-helix
  @hx --health lazuli

# Regenerate the Baba parser and native Tree-sitter parser.
helix: generate-lazuli
  @deno run --allow-read=language/lazuli --allow-write=language/lazuli/generated/tree-sitter --allow-run=tree-sitter tools/build_lazuli_helix.ts

generate-lazuli:
  @deno task generate:lazuli

# Install the Lazuli parser, queries, and language registration into Helix's user config.
install-helix: helix
  @deno run --allow-read --allow-write --allow-env=HOME,XDG_CONFIG_HOME tools/install_lazuli_helix.ts
