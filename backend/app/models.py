from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class MetaboliteNode(BaseModel):
    id: str
    label: str
    x: float
    y: float
    type: str = "metabolite"
    is_cofactor: bool = False
    raw_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ReactionEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str
    reaction_id: Optional[str] = None
    reaction_name: Optional[str] = None
    status: str = "normal"
    reversible: bool = False
    enzymes: List[str] = Field(default_factory=list)
    annotation: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


class PathwayResponse(BaseModel):
    pathway_id: str
    pathway_name: str
    nodes: List[MetaboliteNode]
    edges: List[ReactionEdge]
    metadata: Dict[str, Any] = Field(default_factory=dict)
