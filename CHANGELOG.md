# Changelog

## v4.5.0

- Added `-r` / `--recursive [path]` to regenerate every `.ggn` file under a
  directory using each graph's usual output path.
- Added the public npm package `graph-gen`, providing the `graph-gen`
  command and `npx graph-gen`, including recursive and watch modes.
- Added npm publishing with provenance on version tags, alongside Docker
  publishing. Repository setup requires an `NPM_TOKEN` Actions secret.

## v4.4.0

- Group titles are now label obstacles in every render mode: nodes, edges and
  other labels keep clear of them. Long, multiline and nested titles reserve
  enough space; hidden groups do not reserve title space.
- Orthogonal runs keep at least 6 px from parallel group borders while still
  allowing edges to cross a border to enter or leave a group.
- Orthogonal routes are simplified again after label placement to remove
  redundant doglegs, including routes through label nodes, while preserving
  label contact, centred endpoints and collision clearances.
- Prevented route simplification from introducing immediate backtracking.
  Final routes prefer fewer bends over full-length interior sections while
  retaining the preference for 20 px endpoint approaches and 10 px label
  no-turn margins. This removes the unnecessary Weather API to Redis detour
  in the weather scope without changing the weather UC1 layout.
- Regenerated example renders for all render modes.

## v4.3.0

- Orthogonal edges now connect at node-side centres. Subpixel alignment
  differences below 0.5 px no longer introduce unnecessary bends.
- Parallel orthogonal runs aim for 6 px separation, except for short shared
  attachment stubs. Routes favour straight sections of at least 20 px and
  balanced bends instead of turning just before arrowheads.
- Orthogonal labels keep a 10 px no-turn margin around their padded chips.
  Detached labels pull their edge onto a straight section when safe, without
  adding crossings.
- The `labelNodes` setting now also supports `orthogonal`, with the same
  `auto` default as `curved`. Unreachable orthogonal labels produce a warning.
- Improved orthogonal compaction of disconnected nodes and provider groups,
  preserving solved label positions and node clearance.
- Regenerated the orthogonal example renders. Other render modes are unchanged.

## v4.2.0

- Edge labels in the `curved` and `orthogonal` layouts now touch their own
  edge: centred on it where there is room, otherwise beside it with the edge
  still passing through the label's middle. Labels keep an arrowhead's
  clearance from nodes and stay clear of other labels and edges.
- With `curved`, an edge whose label has no room beside it bends to reach the
  label, without moving any node.
- New `labelNodes` graph setting (`GRAPHGEN_LABEL_NODES`): with `curved`,
  labels that still can't touch their edge, or that would stick out of the
  layout, are laid out as nodes that push other nodes away and have their edge
  routed through them. `auto` (default) does this only for those labels,
  `true` for every label, `false` never.
- Curves are kept inside the layout where possible, and the image now always
  includes every edge and label (they could be cut off before).
- Edge label lines wider than the new `labelMaxWidth` graph setting (default
  220 px, `0` to turn off) are wrapped at spaces, in every layout engine.
- Benchmark: `labelLines` no longer counts a label crossed by its own edge.

## v4.1.0

- New `--watch` (`-w`) flag: `graphgen --watch [path] [output-directory]`
  re-renders graphs on save, also from the Docker image.
- New `--help` (`-h`) and `--version` (`-v`) flags. Unknown options now fail
  with exit code 2.

## v4.0.0

- **Breaking:** `curved` is the new default layout engine (was `cola`). Set
  `graph.layout "cola"` or `GRAPHGEN_LAYOUT=cola` to keep the old layouts.
- New `curved` engine: each edge is one smooth curve routed around nodes and
  boundaries, so edges never cross each other or pass through nodes and labels
  sit beside their edge. Layouts are about 15% smaller than Cola's on average.
- New `orthogonal` engine: like `curved`, with horizontal/vertical edges joined
  by as few 90° bends as possible.
- Nodes without edges (e.g. attackers) are moved into free space when that
  makes the graph smaller.
- `constraint` engine is much faster and also starts from a WebCola layout.
- Faster rendering: the watcher, `render-all`, `generate` and the Docker image
  run a precompiled bundle (`npm run build`), and the watcher renders up to four
  graphs in parallel.
- New `npm run benchmark` to compare engines on a folder of graphs.

## v3.0.5

- Make Cola the default layout engine; `constraint` and `force` remain available
  through `graph.layout` or `GRAPHGEN_LAYOUT`.

## v3.0.3

- Watch mode now respects graph-local and global default output paths when no output directory is supplied.
- `npm run watch` keeps the existing local behavior by explicitly rendering into `renders/`.
- Removed unused JPEG, GIF, and SVG development libraries from the Docker image while retaining Cairo and Pango support.

## v3

- Introduced a custom constraint-based layout engine.
  - Improved layout quality.
  - Added label-overlap avoidance by treating labels as layout-aware elements (conceptually similar to intermediate nodes), keeping edge labels from colliding with nodes and other text while preserving graph intent as much as possible.

## v2

- Add a `graph.config.ts` file to define default output path behavior for generated images.
  - Example: if default path is `../image`, rendering `graph/uc2.ggn` with no explicit output should produce `image/uc2.png`.
- Add `labelFormat` in the graph display block.
  - Should support edge index and edge type so formatting like `(label, index, type) => "{index}. {label}"` is possible.
- Create `watcher.ts`.
  - When run (with a provided path, or local path by default), it should find all `.ggn` files and on save: parse, validate, generate images, and format modified files.
  - It should print errors in red text in the console and continue running until manually stopped.
- Accept `.ggn` and `.txt` as graph generation input file types.
- Create `format.ts`.
  - It should save parsed files back to disk in a normalized format.
  - Ensure consistent whitespace and 4-space indentation per `{}` block.
  - Add unit tests for formatting.
- Split responsibilities into `parse.ts` and `validate.ts`.
  - `parse.ts` should only load the data structure.
  - `validate.ts` should check impossible constraints, missing references, and related semantic issues.
  - Both should be able to return errors.
  - Parse errors should fail the main call.
  - Validate errors should be reported while still allowing fallbacks.
  - Add unit tests for both.
- Add Jest support.
- Add Prettier.
- Enable ESLint and `typescript-eslint` and keep lint green.
- Convert project to TypeScript and keep `tsc --noEmit` green.
