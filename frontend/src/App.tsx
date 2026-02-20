import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { Core, EdgeSingular, ElementDefinition } from 'cytoscape';

import { fetchPathway, importSbml } from './api';
import type { EdgeStatus, PathwayEdge, PathwayResponse } from './types';

interface EdgeLegend {
  normal: number;
  upregulated: number;
  downregulated: number;
  removed: number;
  cassette: number;
  overlay: number;
}

interface LegendConfig {
  label: string;
  color: string;
  width: number;
}

interface CsvOverlayRecord {
  id: string;
  value: number;
}

interface OverlaySummary {
  count: number;
  min: number;
  max: number;
}

const STATUS_LABELS: Record<EdgeStatus, LegendConfig> = {
  normal: { label: 'Normal', color: '#455a64', width: 3 },
  upregulated: { label: 'Upregulated', color: '#d32f2f', width: 6 },
  downregulated: { label: 'Downregulated', color: '#7b1fa2', width: 5 },
  removed: { label: 'Knock-out', color: '#78909c', width: 2 },
};

const CASSETTE_OFFSET = 20;
const KO_MARK_NODE_SUFFIX = '_ko_mark';
const CASSETTE_SUFFIX = '_cassette';
const ORTHOGONAL_STEP_BASE = 36;
const VERTICAL_FLOW_GAP = 88;

type EdgeRoutingMode = 'bezier' | 'orthogonal';

function routeOffsetForIndex(index: number): number {
  const normalized = index % 7;
  const jitter = ((normalized - 3) / 3) * 8;
  return ORTHOGONAL_STEP_BASE + jitter;
}

function emptyLegend(): EdgeLegend {
  return {
    normal: 0,
    upregulated: 0,
    downregulated: 0,
    removed: 0,
    cassette: 0,
    overlay: 0,
  };
}

function sanitizePathwayId(value: string): string {
  return value.trim();
}

function makeDisplayLabel(edge: PathwayEdge): string {
  const enzymeLabel = edge.enzymes.length > 0 ? `ENZ: ${edge.enzymes.join(', ')}` : '';
  const parts = [edge.label || 'reaction', enzymeLabel].filter(Boolean);
  return parts.join(' | ').trim();
}

function midpoint(pointA: { x: number; y: number }, pointB: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return {
    x: (pointA.x + pointB.x) / 2,
    y: (pointA.y + pointB.y) / 2,
  };
}

function perpendicularOffset(midpoint: { x: number; y: number }, source: { x: number; y: number }, target: { x: number; y: number }, offset: number): {
  x: number;
  y: number;
} {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  return {
    x: midpoint.x - ((dy / length) * offset),
    y: midpoint.y + ((dx / length) * offset),
  };
}

function toDisplayFromData(edge: EdgeSingular): string {
  const label = String(edge.data('base_label') || edge.data('label') || 'reaction');
  const annotation = String(edge.data('annotation') || '').trim();
  return `${label}${annotation ? ` | ${annotation}` : ''}`;
}

function parseCsvLine(rawLine: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < rawLine.length; i += 1) {
    const char = rawLine[i];
    if (char === '"') {
      if (inQuotes && rawLine[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  out.push(current.trim());
  return out.map((value) => (value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value));
}

function normalizeOverlayId(value: string): string {
  const compact = value.trim().toLowerCase();
  if (!compact) {
    return compact;
  }
  return compact.startsWith('rn:') ? compact.slice(3) : compact;
}

function parseCsvOverlay(fileText: string): CsvOverlayRecord[] {
  const lines = fileText
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const firstLine = parseCsvLine(lines[0] || '');
  const hasHeader =
    firstLine.some((col) => col.toLowerCase().includes('id')) &&
    firstLine.some((col) => col.toLowerCase().includes('value'));

  const startIndex = hasHeader ? 1 : 0;
  const idIndex = hasHeader ? firstLine.findIndex((col) => /id|reaction|gene/i.test(col)) : 0;
  const valueIndex = hasHeader ? firstLine.findIndex((col) => /log2|fold|value|flux|fc/i.test(col)) : 1;

  const rows = new Map<string, number>();
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = parseCsvLine(lines[i]);
    if (line.length === 0) {
      continue;
    }

    const rawId = normalizeOverlayId(line[idIndex] || '');
    const rawValue = parseFloat((line[valueIndex] || '').replace(/,/g, '').trim());
    if (!rawId || Number.isNaN(rawValue)) {
      continue;
    }

    rows.set(rawId, rawValue);
    const rnKey = normalizeOverlayId(`rn:${rawId}`);
    rows.set(rnKey, rawValue);
  }

  return [...rows].map(([id, value]) => ({ id, value }));
}

function overlayValueForEdge(edge: EdgeSingular, lookup: Map<string, number>): number | null {
  const candidates = new Set<string>();
  candidates.add(normalizeOverlayId(String(edge.data('reaction_id') || '')));
  candidates.add(normalizeOverlayId(String(edge.data('label') || '')));
  candidates.add(normalizeOverlayId(edge.id()));
  candidates.add(normalizeOverlayId(String(edge.data('base_label') || '')));
  candidates.add(`rn:${normalizeOverlayId(String(edge.data('reaction_id') || ''))}`);

  const rawLabel = String(edge.data('base_label') || '').toLowerCase();
  const labelTerms = rawLabel.split('|')[0].split(/[\s,]/).map((term) => term.trim()).filter(Boolean);
  labelTerms.forEach((term) => {
    candidates.add(normalizeOverlayId(term));
    candidates.add(`rn:${normalizeOverlayId(term)}`);
  });

  for (const candidate of candidates) {
    const value = lookup.get(candidate);
    if (value !== undefined) {
      return value;
    }
  }

  return null;
}

function gradientForValue(value: number, minValue: number, maxValue: number): string {
  if (minValue === maxValue) {
    return '#7f57e6';
  }

  const t = (value - minValue) / (maxValue - minValue);
  const clamped = Math.max(0, Math.min(1, t));
  const blue = { r: 45, g: 88, b: 165 };
  const red = { r: 211, g: 47, b: 47 };
  const r = Math.round(blue.r + (red.r - blue.r) * clamped);
  const g = Math.round(blue.g + (red.g - blue.g) * clamped);
  const b = Math.round(blue.b + (red.b - blue.b) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

function setEdgeLabel(edge: EdgeSingular): void {
  edge.data('display_label', toDisplayFromData(edge));
}

function applyOrthogonalRoutingForEdges(
  core: Core | null,
  edgeCollection: cytoscape.Collection,
  mode: EdgeRoutingMode,
): void {
  if (!core) {
    return;
  }

  edgeCollection.forEach((edge, index: number) => {
    if (mode === 'orthogonal') {
      edge.data('routing', 'orthogonal');
      edge.data('segment_offset', String(routeOffsetForIndex(index)));
    } else {
      edge.removeData('routing');
      edge.removeData('segment_offset');
    }
  });
  core.resize();
}

function refreshLegend(core: Core | null): EdgeLegend {
  const legend = emptyLegend();
  if (!core) {
    return legend;
  }

  const visibleEdges = core.edges().filter((edge) => !edge.hasClass('hidden'));
  visibleEdges.forEach((edge) => {
    const status = (edge.data('status') || 'normal') as EdgeStatus;
    if (status === 'upregulated') {
      legend.upregulated += 1;
    } else if (status === 'downregulated') {
      legend.downregulated += 1;
    } else if (status === 'removed') {
      legend.removed += 1;
    } else {
      legend.normal += 1;
    }

    const annotation = String(edge.data('annotation') || '').trim();
    if (annotation) {
      legend.cassette += 1;
    }

    if (String(edge.data('overlay_value') || '').trim()) {
      legend.overlay += 1;
    }
  });
  return legend;
}

function applyCsvOverlay(core: Core | null, fileText: string): OverlaySummary | null {
  if (!core) {
    return null;
  }

  const entries = parseCsvOverlay(fileText);
  if (entries.length === 0) {
    return null;
  }

  const lookup = new Map<string, number>();
  entries.forEach((entry) => {
    lookup.set(entry.id, entry.value);
  });

  const matched: { edge: EdgeSingular; value: number }[] = [];

  core.edges().forEach((edge) => {
    edge.removeData('overlay_value');
    edge.removeData('overlay_color');
    edge.removeData('overlay_width');

    const value = overlayValueForEdge(edge, lookup);
    if (value === null) {
      return;
    }
    matched.push({ edge, value });
  });

  if (matched.length === 0) {
    return { count: 0, min: 0, max: 0 };
  }

  const values = matched.map((item) => item.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  matched.forEach(({ edge, value }) => {
    const width = 2 + ((value - minValue) / (maxValue - minValue || 1)) * 8;
    edge.data('overlay_value', String(value));
    edge.data('overlay_color', gradientForValue(value, minValue, maxValue));
    edge.data('overlay_width', width.toFixed(2));
  });

  return {
    count: matched.length,
    min: minValue,
    max: maxValue,
  };
}

function refreshDecorators(core: Core | null): void {
  if (!core) {
    return;
  }

  core.edges().forEach((edge) => {
    const source = edge.source();
    const target = edge.target();
    const sourcePos = source.position();
    const targetPos = target.position();
    const center = midpoint(sourcePos, targetPos);
    const status = String(edge.data('status') || 'normal');
    const annotation = String(edge.data('annotation') || '').trim();
    const sourceHidden = source.hasClass('hidden');
    const targetHidden = target.hasClass('hidden');
    const edgeHidden = edge.hasClass('hidden');
    const commonHidden = edgeHidden || sourceHidden || targetHidden;

    const cassetteNode = core.getElementById(`${edge.id()}${CASSETTE_SUFFIX}`);
    if (cassetteNode.length > 0) {
      const hasAnnotation = annotation.length > 0;
      cassetteNode.toggleClass('hidden', commonHidden || !hasAnnotation);
      cassetteNode.data('label', annotation || 'cassette');
      if (!commonHidden && hasAnnotation) {
        cassetteNode.position(perpendicularOffset(center, sourcePos, targetPos, CASSETTE_OFFSET));
      }
    }

    const koNode = core.getElementById(`${edge.id()}${KO_MARK_NODE_SUFFIX}`);
    if (koNode.length > 0) {
      const isRemoved = status === 'removed';
      koNode.toggleClass('hidden', commonHidden || !isRemoved);
      if (!commonHidden && isRemoved) {
        koNode.position(center);
      }
    }
  });
}

function alignSelectedNodesToTcaRing(core: Core): void {
  const selected = core.nodes('node[type="metabolite"].selected');
  if (selected.empty()) {
    return;
  }

  const nodes = selected.toArray();
  const count = nodes.length;
  const avgX = nodes.reduce((acc, node) => acc + node.position('x'), 0) / count;
  const avgY = nodes.reduce((acc, node) => acc + node.position('y'), 0) / count;
  const radius = Math.max(90, Math.sqrt(count) * 92);

  nodes.forEach((node, index) => {
    const theta = (Math.PI * 2 * index) / count - Math.PI / 2;
    node.position({
      x: avgX + radius * Math.cos(theta),
      y: avgY + radius * Math.sin(theta),
    });
  });
}

function alignSelectedNodesToGlycolysisFlow(core: Core): void {
  const selected = core.nodes('node[type="metabolite"].selected');
  if (selected.empty()) {
    return;
  }

  const nodes = selected
    .toArray()
    .sort((lhs, rhs) => lhs.position('x') - rhs.position('x'));

  const startY = Math.min(...nodes.map((node) => node.position('y')));
  const centerX = nodes.reduce((acc, node) => acc + node.position('x'), 0) / nodes.length;

  nodes.forEach((node, index) => {
    node.position({
      x: centerX,
      y: startY + index * VERTICAL_FLOW_GAP,
    });
  });
}

export default function App(): JSX.Element {
  const [pathwayIdInput, setPathwayIdInput] = useState('eco00670');
  const [pathway, setPathway] = useState<PathwayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [edgeAnnotation, setEdgeAnnotation] = useState('');
  const [hideCofactors, setHideCofactors] = useState(false);
  const [curveValue, setCurveValue] = useState(20);
  const [legendCounts, setLegendCounts] = useState<EdgeLegend>(emptyLegend());
  const [routingMode, setRoutingMode] = useState<EdgeRoutingMode>('bezier');
  const [overlaySummary, setOverlaySummary] = useState<OverlaySummary | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const csvUploadRef = useRef<HTMLInputElement | null>(null);
  const sbmlUploadRef = useRef<HTMLInputElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  const elements = useMemo((): ElementDefinition[] => {
    if (!pathway) {
      return [];
    }

    const out: ElementDefinition[] = [];
    pathway.nodes.forEach((node) => {
      out.push({
        group: 'nodes',
        data: {
          id: node.id,
          label: node.label,
          type: 'metabolite',
          is_cofactor: String(node.is_cofactor),
        },
        position: { x: node.x, y: node.y },
      });
    });

    pathway.edges.forEach((edge) => {
      const status: EdgeStatus = edge.status || 'normal';
      const annotation = edge.annotation || '';
      const edgeId = edge.id;
      out.push({
        group: 'edges',
        data: {
          id: edgeId,
          source: edge.source,
          target: edge.target,
          status,
          label: edge.label || 'reaction',
          base_label: makeDisplayLabel(edge),
          display_label: makeDisplayLabel(edge),
          annotation,
          reaction_id: edge.reaction_id || '',
        },
      });

      out.push({
        group: 'nodes',
        data: {
          id: `${edgeId}${CASSETTE_SUFFIX}`,
          label: annotation,
          type: 'cassette',
          parent_edge: edgeId,
          annotation,
          is_cofactor: 'false',
        },
        position: { x: 0, y: 0 },
        selectable: false,
        grabbable: false,
        classes: 'decorator',
      } as ElementDefinition);

      out.push({
        group: 'nodes',
        data: {
          id: `${edgeId}${KO_MARK_NODE_SUFFIX}`,
          label: '✕',
          type: 'ko_mark',
          parent_edge: edgeId,
          is_cofactor: 'false',
        },
        position: { x: 0, y: 0 },
        selectable: false,
        grabbable: false,
        classes: 'decorator',
      } as ElementDefinition);
    });

    return out;
  }, [pathway]);

  useEffect(() => {
    if (!containerRef.current || elements.length === 0) {
      return;
    }

    const core = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            color: '#0d1f3a',
            'font-size': 9,
          },
        },
        {
          selector: 'node[type = "metabolite"]',
          style: {
            width: 34,
            height: 34,
            'background-color': '#eef7ff',
            'background-opacity': 1,
            'border-color': '#283593',
            'border-width': 2,
            shape: 'ellipse',
            'text-wrap': 'wrap',
            'text-max-width': 58,
            'text-justification': 'center',
            'text-valign': 'center',
            'text-halign': 'center',
          },
        },
        {
          selector: 'node[type = "metabolite"][is_cofactor = "true"]',
          style: {
            'background-color': '#f3f9e5',
            'border-style': 'dashed',
          },
        },
        {
          selector: 'node[type = "cassette"]',
          style: {
            width: 96,
            height: 28,
            shape: 'round-rectangle',
            'background-color': '#fff8e1',
            'border-color': '#ffa000',
            'border-width': 2,
            'border-style': 'solid',
            color: '#4e342e',
            'font-size': 10,
            'font-weight': '600',
            'text-wrap': 'wrap',
            'text-max-width': 86,
            'text-justification': 'center',
            'text-valign': 'center',
            'text-halign': 'center',
            'text-background-color': '#fffbf0',
            'text-background-opacity': 0.96,
            'text-background-padding': 3,
            'events': 'no',
            'z-index': 2,
          },
        },
        {
          selector: 'node[type = "ko_mark"]',
          style: {
            width: 18,
            height: 18,
            shape: 'round-rectangle',
            'background-color': '#eceff1',
            'border-color': '#607d8b',
            'border-width': 2,
            color: '#546e7a',
            'font-size': 12,
            'font-weight': '700',
            'text-valign': 'center',
            'text-halign': 'center',
            'events': 'no',
            'z-index': 2,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 3,
            'curve-style': 'bezier',
            'line-color': STATUS_LABELS.normal.color,
            'target-arrow-color': STATUS_LABELS.normal.color,
            'target-arrow-shape': 'triangle',
            'source-arrow-color': STATUS_LABELS.normal.color,
            'source-arrow-shape': 'none',
            'label': 'data(display_label)',
            'font-size': 9,
            color: '#223',
            'text-background-color': '#fff',
            'text-background-opacity': 0.85,
            'text-background-padding': 2,
            'text-wrap': 'wrap',
            'text-max-width': 140,
            'text-margin-y': -10,
            'text-rotation': 'autorotate',
            'arrow-scale': 0.9,
          },
        },
        {
          selector: 'edge[status = "upregulated"]',
          style: {
            'line-color': STATUS_LABELS.upregulated.color,
            'target-arrow-color': STATUS_LABELS.upregulated.color,
            width: STATUS_LABELS.upregulated.width,
          },
        },
        {
          selector: 'edge[status = "downregulated"]',
          style: {
            'line-color': STATUS_LABELS.downregulated.color,
            'target-arrow-color': STATUS_LABELS.downregulated.color,
            'line-style': 'dashed',
            width: STATUS_LABELS.downregulated.width,
          },
        },
        {
          selector: 'edge[status = "removed"]',
          style: {
            'line-color': STATUS_LABELS.removed.color,
            'target-arrow-color': STATUS_LABELS.removed.color,
            width: STATUS_LABELS.removed.width,
            'line-style': 'dashed',
            opacity: 0.8,
          },
        },
        {
          selector: 'edge[overlay_value]',
          style: {
            'line-color': 'data(overlay_color)',
            'target-arrow-color': 'data(overlay_color)',
            width: 'data(overlay_width)',
          },
        },
        {
          selector: '.hidden',
          style: { display: 'none' },
        },
        {
          selector: '.decorator',
          style: {
            'z-index': 20,
          },
        },
        {
          selector: 'edge[routing = "orthogonal"]',
          style: {
            'curve-style': 'segments',
            'segment-weights': 0.5,
            'segment-distances': 'data(segment_offset)',
          },
        },
        {
          selector: 'node:selected, edge:selected',
          style: { 'overlay-opacity': 0.18, 'overlay-color': '#2962ff' },
        },
      ],
      layout: { name: 'preset', padding: 10 },
      zoom: 1,
      minZoom: 0.15,
      maxZoom: 4,
      boxSelectionEnabled: true,
      userPanningEnabled: true,
      userZoomingEnabled: true,
      wheelSensitivity: 0.12,
    });

    core.on('select unselect', () => {
      const selectedEdges = core.$('edge:selected');
      setSelectedEdgeIds(selectedEdges.map((_, edge) => edge.id()));
      if (selectedEdges.length === 1) {
        setEdgeAnnotation(String(selectedEdges[0].data('annotation') || ''));
      } else {
        setEdgeAnnotation('');
      }
      setLegendCounts(refreshLegend(core));
    });

    core.on('free', 'node', () => {
      applyOrthogonalRoutingForEdges(core, core.edges(), routingMode);
      refreshDecorators(core);
      core.fit(core.elements().not('.hidden'), 40);
    });

    core.edges().forEach((edge) => {
      setEdgeLabel(edge);
      edge.style('control-point-step-size', curveValue);
    });

    cyRef.current = core;
    applyOrthogonalRoutingForEdges(core, core.edges(), routingMode);
    refreshDecorators(core);
    setLegendCounts(refreshLegend(core));
    core.fit(core.elements().not('.hidden'), 30);

    return () => {
      if (cyRef.current === core) {
        cyRef.current = null;
      }
      core.destroy();
    };
  }, [elements]);

  useEffect(() => {
    const core = cyRef.current;
    if (!core) {
      return;
    }
    core.nodes().forEach((node) => {
      if (node.data('is_cofactor') === 'true') {
        node.toggleClass('hidden', hideCofactors);
      }
    });

    core.edges().forEach((edge) => {
      const sourceHidden = edge.source().hasClass('hidden');
      const targetHidden = edge.target().hasClass('hidden');
      edge.toggleClass('hidden', hideCofactors && (sourceHidden || targetHidden));
    });

    refreshDecorators(core);
    setLegendCounts(refreshLegend(core));
    if (hideCofactors) {
      core.fit(core.elements().not('.hidden'), 40);
    }
  }, [hideCofactors]);

  useEffect(() => {
    const core = cyRef.current;
    if (!core) {
      return;
    }
    applyOrthogonalRoutingForEdges(core, core.edges(), routingMode);
    refreshDecorators(core);
  }, [routingMode]);

  const onLoadPathway = async () => {
    const id = sanitizePathwayId(pathwayIdInput);
    if (!id) {
      setError('Pathway ID를 입력해주세요.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await fetchPathway(id, false);
      setPathway(result);
      setHideCofactors(false);
      setCurveValue(20);
      setRoutingMode('bezier');
      setOverlaySummary(null);
      setEdgeAnnotation('');
      setSelectedEdgeIds([]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '경로를 불러오지 못했습니다.');
      setPathway(null);
      setLegendCounts(emptyLegend());
    } finally {
      setLoading(false);
    }
  };

  const onLoadSbml = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    event.target.value = '';
    setLoading(true);
    setError('');
    try {
      const result = await importSbml(file);
      setPathway(result);
      setHideCofactors(false);
      setCurveValue(20);
      setRoutingMode('bezier');
      setOverlaySummary(null);
      setEdgeAnnotation('');
      setSelectedEdgeIds([]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'SBML 파일을 불러오지 못했습니다.');
      setPathway(null);
      setLegendCounts(emptyLegend());
      setOverlaySummary(null);
    } finally {
      setLoading(false);
    }
  };

  const onUploadCsv = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    event.target.value = '';
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const core = cyRef.current;
      if (!core) {
        setError('그래프가 로드되지 않았습니다.');
        return;
      }
      const summary = applyCsvOverlay(core, text);
      setLegendCounts(refreshLegend(core));
      refreshDecorators(core);
      if (!summary || summary.count === 0) {
        setOverlaySummary(summary);
        setError('매칭되는 반응 ID가 없어 오버레이가 적용되지 않았습니다.');
      } else {
        setOverlaySummary(summary);
        setError('');
      }
    };
    reader.onerror = () => {
      setError('CSV 파일을 읽을 수 없습니다.');
    };
    reader.readAsText(file, 'utf-8');
  };

  const onClearOverlay = () => {
    const core = cyRef.current;
    if (!core) {
      return;
    }
    core.edges().forEach((edge) => {
      edge.removeData('overlay_value');
      edge.removeData('overlay_color');
      edge.removeData('overlay_width');
    });
    setOverlaySummary(null);
    setLegendCounts(refreshLegend(core));
    refreshDecorators(core);
  };

  const onDeleteSelection = () => {
    const core = cyRef.current;
    if (!core) return;

    const selectedEdges = core.$('edge:selected');
    if (selectedEdges.empty()) {
      return;
    }

    selectedEdges.forEach((edge) => {
      core.getElementById(`${edge.id()}${CASSETTE_SUFFIX}`).remove();
      core.getElementById(`${edge.id()}${KO_MARK_NODE_SUFFIX}`).remove();
    });

    selectedEdges.remove();

    setLegendCounts(refreshLegend(core));
    setSelectedEdgeIds([]);
    setEdgeAnnotation('');
  };

  const applyEdgeStatus = (status: EdgeStatus) => {
    const core = cyRef.current;
    if (!core) return;
    const selected = core.$('edge:selected');
    if (selected.empty()) return;

    selected.forEach((edge) => {
      edge.data('status', status);
      setEdgeLabel(edge);
    });
    refreshDecorators(core);
    setLegendCounts(refreshLegend(core));
  };

  const applyCurve = (value: number) => {
    const core = cyRef.current;
    if (!core) return;
    setCurveValue(value);
    core.$('edge:selected').forEach((edge) => {
      edge.style('control-point-step-size', value);
    });
    refreshDecorators(core);
  };

  const applyTcaRing = () => {
    const core = cyRef.current;
    if (!core) {
      return;
    }
    alignSelectedNodesToTcaRing(core);
    if (routingMode === 'orthogonal') {
      applyOrthogonalRoutingForEdges(core, core.edges(), routingMode);
    }
    refreshDecorators(core);
    core.fit(core.elements().not('.hidden'), 30);
  };

  const applyGlycolysisFlow = () => {
    const core = cyRef.current;
    if (!core) {
      return;
    }
    alignSelectedNodesToGlycolysisFlow(core);
    if (routingMode === 'orthogonal') {
      applyOrthogonalRoutingForEdges(core, core.edges(), routingMode);
    }
    refreshDecorators(core);
    core.fit(core.elements().not('.hidden'), 30);
  };

  const saveAnnotation = (text: string) => {
    if (selectedEdgeIds.length !== 1) return;
    const core = cyRef.current;
    if (!core) return;

    setEdgeAnnotation(text);
    core.$('edge:selected').forEach((edge) => {
      edge.data('annotation', text);
      setEdgeLabel(edge);
    });
    refreshDecorators(core);
    setLegendCounts(refreshLegend(core));
  };

  const exportSvg = async () => {
    const core = cyRef.current;
    if (!core) return;
    const asSvg = (core as any).svg;
    if (typeof asSvg === 'function') {
      const svg = asSvg.call(core, { full: true, scale: 2, bg: '#fff' });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${pathway?.pathway_id || 'pathway'}_${Date.now()}.svg`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    const png = core.png({ full: true, bg: '#fff', scale: 2, quality: 1 });
    const link = document.createElement('a');
    link.href = png;
    link.download = `${pathway?.pathway_id || 'pathway'}_${Date.now()}.png`;
    link.click();
  };

  return (
    <div className="app-root">
      <header className="hero">
        <h1>MetPath Studio</h1>
        <p>KEGG pathway → 논문 스타일 대사 지도 편집기</p>
      </header>

      <section className="control-panel">
        <div className="control-row">
          <input
            value={pathwayIdInput}
            onChange={(event) => setPathwayIdInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onLoadPathway();
              }
            }}
            placeholder="Pathway ID (ex: eco00670)"
          />
          <button onClick={onLoadPathway} disabled={loading}>
            {loading ? '불러오는 중...' : 'Load KEGG'}
          </button>
          <input
            ref={sbmlUploadRef}
            type="file"
            accept=".sbml,.xml,application/xml,text/xml"
            className="file-input"
            onChange={onLoadSbml}
          />
          <button onClick={() => sbmlUploadRef.current?.click()}>
            SBML 임포트
          </button>
          <button onClick={onDeleteSelection} className="warn">
            선택 항목 삭제
          </button>
          <button
            onClick={() => {
              setHideCofactors(!hideCofactors);
            }}
          >
            {hideCofactors ? '조효소 숨김 취소' : '조효소 일괄 숨기기'}
          </button>
        </div>

        <div className="control-row">
            <button onClick={() => applyEdgeStatus('upregulated')}>Upregulated</button>
            <button onClick={() => applyEdgeStatus('downregulated')}>Downregulated</button>
            <button onClick={() => applyEdgeStatus('removed')}>Knock-out</button>
            <label className="slider">
              Bézier 곡률
            <input
              type="range"
              min={0}
              max={90}
              value={curveValue}
              onChange={(event) => applyCurve(Number(event.target.value))}
            />
          </label>
          <label className="annotation">
            라우팅
            <button
              className={routingMode === 'bezier' ? 'active' : ''}
              onClick={() => setRoutingMode('bezier')}
            >
              Bezier
            </button>
            <button
              className={routingMode === 'orthogonal' ? 'active' : ''}
              onClick={() => setRoutingMode('orthogonal')}
            >
              Orthogonal
            </button>
          </label>
        </div>

        <div className="control-row">
          <button onClick={applyTcaRing}>TCA Ring 정렬</button>
          <button onClick={applyGlycolysisFlow}>Glycolysis 수직 정렬</button>
          <input
            ref={csvUploadRef}
            type="file"
            accept=".csv,text/csv"
            className="file-input"
            onChange={onUploadCsv}
          />
          <button onClick={() => csvUploadRef.current?.click()}>
            CSV 오버레이 업로드
          </button>
          <button onClick={onClearOverlay} className="warn">
            오버레이 초기화
          </button>
          <label className="annotation">
            카세트 텍스트 박스
            <input
              value={edgeAnnotation}
              onChange={(event) => saveAnnotation(event.target.value)}
              placeholder="예: Ptuf, Psod"
              disabled={selectedEdgeIds.length !== 1}
            />
          </label>
        </div>

        <div className="control-row footer-actions">
          <button onClick={exportSvg}>SVG Export</button>
          <span className="selection-pill">
            선택 엣지: {selectedEdgeIds.length}
          </span>
          <span className="selection-pill">
            상태: {pathway ? `${pathway.pathway_name}` : '미선택'}
          </span>
        </div>
      </section>

      <section className="canvas-wrap">
        <div className="cy-wrapper">
          <div className="cofactor-hint">
            {hideCofactors
              ? '숨김 상태: 조효소/일반 보조인자 노드 숨김 적용'
              : '표시 상태: 전체 노드 노출'}
          </div>
          <div ref={containerRef} className="canvas"></div>
        </div>

        <aside className="legend">
          <h2>Legend</h2>
          <ul>
            {(Object.keys(STATUS_LABELS) as EdgeStatus[]).map((status) => (
              <li key={status}>
                <span
                  style={{
                    width: STATUS_LABELS[status].width,
                    background: STATUS_LABELS[status].color,
                  }}
                />
                {STATUS_LABELS[status].label}: {legendCounts[status]}
              </li>
            ))}
            <li>
              <span style={{ width: 10, background: '#ffb74d' }} />
              Cassette box: {legendCounts.cassette}
            </li>
            <li>
              <span style={{ width: 10, background: '#607d8b' }} />
              KO mark(✕): {legendCounts.removed}
            </li>
            <li>
              <span style={{ width: 10, background: '#7f57e6' }} />
              CSV Overlay: {overlaySummary ? `${overlaySummary.count}개` : '0개'}
              {overlaySummary && overlaySummary.count > 0
                ? ` (min=${overlaySummary.min.toFixed(3)}, max=${overlaySummary.max.toFixed(3)})`
                : ''}
            </li>
          </ul>
          <p>선택 엣지 다중선택 가능, 드래그로 레이아웃 수정</p>
          <p>반응 라벨은 자동 반영되며, 카세트/KO 표기는 엣지 양쪽 위치에 스냅됩니다.</p>
        </aside>
      </section>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
