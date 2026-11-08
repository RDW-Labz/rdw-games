# agent-template

Every `agent-<person>` repo is made from this folder. Change the template for anything that should reach every agent; change the person's repo only for that person.

```
agent.yaml          pins: agent-core, skills, connectors versions; model defaults; schedule of proactive skills
profile.yaml        the person's role file (written by onboarding; the person owns it)
skills.yaml         which shared skills are installed; personal skills listed by path
macros/             the person's buttons (Zemeckis macro files) — gitignored, synced privately
docs/ONBOARDING.md  the onboarding transcript summary, if they chose to keep it
```
