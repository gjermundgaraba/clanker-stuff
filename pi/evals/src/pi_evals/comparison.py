"""One matched model/effort selection for a newly prepared three-arm series."""
from copy import deepcopy
import yaml
from pi_evals.artifacts import EVALS


def comparison(model=None, thinking=None, direct_tools=None):
    baseline = yaml.safe_load((EVALS / "profiles/code-mode.yaml").read_text())["agents"][0]
    model = baseline["model_name"] if model is None else model
    thinking = baseline["kwargs"]["thinking"] if thinking is None else thinking
    if not isinstance(model, str) or not model.startswith("openai/") or not model[7:].strip():
        raise ValueError("three-arm comparisons require an openai/model selection")
    if not isinstance(thinking, str) or not thinking.strip():
        raise ValueError("comparison thinking must be explicit")
    direct_tools = baseline["kwargs"]["pi_evals"]["direct_tools"] if direct_tools is None else direct_tools
    if not isinstance(direct_tools, list) or not direct_tools or any(not isinstance(t, str) or not t.strip() or t == "codemode" for t in direct_tools) or len(set(direct_tools)) != len(direct_tools):
        raise ValueError("comparison direct tools must be distinct nonempty names, excluding codemode")
    return {"model": model, "thinking": thinking, "directTools": sorted(direct_tools)}


def configure_agent(template, expected):
    agent = deepcopy(template)
    agent["model_name"] = expected["model"]
    key = "reasoning_effort" if agent["kwargs"]["pi_evals"]["platform"] == "codex-native" else "thinking"
    agent["kwargs"][key] = expected["thinking"]
    if agent["kwargs"]["pi_evals"].get("experiment") == "code-mode":
        agent["kwargs"]["pi_evals"]["direct_tools"] = expected["directTools"]
    return agent
