# Graph Rendering Flow

```mermaid
flowchart TD
  source[.ggn source] --> format[format.ts]
  format --> parse[parse.ts]
  parse --> spec[In-memory GraphSpec]
  spec --> validate[validate.ts]
  validate --> render[render.ts]
  render --> engine{GRAPHGEN_LAYOUT}
  engine -->|constraint| seeds[Grid + WebCola seeds]
  engine -->|curved (default) / orthogonal| seeds
  seeds --> solve[solveLayout]
  solve --> minimize[minimizeLayout]
  engine -->|cola| cola[WebCola Layout.start]
  minimize -->|constraint| draw[Canvas drawing]
  minimize -->|curved / orthogonal| route[routing.ts edge routes + labels]
  route --> draw
  cola --> draw
  draw --> png[PNG]
```
