from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.factory import AgentFactory
from harbor.models.job.config import JobConfig


def start_agents(config: dict, logs_dir: Path) -> list[BaseAgent]:
    """Check each agent as `harbor job start` does, then build our adapters.

    `--print-config` and `JobPlan.build_trial_configs` stop before Harbor
    validates agent kwargs, so neither catches an option Harbor rejects.
    Harbor's own agents, such as the oracle, need a trial to construct.
    """
    agents = []
    for agent in JobConfig.model_validate(config).agents:
        AgentFactory.run_preflight(agent, skip_credential_checks=True)
        if agent.import_path is not None:
            agents.append(
                AgentFactory.create_agent_from_config(agent, logs_dir=logs_dir)
            )
    return agents
