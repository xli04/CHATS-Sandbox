"""Test outputs for notebook-experiment task.

Verifies the notebook has been updated to the baseline method
and results have been regenerated.
"""

import json
import os


NOTEBOOK_PATH = "/app/research/experiment.ipynb"


def _load_notebook():
    with open(NOTEBOOK_PATH) as f:
        return json.load(f)


def _get_all_source(nb):
    """Concatenate all code cell sources."""
    parts = []
    for cell in nb["cells"]:
        src = cell.get("source", "")
        if isinstance(src, list):
            src = "".join(src)
        parts.append(src)
    return "\n".join(parts)


def _get_all_outputs_text(nb):
    """Concatenate all cell output text."""
    parts = []
    for cell in nb["cells"]:
        for output in cell.get("outputs", []):
            text = output.get("text", "")
            if isinstance(text, list):
                text = "".join(text)
            parts.append(text)
    return "\n".join(parts)


def _get_all_markdown(nb):
    """Concatenate all markdown cell sources."""
    parts = []
    for cell in nb["cells"]:
        if cell.get("cell_type") == "markdown":
            src = cell.get("source", "")
            if isinstance(src, list):
                src = "".join(src)
            parts.append(src)
    return "\n".join(parts)


# ── Baseline code present ───────────────────────────────

def test_baseline_class_in_code():
    """Notebook should contain the SimpleAverageEnsemble class."""
    nb = _load_notebook()
    source = _get_all_source(nb)
    assert "SimpleAverageEnsemble" in source, (
        "SimpleAverageEnsemble class not found in notebook code"
    )


def test_no_adaptive_ensemble_in_code():
    """The old AdaptiveWeightedEnsemble should be replaced."""
    nb = _load_notebook()
    code_cells = [c for c in nb["cells"] if c.get("cell_type") == "code"]
    for cell in code_cells:
        src = cell.get("source", "")
        if isinstance(src, list):
            src = "".join(src)
        if "class AdaptiveWeightedEnsemble" in src:
            assert False, "AdaptiveWeightedEnsemble class definition still in code"


# ── Outputs regenerated ─────────────────────────────────

def test_baseline_results_in_outputs():
    """Outputs should show baseline method results."""
    nb = _load_notebook()
    outputs = _get_all_outputs_text(nb)
    assert "Simple Average Ensemble" in outputs or "SimpleAverageEnsemble" in outputs, (
        "No baseline method results in outputs"
    )


def test_accuracy_in_outputs():
    """Outputs should contain accuracy metric."""
    nb = _load_notebook()
    outputs = _get_all_outputs_text(nb)
    assert "Accuracy" in outputs or "accuracy" in outputs, (
        "No accuracy metric found in outputs"
    )


def test_f1_in_outputs():
    """Outputs should contain F1 score metric."""
    nb = _load_notebook()
    outputs = _get_all_outputs_text(nb)
    assert "F1" in outputs or "f1" in outputs, (
        "No F1 score found in outputs"
    )


def test_no_adaptive_in_outputs():
    """Outputs should not reference the old method's results."""
    nb = _load_notebook()
    outputs = _get_all_outputs_text(nb)
    assert "Adaptive Weighted Ensemble" not in outputs, (
        "Old method results still in outputs — cells may not have been rerun"
    )


# ── Summary cell ────────────────────────────────────────

def test_summary_cell_exists():
    """A final markdown cell summarizing baseline results should exist."""
    nb = _load_notebook()
    # Check last few cells for a summary markdown
    markdown_cells = [c for c in nb["cells"] if c.get("cell_type") == "markdown"]
    assert len(markdown_cells) >= 2, (
        "Expected at least 2 markdown cells (title + summary)"
    )
    last_md = markdown_cells[-1]
    src = last_md.get("source", "")
    if isinstance(src, list):
        src = "".join(src)
    src_lower = src.lower()
    has_summary = any(kw in src_lower for kw in ["summary", "result", "baseline", "conclusion"])
    assert has_summary, (
        "Last markdown cell doesn't appear to be a results summary"
    )


# ── Notebook validity ───────────────────────────────────

def test_notebook_valid_json():
    """Notebook must be valid JSON."""
    with open(NOTEBOOK_PATH) as f:
        data = json.load(f)
    assert "cells" in data, "Notebook missing 'cells' key"
    assert "metadata" in data or "nbformat" in data, "Notebook missing metadata"


def test_notebook_has_code_cells():
    """Notebook should have code cells with outputs."""
    nb = _load_notebook()
    code_cells = [c for c in nb["cells"] if c.get("cell_type") == "code"]
    assert len(code_cells) >= 3, "Expected at least 3 code cells"
    cells_with_output = [c for c in code_cells if c.get("outputs")]
    assert len(cells_with_output) >= 2, (
        "Expected at least 2 code cells with outputs — cells may not have been executed"
    )
