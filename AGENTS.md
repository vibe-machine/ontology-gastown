# ontology-gastown agent guidance

This repository is the gastown ontology package: the multi-agent orchestration domain (agents, workspaces) for parallel AI development, built on gist.

Before changing or releasing this package, follow the `ontology-extend` skill: questions first,
design on gist, version bump, the three install tests, `ont release`.

Agent skills come from the vibe-machine skill cabinet through `apm.yml`. Run `apm install` to
refresh them; never edit `.claude/skills/` or `.agents/skills/` by hand.
