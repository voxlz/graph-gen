# graph-gen

Constraint-based graph layout → PNG renderer. Alternative to [PlantUML](https://plantuml.com/) and [Mermaid](https://mermaid.js.org/) when you want to store and generate your graphs from code, but want deterministic constraint control over the layout. Initially conceived to produce the scope and use-case diagrams required by certain threat modeling requirements.

## Example

![Checkout example](renders/demo/showcase/example.png)

```text
// optional per-graph style overrides (here, a light fill for circles).
shapes {
    circle {
        color "#EAF4FF" // Blue
    }
}

// the box/circle/actor/database shapes plus the boundaries and groups
// that contain them.
nodes {
    actor customer: "Customer"
    box web: "Web App"
    boundary cloud: "Cloud VPC" {
        circle api: "Checkout API"
        group core {
            circle payments: "Payment Service"
            circle orders: "Order Service"
        }
        boundary container: "Filesystem" {
            database db: "PostgreSQL"
            database cache: "Redis"
        }
    }
    box stripe: "Stripe"
    actor attacker: "Attacker"
}

// connections between nodes; labelled ones trace the numbered flow,
// plain ones show static architecture links.
edges {
    customer --> web: "1. checkout"
    web --> api: "2. POST /pay {token}"
    api --> payments: "3. charge"
    api --> orders: "4. create order"
    payments --> stripe: "5. charge card"
    payments --- db
    orders --- db
    api --- cache
    attacker ..> api: "spoofed request"
}

// relative-placement rules the layout solver must satisfy.
constraints {
    customer top web
    web top api
    core right api
    payments top orders
    db bottom api
    cache bottom api
    cache left db
    align row db cache
    orders left payments
    orders bottom api
    stripe right payments
    attacker left api
}
```

## Install and run (npm)

The recommended way to run graph-gen is with Node.js 20 or newer and `npx`—no
repository clone is needed:

```bash
npx @voxlz/graph-gen path/to/graph.ggn
npx @voxlz/graph-gen -r .
npx @voxlz/graph-gen --watch path/to/graphs
npx @voxlz/graph-gen --help
```

Or install the `graph-gen` command globally:

```bash
npm install -g @voxlz/graph-gen
graph-gen -r .
```

The package is published under the `@voxlz` scope because npm reserves the
similar unscoped names for other projects; `npx graphgen` runs a different
package.

The npm package includes the compiled CLI and default styles. Rendering uses
`canvas`: supported platforms use prebuilt native binaries; other platforms
need its [native build prerequisites](https://github.com/Automattic/node-canvas#compiling).
Text uses the system sans-serif font, so measurements and layouts can vary
between systems.
Docker remains available if you prefer not to install native dependencies.

## Install and run (Docker)

Docker is an alternative that requires no local Node or native image libraries.
Pull the published image:

```bash
docker pull ghcr.io/voxlz/graph-gen:latest
```

Then render, mounting a folder so the PNG lands back on the host:

```bash
mkdir -p out
docker run --rm -v "$(pwd)/out:/app/out" ghcr.io/voxlz/graph-gen:latest demo/usecases/bookstore_uc1.ggn out/output.png
```

The image appears at `./out/output.png` on your machine. Replace the input and
output paths with your own as needed. Run with `--help` for all arguments and
environment variables, or `--version` for the installed version.

## Output paths

The output argument is optional. If you omit it, graph-gen picks the output path
in this order:

1. CLI output argument (`npx @voxlz/graph-gen input.ggn out/output.png`)
2. Graph-local setting (`graph { outputPath "..." }` inside the rendered `.ggn`)
3. Global style setting (`style.jsonc` -> `graph.outputPath`)
4. Built-in fallback (`../graphs/{file}`)

`{file}` expands to the input filename with a `.png` extension. For example,
`checkout_scope.ggn` becomes `checkout_scope.png`. Relative paths are resolved
from the input graph's directory.

Example global default in `style.jsonc`:

```jsonc
{
  "graph": {
    "outputPath": "../graphs/{file}",
  },
}
```

Example per-graph override:

```text
graph {
        outputPath "./renders/{file}"
}
```

To override the bundled styles, pass a style file as the third argument:

```bash
npx @voxlz/graph-gen input.ggn out/output.png my-style.jsonc
```

With Docker, mount the style file:

```bash
docker run --rm -v "$(pwd)/out:/app/out" -v "$(pwd)/my-style.jsonc:/app/my-style.jsonc" \
    ghcr.io/voxlz/graph-gen:latest demo/usecases/bookstore_uc1.ggn out/output.png my-style.jsonc
```

## Render a directory recursively

Use `--recursive` (or `-r`) to regenerate every `.ggn` file under a directory,
including nested directories, then exit:

```bash
npx @voxlz/graph-gen -r path/to/graphs
npx @voxlz/graph-gen -r .
```

Omitting the path uses the current directory. Each graph uses its configured
output path or the usual default, and its configured layout (curved by default).
Like single-file rendering, this also formats the input files and resolves their
imports. All directories are searched; symbolic links are not followed.
Rendering continues after a failed render, with a nonzero exit status if any fail.

With Docker, mount your project and set the working directory so `.` refers to
the mounted project:

```bash
docker run --rm -v "$(pwd):/work" -w /work ghcr.io/voxlz/graph-gen:latest -r .
```

Mount a parent directory as well if your configured output paths lead outside
the project directory.

## Watch for changes

Use `--watch` (or `-w`) to watch a path while respecting each graph's
`outputPath`, the global `style.jsonc` setting, and the built-in default:

```bash
npx @voxlz/graph-gen --watch path/to/graphs
```

Saved graphs take priority over queued dependency-triggered rerenders.
Renders already in progress finish normally.

You can also provide an output directory explicitly:

```bash
npx @voxlz/graph-gen --watch path/to/graphs path/to/renders
```

With Docker, mount the graphs and keep the container running:

```bash
docker run --rm -v "$(pwd):/work" ghcr.io/voxlz/graph-gen:latest --watch /work/graphs /work/renders
```

## Publishing releases

Version tags (`v*`) publish Docker images and the public npm package
`@voxlz/graph-gen` through separate GitHub Actions workflows. The tag must match
the version in `package.json`; update the lockfile and changelog before tagging.
The npm workflow runs lint, typecheck and tests, then builds the CLI through
`prepack` and publishes it with provenance.

Before the first npm release, configure the repository Actions secret
`NPM_TOKEN` with a granular npm access token authorized to create/publish the
scoped `@voxlz/graph-gen` package. The token must permit non-interactive
publishing (including bypassing 2FA where required). Do not commit the token.

To inspect the package locally without publishing:

```bash
npm pack --dry-run
```

## Showcase

### Nodes

Declare nodes. These are the elements that will make up your graph:

![Node shapes](renders/demo/showcase/example.png)

```text
nodes {
    box boxNode: "Box"
    circle circleNode: "Circle"
    actor actorNode: "Actor"
    database dbNode: "Database"
    boundary boundaryNode: "Boundary" {
        box inside: "Inside"
        boundary innerBoundary: "Nested boundary" {
            box deep: "Deep"
        }
    }
}
```

### Edges

Connect nodes together with edges:

![Edge connectors](renders/demo/showcase/edges.png)

```text
edges {
    a1 --> b1
    a2 <-- b2
    a3 <--> b3
    a4 --- b4
    a5 ... b5
    a6 ..> b6
    a7 <.. b7
    a8 <..> b8
}
```

### Constraints

Apply alignment constraints and relationships between your nodes to force graph to look a certain way:

![Constraints](renders/demo/showcase/compass.png)

```text
constraints {
    // eight directions around a center
    n top center
    s bottom center
    e right center
    w left center
    ne topRight center
    nw topLeft center
    se bottomRight center
    sw bottomLeft center

    // the remaining constraint types
    orbit near hub
    align row rowA rowB
    align col colA colB
}
```

`align row` requires every listed node to have the same y coordinate, while
`align col` requires the same x coordinate.

**Constraints and alignments can target a whole group or boundary, not just
single nodes** — the id expands to all its members, so one rule places or aligns
an entire cluster (e.g. `core right api` puts the whole `core` group to the right
of `api`). Rules referencing an unknown id are skipped with a warning.

## Labels

Add a label to any node or edge with a trailing `: "..."`:

```text
box api: "Checkout API"      // node label (omit it and the id is used)
api --> db: "READ {rows}"    // edge label
```

See the [Edges](#edges) showcase for the arrow/line styles
and [Constraints](#constraints) for placement rules.

### Label formatting templates

Use `labelFormat` in the `graph { ... }` block to keep edge labels consistent
and readable.

```text
graph {
    labelFormat "{index}. {source} -> {target}: {label}"
}
```

You can use these placeholders:

- `{index}` (1-based edge index)
- `{source}`, `{target}`, `{label}`
- `{arrowSource}`, `{arrowTarget}`
- `{lineStyle}`, `{line}`

Behavior:

- Formatting is applied only to labelled edges.
- Unknown placeholders are left unchanged.
- If `labelFormat` is omitted or empty, labels are rendered as written.

### Edge label placement

Edge label lines wider than `labelMaxWidth` (default `220` px) are wrapped at
spaces; set it to `0` in the `graph { ... }` block to turn wrapping off.

With the `curved` and `orthogonal` engines, each edge label touches its own
edge, centred on it where there is room. A label beside its edge still has its
edge pass through its middle, so it never drifts far from the edge. Labels keep clear of nodes (so
arrowheads stay visible), other labels and other edges.

With `curved`, a label that can't fit beside its edge stays where there is room
and the edge bends to reach it, as long as the bend clears nodes, boundaries and
other labels. With `orthogonal`, the edge similarly reroutes through the label
when a clear route is available without adding crossings or hiding bends.

With either engine, labels that still can't touch their edge become label nodes and
the graph is laid out again: each such label pushes other nodes away and its
edge is routed through it. This repeats until every label touches its edge. Control this with `labelNodes` in the
`graph { ... }` block (or `GRAPH_GEN_LABEL_NODES`):

- `auto` (default): only for labels that can't touch their edge otherwise.
- `true`: always. Every label sits on its edge, at the cost of larger layouts.
- `false`: never.

If an orthogonal edge still cannot reach its label, the renderer warns and keeps
the original edge and detached label.

### Group labels

Visible boundary titles are label obstacles in every render mode: nodes, edges
and other labels keep clear of them, including edges entering or leaving that
boundary. Boundaries reserve enough space for long or multiline titles and for
nested group labels, even when smaller padding is configured. Hidden groups
(`draw false`) do not reserve title space.

Orthogonal edge runs also keep at least 6 px from parallel group borders.
Edges can still cross a border to enter or leave a group.
After labels are placed, orthogonal routes are simplified again to remove
redundant doglegs while preserving label contact and collision clearances.
This rejects immediate backtracking and prefers fewer bends over 20 px
interior sections, while retaining the preference for 20 px endpoint approaches.

## Reuse graph with new edges

In threat modeling, you often want to reuse a base graph and add new edges to
describe a specific data flow. Use `import "..."` and then declare the new
edges:

```text
import "../scopes/checkout_scope.ggn"

edges {
    customer --> api: "1. GET /checkout"
}
```

The imported graph contributes its nodes, boundaries, groups, constraints and
styles; only the file being rendered contributes edges.

## Styling

`style.jsonc` holds the global defaults:

- `graph.minGap` — minimum spacing enforced by ordering constraints.
- `graph.nodeGap` — minimum clear space kept between any two nodes (and between
  a node and boundaries it doesn't belong to).
- `graph.linkLength` — target (ideal) edge length, centre-to-centre. Kept as a
  flat constant so high-degree hubs don't fling their neighbours far away.
- `graph.iterations` — the three WebCola solver passes
  `[unconstrained, userConstraint, allConstraint]` (also overridable at runtime
  with `GRAPH_GEN_ITERS=a,b,c`).
- `shapes.<name>` — per-shape `color`, `lineStyle` (`solid`/`dashed`),
  `minWidth`, `minHeight`, `borderRadius`, and optional `borderColor`. Unknown
  shapes fall back to a plain box.

### Layout engines

Set `graph.layout` to choose how nodes and edges are arranged:

| Engine             | Edge style and crossing behavior                                                                                        | Benefits and trade-offs                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curved` (default) | Single smooth curves route around obstacles and penalize crossings.                                                     | A good general-purpose choice for compact diagrams: edges can bend instead of pushing nodes apart. Labels are placed on or beside their edges.                 |
| `orthogonal`       | Horizontal and vertical segments with 90° bends route around obstacles and strongly penalize crossings.                 | A structured, schematic look that makes direction and parallel connections easy to follow. Detours can add bends or space.                                     |
| `constraint`       | Straight edges; the solver rejects crossings between edges without a shared endpoint and edges through unrelated nodes. | Useful when straight, crossing-free connections are important. Nodes may need more space, and the solver can fail if it cannot find a valid layout.            |
| `cola`             | Straight edges from WebCola; edges may cross one another, nodes or labels.                                              | A simple stress-based layout and useful baseline for comparison, especially when compactness matters more than avoiding crossings.                             |
| `force`            | Straight edges from a force-directed starting layout, followed by constraint repair.                                    | Uses attraction and repulsion to find an arrangement before enforcing the straight-edge constraints. If repair fails, it falls back to a constraint grid seed. |

`curved` and `orthogonal` try to avoid obstacles and crossings, but routing is
not a guarantee that every graph can be drawn without them. Both try several
starting layouts and score the routed results for crossings, obstacle hits,
size and edge length. They also support automatic label nodes to help labels
touch their edges; see [Edge label placement](#edge-label-placement).

Orthogonal routes favor side-centred connections, separated parallel runs and
long, balanced sections. Small alignment differences do not introduce extra
bends, and labels keep a no-turn margin so the edge direction remains visible.
Choose `curved` for a softer look, `orthogonal` for a diagram-like style, or
`constraint` when avoiding crossings with straight edges is more important
than compactness.

Environment variables use the `GRAPH_GEN_` prefix. The former `GRAPHGEN_`
prefix remains supported as a deprecated alias; if both are set, `GRAPH_GEN_`
takes precedence.

If the same setting appears in multiple places, this precedence applies:

1. `GRAPH_GEN_LAYOUT` environment variable
2. per-graph `graph { layout "..." }`
3. global style `style.jsonc` (`graph.layout`)
4. default `curved`

Examples:

Global default in `style.jsonc`:

```jsonc
{
  "graph": {
    "layout": "curved",
  },
}
```

Per-graph override:

```text
graph {
        layout "cola"
}
```

You can also set `graph.layoutIterations` (or `GRAPH_GEN_LAYOUT_ITERS`) to
control how many iterations the `constraint` engine can use before stopping.

From a repository checkout, to compare engines on a folder of graphs, run
`npm run benchmark -- <folder>`. It renders every `.ggn` file with each
engine in `BENCH_ENGINES` (default `curved,cola`) and reports image area,
edge lengths, crossings, edges through nodes, label collisions, and layout time.
`BENCH_FILTER` limits the graphs, `BENCH_JOBS=1` gives reliable timings, and
Cola results are cached (`BENCH_FRESH=1` re-renders them).

For development from a repository checkout, `npm run build` precompiles the renderer into
`dist/index.js`; run it with `node dist/index.js <input> [output]` instead of
`tsx src/index.ts` to skip TypeScript transpilation on every run. The watcher,
`render-all`, `generate` and the benchmark do this automatically, rebuilding
the bundle when the source changes, and the watcher renders up to four changed
graphs in parallel.
The npm and Docker packages already include the precompiled renderer.

A graph's own `shapes { ... }` block overrides global shape defaults for that
graph only, and a custom style file can be passed per render (the optional third
CLI argument).
Both `style.jsonc` and JSON inputs may contain `//` comments and trailing commas.
