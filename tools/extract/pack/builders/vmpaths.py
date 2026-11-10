"""Paths shared by the pack builders. Set by tools/extract/pack.mjs through the environment:

  VM_WORK  work folder (game files extracted/exported per area: body, face, hair, skin, fix, intimate)
  VM_OUT   asset pack being built (the layout the app reads: glb/, hair/, tex/, body/ ...)
  VM_REPO  repository root (src/data/catalog.*.json are read from here)
"""
import os
from pathlib import Path


def _need(name: str) -> Path:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"{name} is not set: run the builders through `npm run pack`")
    return Path(v).resolve()


WORK = _need("VM_WORK")
OUT = _need("VM_OUT")
REPO = _need("VM_REPO")
BUILDERS = Path(__file__).resolve().parent


def area(name: str) -> Path:
    """Work folder of one builder area (body, face, hair, skin, fix, intimate)."""
    return WORK / name
