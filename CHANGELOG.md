# Changelog

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
