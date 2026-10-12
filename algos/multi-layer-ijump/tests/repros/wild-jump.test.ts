import { test, expect } from "bun:test"
import { MultilayerIjump } from "algos/multi-layer-ijump/MultilayerIjump"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import type { AnyCircuitElement } from "circuit-json"

/**
 * Reproduction of the "wild trace jumps" reported in
 * https://github.com/tscircuit/autorouting/issues/92
 *
 * This is a simplified, hand-reduced version of the wifi-test-board-1
 * neighborhood (https://snippets.tscircuit.com/seveibar/wifi-test-board-1)
 * where the wild jump occurs (the neighborhood of `source_trace_20`).
 *
 * The autorouter believes it can't go forward from a point, switches
 * direction, and produces a trace that travels ~3mm PAST the goal point
 * before coming back to it:
 *
 *   (-5.51,-12) -> (-6.51,-12.27) -> (-6.51,-17.55) -> (-5.93,-17.55)
 *   -> (-5.93,-20.59) -> (1.75,-20.59) -> (1.75,-17.55)
 *
 * The segment from (-5.93,-17.55) down to (-5.93,-20.59) overshoots the
 * goal row (y=-17.55) by ~3mm, then the trace runs horizontally at
 * y=-20.59 and comes back up — a total length of ~20.9mm when a ~12.8mm
 * route exists with the same obstacle set (verified by removing either
 * the pill obstacle or the (-4.49,-15) pad, which yields the clean route).
 *
 * The obstacle set is the minimum that reproduces the jump:
 * - an all-layers pill (plated hole) at (-4.33,-18.59), 1.2 x 2.0
 * - the start pad (-5.51,-12) and its neighbor (-4.49,-12)
 * - a pad at (-4.49,-15) between the start and the pill
 *
 * The snapshot captures the CURRENT (buggy) behavior so the fix for #92
 * can flip it intentionally (with an updated snapshot).
 */
const input = {
  minTraceWidth: 0.1,
  layerCount: 2,
  obstacles: [
    {
      type: "oval",
      layers: ["top", "inner1", "inner2", "bottom"],
      center: { x: -4.32511199999999, y: -18.594262350000122 },
      width: 1.1999975999999999,
      height: 1.9999959999999999,
      connectedTo: [],
    },
    {
      type: "rect",
      layers: ["top"],
      center: { x: -4.49, y: -15 },
      width: 0.54,
      height: 0.64,
      connectedTo: [],
    },
    {
      type: "rect",
      layers: ["top"],
      center: { x: -5.51, y: -12 },
      width: 0.54,
      height: 0.64,
      connectedTo: [],
    },
    {
      type: "rect",
      layers: ["top"],
      center: { x: -4.49, y: -12 },
      width: 0.54,
      height: 0.64,
      connectedTo: [],
    },
  ],
  connections: [
    {
      name: "source_trace_18",
      pointsToConnect: [
        { x: -5.51, y: -15, layer: "top" },
        { x: -1.2499339999999393, y: -17.55091295000011, layer: "top" },
      ],
    },
    {
      name: "source_trace_20",
      pointsToConnect: [
        { x: -5.51, y: -12, layer: "top" },
        { x: 1.7500600000000759, y: -17.55091295000011, layer: "top" },
      ],
    },
  ],
  bounds: {
    minX: -7.399985200000149,
    maxX: 9.78,
    minY: -23.674084549999947,
    maxY: 12.425004199999965,
  },
}

/**
 * Render the routing problem + solution as an SVG for snapshotting.
 * Since this repro uses a raw SimpleRouteJson (no full circuit json),
 * we rebuild a minimal circuit json with the obstacles as pads so the
 * board renders.
 */
const getCircuitJson = (solution: any[]): AnyCircuitElement[] => {
  const cj: AnyCircuitElement[] = input.obstacles.map((o, i) =>
    ({
      type: "pcb_smtpad",
      pcb_component_id: "",
      pcb_smtpad_id: `repro_obstacle_${i}`,
      layer: "top",
      shape: o.type === "oval" ? "circle" : "rect",
      x: o.center.x,
      y: o.center.y,
      width: o.type === "oval" ? (o as any).width : (o as any).width,
      height: (o as any).height,
    }) as any,
  )
  for (const conn of input.connections) {
    for (const [i, pt] of conn.pointsToConnect.entries()) {
      cj.push({
        type: "pcb_smtpad",
        pcb_component_id: "",
        pcb_smtpad_id: `repro_terminal_${conn.name}_${i}`,
        layer: "top",
        shape: "rect",
        x: pt.x,
        y: pt.y,
        width: 0.4,
        height: 0.4,
      } as any)
    }
  }
  cj.push({
    type: "pcb_board",
    pcb_component_id: "",
    center: {
      x: (input.bounds.minX + input.bounds.maxX) / 2,
      y: (input.bounds.minY + input.bounds.maxY) / 2,
    },
    width: input.bounds.maxX - input.bounds.minX,
    height: input.bounds.maxY - input.bounds.minY,
  } as any)
  return cj.concat(solution as any)
}

test("repro #92: multilayer ijump wild trace jump (overshoot past goal)", () => {
  const autorouter = new MultilayerIjump({
    input: input as any,
    isRemovePathLoopsEnabled: true,
    debug: true,
  })

  const solution = autorouter.solveAndMapToTraces() as any[]

  expect(solution).toHaveLength(2)

  const wildTrace = solution.find(
    (s) => s.pcb_trace_id === "pcb_trace_for_source_trace_20",
  )
  expect(wildTrace).toBeDefined()

  const wires = wildTrace.route.filter((p: any) => p.route_type === "wire")
  // The wild jump: the trace travels below y = -20 (past the goal row at
  // y = -17.55) before coming back. A non-wild route stays above -19.
  const minY = Math.min(...wires.map((p: any) => p.y))
  expect(minY).toBeLessThan(-20)

  // The wild route is > 1.5x longer than the best-known clean route
  // (12.81mm) for the same obstacle set.
  let length = 0
  for (let i = 0; i < wildTrace.route.length - 1; i++) {
    const a = wildTrace.route[i]
    const b = wildTrace.route[i + 1]
    if (a.route_type === "wire" && b.route_type === "wire") {
      length += Math.hypot(b.x - a.x, b.y - a.y)
    }
  }
  expect(length).toBeGreaterThan(12.81 * 1.5)

  // Snapshot the current (buggy) behavior. When #92 is fixed, the route
  // will change — update this snapshot intentionally.
  expect(
    convertCircuitJsonToPcbSvg(getCircuitJson(solution) as any),
  ).toMatchSvgSnapshot(import.meta.path)
})
