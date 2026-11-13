# Changelog

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
