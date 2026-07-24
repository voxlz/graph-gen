import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatGraphFile, formatGraphText } from "../src/format";

describe("formatGraphText", () => {
  it("normalizes block indentation to four spaces", () => {
    const result = formatGraphText(`
nodes {
box customer
group services {
box catalog
}
}
`);

    expect(result.errors).toEqual([]);
    expect(result.formatted).toBe(
      [
        "nodes {",
        "    box customer",
        "    group services {",
        "        box catalog",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("preserves braces inside quoted labels", () => {
    const result = formatGraphText('nodes {\nbox message: "{ hello }"\n}');

    expect(result.errors).toEqual([]);
    expect(result.formatted).toBe('nodes {\n    box message: "{ hello }"\n}\n');
  });

  it("collapses repeated blank lines in imported graph files", () => {
    const result = formatGraphText(`
import "../scopes/bookstore_scope.txt"

title "Bookstore - UC2 - Track a shipment"


graph {
    nodeGap 150
}




edges {


    customer --> gateway: "1. GET /orders/{id}/tracking {cookie:auth}"
    gateway --> orders: "2. get order {id}"
    orders --> postgres: "3. READ {order, shipment ref}"


    orders --> shipping: "4. GET tracking {shipment ref}"
    shipping --> orders: "5. Return {status, ETA}"



    // comment
    orders --> gateway: "6. Return {tracking}"
    gateway --> customer: "7. Return {status + ETA}"
}
`);

    expect(result.errors).toEqual([]);
    expect(result.formatted).toBe(`import "../scopes/bookstore_scope.txt"

title "Bookstore - UC2 - Track a shipment"

graph {
    nodeGap 150
}

edges {
    customer --> gateway: "1. GET /orders/{id}/tracking {cookie:auth}"
    gateway --> orders: "2. get order {id}"
    orders --> postgres: "3. READ {order, shipment ref}"
    orders --> shipping: "4. GET tracking {shipment ref}"
    shipping --> orders: "5. Return {status, ETA}"

    // comment
    orders --> gateway: "6. Return {tracking}"
    gateway --> customer: "7. Return {status + ETA}"
}
`);
  });
});

describe("formatGraphFile", () => {
  it("rewrites valid parsed graph files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-"));
    const file = path.join(directory, "graph.txt");
    fs.writeFileSync(file, "nodes {\nbox customer\n}");

    try {
      const result = formatGraphFile(file);

      expect(result.errors).toEqual([]);
      expect(fs.readFileSync(file, "utf8")).toBe(
        "nodes {\n    box customer\n}\n",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not rewrite files with parse errors", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-"));
    const file = path.join(directory, "graph.txt");
    const invalidText = "nodes {\nbox customer\n";
    fs.writeFileSync(file, invalidText);

    try {
      const result = formatGraphFile(file);

      expect(result.errors).toEqual(["Unbalanced braces in DSL block"]);
      expect(fs.readFileSync(file, "utf8")).toBe(invalidText);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
