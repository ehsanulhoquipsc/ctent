"""Settings for the CTENT Research Agent. Values come from environment variables or a .env file."""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

BASE_DIR = Path(__file__).parent
DB_PATH = os.getenv("DB_PATH", str(BASE_DIR / "research.db"))
CTENT_URL = os.getenv("CTENT_URL", "https://ctent.onrender.com")  # the "Back to CTENT" link

# Contact email is sent to CrossRef/PubMed so they put you in their faster "polite" queue.
CONTACT_EMAIL = os.getenv("CONTACT_EMAIL", "")
USER_AGENT = f"CTENT-ResearchAgent/0.1 (+https://ctent.onrender.com; mailto:{CONTACT_EMAIL or 'none'})"

# --- AI model (optional, all free options) ---
# gemini : free API key from https://aistudio.google.com/apikey
# ollama : runs a model on your own computer, no key, no limits (https://ollama.com)
# none   : keyword mode, no AI (search + rank only)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini" if GEMINI_API_KEY else "none").lower()
# Seconds between AI calls. Gemini free tier allows roughly 10-15 requests per minute.
LLM_MIN_INTERVAL = float(os.getenv("LLM_MIN_INTERVAL", "5" if LLM_PROVIDER == "gemini" else "0"))

# --- Optional free keys that unlock or speed up sources ---
OPENALEX_API_KEY = os.getenv("OPENALEX_API_KEY", "")   # free: openalex.org/settings/api (required since Feb 2026)
CORE_API_KEY = os.getenv("CORE_API_KEY", "")           # free: core.ac.uk/services/api
S2_API_KEY = os.getenv("S2_API_KEY", "")               # free: semanticscholar.org/product/api (fewer rate-limit errors)

# How hard each depth level works.
# extract = cards read by AI from abstracts, fulltext = open-access PDFs read in full,
# seeds = top papers whose citation trail is followed, per_seed = papers taken from each direction of a trail.
DEPTHS = {
    "quick":    {"max_questions": 3,  "per_source": 5,  "extract": 24,  "fulltext": 4,  "seeds": 3,  "per_seed": 4,  "label": "Quick (~3 min)"},
    "standard": {"max_questions": 6,  "per_source": 10, "extract": 56,  "fulltext": 10, "seeds": 6,  "per_seed": 6,  "label": "Standard (~8 min)"},
    "deep":     {"max_questions": 10, "per_source": 20, "extract": 120, "fulltext": 20, "seeds": 10, "per_seed": 8,  "label": "Deep (~15-25 min)"},
}
