from __future__ import annotations

import re
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from math import cos, pi, sin
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from .models import MetaboliteNode, PathwayResponse, ReactionEdge


KNOWN_COFACTOR_IDS = {
    "C00002": "ATP",
    "C00008": "ADP",
    "C00020": "AMP",
    "C00003": "NAD+",
    "C00004": "NADH",
    "C00005": "NADPH",
    "C00006": "NADP+",
    "C00007": "FAD",
    "C00001": "H2O",
    "C00009": "Phosphate",
}

COFACTOR_KEYWORDS = {
    "atp",
    "adp",
    "amp",
    "nad",
    "nadh",
    "nadph",
    "nadp",
    "fad",
    "coa",
    "co-a",
    "coa",
    "coenzyme",
    "h2o",
    "pi",
    "phosphate",
}


def _normalize_label(raw: str, fallback: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return fallback
    first = raw.split("\n")[0].strip()
    first = first.split("...")[0].strip()
    if first.startswith("cpd:"):
        return first.split(":", 1)[1]
    if first.startswith("ko:") or first.startswith("eco:") or first.startswith("rn:"):
        parts = first.split(" ", 1)
        first = parts[0]
        if ":" in first:
            return first.split(":", 1)[1]
    return first


def _parse_float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _local_tag_name(tag: str) -> str:
    return tag.split("}", 1)[-1] if tag.startswith("{") else tag


def _iter_local_elements(root: ET.Element, tag_name: str) -> List[ET.Element]:
    return [node for node in root.iter() if _local_tag_name(node.tag) == tag_name]


def _is_cofactor(node_id: str, label: str) -> bool:
    candidate_id = (node_id or "").strip()
    normalized_id = ""

    if candidate_id:
        first_token = candidate_id.split()[0]
        normalized_id = first_token.replace("cpd:", "").upper()

    label_l = (label or "").lower()
    if normalized_id in KNOWN_COFACTOR_IDS:
        return True
    if normalized_id.lower() in COFACTOR_KEYWORDS:
        return True
    if any(k in label_l for k in COFACTOR_KEYWORDS):
        return True
    return False


def fetch_kgml(pathway_id: str) -> str:
    url = f"https://rest.kegg.jp/get/{pathway_id}/kgml"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            if response.status != 200:
                raise ValueError(f"KEGG API returned status {response.status}")
            return response.read().decode("utf-8")
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch KGML for {pathway_id}: {exc}") from exc


def _collect_entry_data(root: ET.Element) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str], Dict[str, str]]:
    entries_by_id: Dict[str, Dict[str, Any]] = {}
    reaction_lookup: Dict[str, List[str]] = {}
    type_lookup: Dict[str, str] = {}

    for entry in root.findall("entry"):
        entry_id = entry.attrib.get("id")
        if not entry_id:
            continue

        entry_type = entry.attrib.get("type", "unknown")
        name_attr = entry.attrib.get("name", "")
        graphics = entry.find("graphics")
        graphics_label = graphics.attrib.get("name") if graphics is not None else None

        raw_label = _normalize_label(graphics_label or name_attr, fallback=entry_id)
        x = _parse_float((graphics.attrib.get("x") if graphics is not None else entry.attrib.get("x", "0")) or "0")
        y = _parse_float((graphics.attrib.get("y") if graphics is not None else entry.attrib.get("y", "0")) or "0")

        reaction_attr = (entry.attrib.get("reaction") or "").strip()
        reaction_ids: Set[str] = set(
            token[3:]
            for token in reaction_attr.split()
            if token.startswith("rn:")
        )
        reaction_ids.update(r for r in reaction_attr.split() if r.startswith("R"))

        entries_by_id[entry_id] = {
            "id": entry_id,
            "type": entry_type,
            "name": name_attr,
            "label": raw_label,
            "x": x,
            "y": y,
            "reaction_ids": reaction_ids,
            "reaction_name": reaction_attr,
        }
        type_lookup[entry_id] = entry_type

    for entry_id, data in entries_by_id.items():
        for reaction_id in data["reaction_ids"]:
            reaction_lookup.setdefault(reaction_id, []).append(entry_id)

    return entries_by_id, reaction_lookup, type_lookup


def _normalize_coordinates(nodes: Dict[str, Dict[str, Any]], viewport=(1200, 900), padding: int = 80) -> None:
    xs = [n["x"] for n in nodes.values()]
    ys = [n["y"] for n in nodes.values()]

    if not xs or not ys:
        return

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    width, height = viewport
    range_x = max(max_x - min_x, 1.0)
    range_y = max(max_y - min_y, 1.0)
    scale_x = (width - 2 * padding) / range_x
    scale_y = (height - 2 * padding) / range_y
    scale = min(scale_x, scale_y, 5.0)

    for node in nodes.values():
        node["x"] = (node["x"] - min_x) * scale + padding
        node["y"] = (node["y"] - min_y) * scale + padding


def _reaction_display_label(reaction_name: str, reaction_id: str) -> str:
    if reaction_name:
        rn_terms = [r for r in reaction_name.split() if r.startswith("rn:")]
        if rn_terms:
            return ", ".join(rn_terms)
    return reaction_id


def _extract_enzyme_labels(
    reaction_id: str,
    reaction_ids: Sequence[str],
    reaction_to_entries: Dict[str, List[str]],
    entries_by_id: Dict[str, Dict[str, Any]],
) -> List[str]:
    enzyme_entries: List[str] = []
    seen: Set[str] = set()

    # Direct entry id mapping.
    if reaction_id and reaction_id in entries_by_id:
        if reaction_id not in seen:
            enzyme_entries.append(reaction_id)
            seen.add(reaction_id)

    # Match explicit rn: IDs in gene/ortholog entries.
    for rid in reaction_ids:
        for entry_id in reaction_to_entries.get(rid, []):
            if entry_id in seen:
                continue
            enzyme_entries.append(entry_id)
            seen.add(entry_id)

    labels: List[str] = []
    for entry_id in enzyme_entries:
        data = entries_by_id.get(entry_id)
        if not data:
            continue
        label = data["label"]
        if label and label not in labels and len(label) < 32:
            labels.append(label)

    return labels[:4]


def _reaction_edge_id(reaction_id: str, source: str, target: str) -> str:
    safe_reaction = re.sub(r"[^a-zA-Z0-9_\\-]", "_", str(reaction_id))
    return f"{safe_reaction}:{source}->{target}"


@dataclass
class KGMLParseResult:
    pathway_id: str
    pathway_name: str
    nodes: List[MetaboliteNode]
    edges: List[ReactionEdge]


def translate_kgml_to_graph(xml_text: str, hide_cofactors: bool = False) -> KGMLParseResult:
    root = ET.fromstring(xml_text)

    pathway_id = root.attrib.get("name", "unknown")
    pathway_name = root.attrib.get("title", "KEGG pathway")

    entries_by_id, reaction_to_entries, type_lookup = _collect_entry_data(root)

    compound_nodes = {
        entry_id: data
        for entry_id, data in entries_by_id.items()
        if data["type"] == "compound"
    }

    _normalize_coordinates(compound_nodes)

    nodes: List[MetaboliteNode] = []
    for entry_id, data in compound_nodes.items():
        is_cofactor = _is_cofactor(data["name"], data["label"])
        if hide_cofactors and is_cofactor:
            continue
        nodes.append(
            MetaboliteNode(
                id=data["id"],
                label=data["label"],
                x=data["x"],
                y=data["y"],
                is_cofactor=is_cofactor,
                raw_id=data["name"],
                metadata={
                    "original_type": data["type"],
                    "entry_name": data["name"],
                },
            )
        )

    node_ids = {node.id for node in nodes}
    edges: List[ReactionEdge] = []

    seen_edges: Set[Tuple[str, str, str]] = set()
    for reaction in root.findall("reaction"):
        reaction_id = reaction.attrib.get("id", "")
        reaction_name = reaction.attrib.get("name", "")
        reversible = reaction.attrib.get("type", "irreversible") == "reversible"

        substrates = [s.attrib.get("id") for s in reaction.findall("substrate") if s.attrib.get("id")]
        products = [p.attrib.get("id") for p in reaction.findall("product") if p.attrib.get("id")]

        if not substrates or not products:
            continue

        rn_ids = [tok.strip() for tok in reaction_name.split() if tok.startswith("rn:")]
        if not rn_ids:
            rn_ids = [reaction_id] if reaction_id else []

        enzymes = _extract_enzyme_labels(
            reaction_id,
            rn_ids,
            reaction_to_entries,
            entries_by_id,
        )

        for source in substrates:
            for target in products:
                if source not in node_ids or target not in node_ids:
                    continue
                key = (reaction_id, source, target)
                if key in seen_edges:
                    continue
                seen_edges.add(key)
                edges.append(
                    ReactionEdge(
                        id=_reaction_edge_id(reaction_id or reaction_name, source, target),
                        source=source,
                        target=target,
                        label=_reaction_display_label(reaction_name, reaction_id),
                        reaction_id=reaction_id,
                        reaction_name=reaction_name,
                        reversible=reversible,
                        enzymes=enzymes,
                        metadata={
                            "source_type": type_lookup.get(source, ""),
                            "target_type": type_lookup.get(target, ""),
                            "kgml_type": "reaction",
                        },
                    )
                )
                if reversible:
                    reverse_key = (reaction_id, target, source)
                    if reverse_key not in seen_edges:
                        seen_edges.add(reverse_key)
                        edges.append(
                            ReactionEdge(
                                id=_reaction_edge_id(f"{reaction_id}_rev", target, source),
                                source=target,
                                target=source,
                                label=_reaction_display_label(reaction_name, reaction_id),
                                reaction_id=reaction_id,
                                reaction_name=reaction_name,
                                reversible=True,
                                enzymes=enzymes,
                                metadata={
                                    "source_type": type_lookup.get(target, ""),
                                    "target_type": type_lookup.get(source, ""),
                                    "kgml_type": "reaction_reversible_partner",
                                },
                            )
                        )

    if hide_cofactors:
        nodes = [n for n in nodes if not n.is_cofactor]
        valid_ids = {n.id for n in nodes}
        edges = [e for e in edges if e.source in valid_ids and e.target in valid_ids]

    return KGMLParseResult(
        pathway_id=pathway_id.replace("path:", ""),
        pathway_name=pathway_name,
        nodes=nodes,
        edges=edges,
    )


def build_metabolic_graph(pathway_id: str, hide_cofactors: bool = False) -> PathwayResponse:
    xml_text = fetch_kgml(pathway_id)
    result = translate_kgml_to_graph(xml_text, hide_cofactors=hide_cofactors)
    return PathwayResponse(
        pathway_id=result.pathway_id,
        pathway_name=result.pathway_name,
        nodes=result.nodes,
        edges=result.edges,
        metadata={
            "cofactor_filter": hide_cofactors,
            "node_count": len(result.nodes),
            "edge_count": len(result.edges),
        },
    )


def build_metabolic_graph_from_sbml(sbml_text: bytes) -> PathwayResponse:
    try:
        root = ET.fromstring(sbml_text)
    except Exception as exc:
        raise RuntimeError(f"Invalid SBML file: {exc}") from exc

    species_nodes: Dict[str, Dict[str, str]] = {}
    for species in _iter_local_elements(root, "species"):
        species_id = species.attrib.get("id") or species.attrib.get("name")
        if not species_id:
            continue
        if species_id in species_nodes:
            continue
        species_nodes[species_id] = {
            "id": species_id,
            "label": species.attrib.get("name", species_id),
        }

    if not species_nodes:
        raise RuntimeError("No species found in SBML model")

    node_ids = list(species_nodes.keys())
    node_count = len(node_ids)
    angle_step = 2 * pi / max(node_count, 1)
    radius = min(560, max(170, node_count * 28))
    center_x = 640
    center_y = 420
    nodes: List[MetaboliteNode] = []
    for index, species_id in enumerate(node_ids):
        angle = angle_step * index
        nodes.append(
            MetaboliteNode(
                id=species_nodes[species_id]["id"],
                label=species_nodes[species_id]["label"],
                x=center_x + radius * cos(angle),
                y=center_y + radius * sin(angle),
                is_cofactor=False,
                raw_id=species_id,
                metadata={"original_type": "sbml_species"},
            )
        )

    edges: List[ReactionEdge] = []
    seen_edges: Set[Tuple[str, str, str]] = set()
    for reaction in _iter_local_elements(root, "reaction"):
        reaction_id = reaction.attrib.get("id") or reaction.attrib.get("name") or "reaction"
        reaction_name = reaction.attrib.get("name", reaction_id)
        reversible = reaction.attrib.get("reversible", "false").lower() in {"true", "1", "yes"}
        substrates: List[str] = []
        products: List[str] = []

        for child in list(reaction):
            if _local_tag_name(child.tag) == "listOfReactants":
                for ref in list(child):
                    if _local_tag_name(ref.tag) == "speciesReference":
                        species_ref = ref.attrib.get("species")
                        if species_ref:
                            substrates.append(species_ref)
            elif _local_tag_name(child.tag) == "listOfProducts":
                for ref in list(child):
                    if _local_tag_name(ref.tag) == "speciesReference":
                        species_ref = ref.attrib.get("species")
                        if species_ref:
                            products.append(species_ref)

        if not substrates or not products:
            continue

        for substrate in substrates:
            for product in products:
                if substrate not in species_nodes or product not in species_nodes:
                    continue
                if substrate == product:
                    continue
                edge_key = (reaction_id, substrate, product)
                if edge_key in seen_edges:
                    continue
                seen_edges.add(edge_key)
                edges.append(
                    ReactionEdge(
                        id=f"{reaction_id}:{substrate}->{product}",
                        source=substrate,
                        target=product,
                        label=_reaction_display_label(reaction_name, reaction_id),
                        reaction_id=reaction_id,
                        reaction_name=reaction_name,
                        reversible=reversible,
                        enzymes=[],
                        status="normal",
                        annotation="",
                        metadata={"kgml_type": "sbml_reaction", "source_id": reaction_id},
                    )
                )
                if reversible:
                    reverse_key = (f"{reaction_id}_rev", product, substrate)
                    if reverse_key in seen_edges:
                        continue
                    seen_edges.add(reverse_key)
                    edges.append(
                        ReactionEdge(
                            id=f"{reaction_id}_rev:{product}->{substrate}",
                            source=product,
                            target=substrate,
                            label=_reaction_display_label(reaction_name, reaction_id),
                            reaction_id=reaction_id,
                            reaction_name=reaction_name,
                            reversible=True,
                            enzymes=[],
                            status="normal",
                            annotation="",
                            metadata={"kgml_type": "sbml_reaction", "source_id": reaction_id},
                        )
                    )

    if not edges:
        raise RuntimeError("No valid reactions found in SBML file")

    return PathwayResponse(
        pathway_id="sbml_import",
        pathway_name="SBML import",
        nodes=nodes,
        edges=edges,
        metadata={
            "node_count": len(nodes),
            "edge_count": len(edges),
            "source": "sbml_import",
        },
    )
