import { create } from "zustand";
import type { NodeRecord } from "@/types";

interface FleetState {
  nodes: NodeRecord[];
  selectedNodeId: string | null;
  setNodes: (nodes: NodeRecord[]) => void;
  upsertNode: (node: NodeRecord) => void;
  selectNode: (nodeId: string | null) => void;
}

function sortNodes(nodes: NodeRecord[]): NodeRecord[] {
  return [...nodes].sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "online") return -1;
      if (b.status === "online") return 1;
    }
    return a.id.localeCompare(b.id);
  });
}

export const useFleetStore = create<FleetState>((set) => ({
  nodes: [],
  selectedNodeId: null,
  setNodes: (nodes) =>
    set((state) => {
      const sorted = sortNodes(nodes);
      const stillExists =
        state.selectedNodeId && sorted.some((n) => n.id === state.selectedNodeId);
      return {
        nodes: sorted,
        selectedNodeId: stillExists ? state.selectedNodeId : (sorted[0]?.id ?? null)
      };
    }),
  upsertNode: (node) =>
    set((state) => {
      const idx = state.nodes.findIndex((n) => n.id === node.id);
      const next =
        idx >= 0
          ? state.nodes.map((n, i) => (i === idx ? node : n))
          : [...state.nodes, node];
      const sorted = sortNodes(next);
      return {
        nodes: sorted,
        selectedNodeId: state.selectedNodeId ?? sorted[0]?.id ?? null
      };
    }),
  selectNode: (nodeId) => set({ selectedNodeId: nodeId })
}));
