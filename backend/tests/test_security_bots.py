from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

ROBOTS = (Path(__file__).resolve().parents[2] / "public" / "robots.txt").read_text(encoding="utf-8")
AI_CRAWLERS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "CCBot", "ClaudeBot", "anthropic-ai", "PerplexityBot",
               "Bytespider", "Amazonbot", "Google-Extended", "Applebot-Extended", "FacebookBot", "meta-externalagent",
               "Diffbot"]


def groups():
    """robots.txt as {user-agent: [rules]}."""
    result, agents, rules = {}, [], []
    for line in ROBOTS.splitlines() + [""]:
        line = line.split("#")[0].strip()
        if line.lower().startswith("user-agent:"):
            if rules:
                agents, rules = [], []
            agents.append(line.split(":", 1)[1].strip())
            for agent in agents:
                result.setdefault(agent, rules)
        elif line:
            rules.append(line)
    return result


def test_ai_crawlers_are_disallowed_everywhere():
    parsed = groups()
    for bot in AI_CRAWLERS:
        assert parsed[bot] == ["Disallow: /"], bot


def test_search_engines_may_crawl_pages():
    rules = groups()["*"]
    assert "Allow: /" in rules and "Disallow: /" not in rules


def test_noai_header_on_every_response():
    client = TestClient(app)
    for path in ("/api/health", "/api/missing", "/"):
        assert client.get(path).headers["x-robots-tag"] == "noai, noimageai"
