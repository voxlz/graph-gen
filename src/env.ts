type GraphEnvName =
  | "CONSTRAINT_HINTS"
  | "DEBUG_FRAMES"
  | "DUMP"
  | "FORCE_DEBUG_FRAMES"
  | "ITERS"
  | "LABEL_NODES"
  | "LAYOUT"
  | "LAYOUT_ITERS"
  | "MINIMIZE"
  | "WARM_START";

export function graphEnv(name: GraphEnvName): string | undefined {
  return process.env[`GRAPH_GEN_${name}`] ?? process.env[`GRAPHGEN_${name}`];
}
