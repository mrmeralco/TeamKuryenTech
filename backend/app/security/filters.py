"""Request filters and user-agent lists, ported from the Spotibai reference (lib/security.js lines 36, 77-116,
207-208). A request they block is refused with 403 and counts as a strike (3 strikes = 15-minute ban).

Adapted for SmartWatts: the "unexpected body" rule is dropped (this app has write endpoints), the Host check
lives in rules.py (step 3), and honeypots in limits.py (step 5).
"""

from __future__ import annotations

import re
from urllib.parse import unquote_plus

# Line 36: script / tool user agents (refused on the API and on pages; real browsers never send these).
BAD_UA = re.compile(r"curl|wget|python|scrapy|httpclient|okhttp|go-http|libwww|java/|axios|node-fetch|undici|aiohttp"
                    r"|postman|insomnia|httpie|crawler|spider|scrap", re.I)

# Lines 77-79: scanner paths, injection / traversal probes, hacking tools.
SCAN_PATH = re.compile(
    r"(/\.(env|git|svn|ht|aws|ssh|DS_Store)|wp-(admin|login|content|includes)|xmlrpc|phpmyadmin"
    r"|\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp)(/|$|\?)|\.(zip|tar|gz|rar|7z)($|\?)|cgi-bin|etc/passwd|actuator"
    r"|vendor/phpunit|/(admin|manager|console|shell|setup)\.)", re.I)
ATTACK_QS = re.compile(
    r"(union(\s|\+|%20)+(all(\s|\+|%20)+)?select|information_schema|sleep\s*\(|benchmark\s*\(|waitfor\s+delay"
    r"|<\s*script|javascript:|on(error|load|click|mouseover)\s*=|\.\.[/\\]|%00|etc/passwd|base64_decode|jndi:|\$\{"
    r"|\b(or|and)\b\s+['\"]?\d+['\"]?\s*=\s*['\"]?\d+|['\"]\s*(or|and)\s+['\"]|;\s*(drop|delete|insert|update|truncate)\s)",
    re.I)
ATTACK_UA = re.compile(
    r"(sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|dirbuster|gobuster|wpscan|hydra|havij|zgrab|nuclei"
    r"|burpsuite|w3af|metasploit|ffuf|feroxbuster|arachni|skipfish|whatweb|commix|xsser)", re.I)
# Lines 80-89: command / template injection, prototype pollution, NoSQL / LDAP, SSRF, XXE, CRLF, Log4Shell.
ATTACK_MORE = re.compile(
    r"(;\s*(id|ls|cat|whoami|uname|wget|curl|nc|bash|sh)\b|\|\s*(id|cat|ls|whoami|nc|bash|sh)\b|`[^`]+`|\$\([^)]+\)"
    r"|&&\s*(cat|ls|id|whoami|wget|curl)\b|cmd(\.exe)?\s*/c|powershell(\.exe)?\s|\{\{.*\}\}|<%.*%>|#\{.*\}|__proto__"
    r"|constructor\s*[.\[]\s*prototype|\[\s*\$(ne|gt|lt|gte|lte|regex|where|or|and|in|nin)\s*\]|\$where"
    r"|\)\s*\(\s*(uid|cn|objectclass)\s*="
    r"|(https?|ftp|file|gopher|dict|ldap|sftp|tftp)://(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)"
    r"|\b(file|gopher|dict|ldap|expect|php|phar|data)://|<!(entity|doctype)[^>]*(system|public)|[\r\n]|%0d|%0a"
    r"|\bexec\s*\(|\beval\s*\(|\bsystem\s*\(|\bpassthru\s*\(|\bshell_exec\s*\()", re.I)
HEADER_INJECTION = re.compile(r"jndi:|\$\{|<\s*script", re.I)

# Lines 207-208: AI crawlers / headless browsers (refused on pages) and the search engines that stay allowed.
AI_BOT = re.compile(
    r"gptbot|chatgpt|oai-searchbot|ccbot|claudebot|claude-web|anthropic|perplexity|bytespider|amazonbot"
    r"|applebot-extended|google-extended|facebookbot|meta-external|diffbot|imagesift|omgili|timpi|petalbot|semrush"
    r"|ahrefs|mj12|dotbot|dataforseo|headlesschrome|phantomjs|puppeteer|playwright|selenium", re.I)
SEARCH_BOT = re.compile(r"googlebot|bingbot|duckduckbot|yandex|baiduspider|slurp", re.I)


def _decoded(value: str) -> str:
    try:
        return unquote_plus(value)
    except Exception:
        return value


def attack_reason(path: str, query: str, headers: dict[str, str]) -> str:
    """Lines 100-116: the reason a request looks like an attack, or "" (path is already percent-decoded)."""
    query = _decoded(query)
    if SCAN_PATH.search(path):
        return "scanner path"
    if ATTACK_QS.search(query) or ATTACK_QS.search(path):
        return "injection probe"
    if ATTACK_MORE.search(query) or ATTACK_MORE.search(path):
        return "injection probe"
    if ATTACK_UA.search(headers.get("user-agent", "")):
        return "attack tool"
    if HEADER_INJECTION.search(" ".join(filter(None, (headers.get("referer"), headers.get("cookie"),
                                                       headers.get("x-forwarded-host"))))):
        return "header injection"
    return ""


def ua_reason(user_agent: str, page: bool) -> str:
    """Script user agents everywhere; AI crawlers and headless browsers on pages. Search engines pass."""
    if SEARCH_BOT.search(user_agent):
        return ""
    if not user_agent or BAD_UA.search(user_agent):
        return "script user agent"
    if page and AI_BOT.search(user_agent):
        return "ai crawler / headless browser"
    return ""


def is_search_bot(user_agent: str) -> bool:
    return bool(SEARCH_BOT.search(user_agent))
