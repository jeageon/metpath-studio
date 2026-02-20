export type EdgeStatus = 'normal' | 'upregulated' | 'downregulated' | 'removed';

export interface PathwayNode {
  id: string;
  label: string;
  x: number;
  y: number;
  is_cofactor: boolean;
  raw_id?: string | null;
}

export interface PathwayEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  reaction_id?: string | null;
  reaction_name?: string | null;
  status: EdgeStatus;
  reversible: boolean;
  enzymes: string[];
  annotation: string;
}

export interface PathwayResponse {
  pathway_id: string;
  pathway_name: string;
  nodes: PathwayNode[];
  edges: PathwayEdge[];
  metadata: {
    cofactor_filter?: boolean;
    node_count?: number;
    edge_count?: number;
  };
}
