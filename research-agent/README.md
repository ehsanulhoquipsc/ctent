# CTENT Research Agent (standalone test version)

A free research agent. You give it a topic; it breaks the topic into sub-questions, searches up to 15 free sources,
removes duplicates, ranks results, reads them with AI and turns each one into an **evidence card**
(key findings, data/statistics, a short quote, reliability rating and a ready Harvard citation).
You tick the cards you want, then export an evidence pack or let it draft the report from **only** your selected cards.

## Run it (5 minutes)

1. Install Python 3.10+ (python.org).
2. In this folder:
   ```
   pip install -r requirements.txt
   copy .env.example .env        (Mac/Linux: cp .env.example .env)
   ```
3. Open `.env` and add the free keys (all optional, but these two make a big difference):
   - `GEMINI_API_KEY` - https://aistudio.google.com/apikey (AI planning, extraction, drafting)
   - `OPENALEX_API_KEY` - https://openalex.org/settings/api (largest paper index)
4. `python app.py` and open **http://localhost:5000**

Terminal-only option: `python cli.py "your topic" --depth quick` writes an evidence pack `.md`.

## How the agent works

| Step | What happens |
|---|---|
| 1. Plan | AI splits the topic into 3-10 sub-questions (background, theory, data, debates, case studies, gaps) plus Islamic keywords if relevant |
| 2. Search | Every selected source is searched for every sub-question, in parallel, respecting each API's rate limit |
| 3. Merge | The same paper found in several databases becomes one card ("found in: OpenAlex + Semantic Scholar"), keeping the journal record over preprints |
| 4. Rank | Score = keyword match + citations + reliability tier + AI relevance (0-5) |
| 5. Extract | AI reads the top abstracts in batches and pulls findings, numbers and a verified quote (it is told never to invent facts) |
| 6. Select | Filter by sub-question, type, source, reliability, "only cards with data"; tick what you want |
| 7. Output | Evidence pack (.docx/.md, grouped by sub-question, with reference list) or AI draft report (.docx/.md) built only from selected cards |

## Deeper research features

| Feature | What it does | Needs |
|---|---|---|
| **Full-text reading** | Finds free, legal PDFs (Unpaywall, arXiv, Semantic Scholar, OpenAlex, CORE), reads the methods, results, discussion, limitations and conclusion, and extracts method, sample, limitations and more findings | `CONTACT_EMAIL` for Unpaywall; AI key for extraction |
| **Citation trail** | Takes the best papers and adds the most-cited papers they cite and that cite them (marked "Citation trail") | nothing (uses Semantic Scholar, or OpenAlex if you have its key) |
| **Agreement & contradiction map** | For each sub-question: main claims, which sources support or contradict them, consensus (strong / moderate / mixed / contested / single source) and why sources differ. Click a citation to jump to its card. The draft uses it for the Discussion. | AI key |
| **Quality checks** | Flags retracted papers (Crossref + Retraction Watch, OpenAlex), preprints not yet peer-reviewed, and journals from publishers often listed as questionable ("check this journal", a warning, not a verdict). Retracted papers are pushed down, hidden by default and never cited in drafts. | nothing |
| **Literature matrix (.xlsx)** | Excel workbook: matrix (citation, authors, year, method, sample, findings, data, limitations, flags, reference), consensus map, all data points, and charts | nothing |
| **Charts** | Overview on the results page: publications by year, reliability mix, top journals, results by source, plus totals | nothing |
| **Research gaps finder** | Counts how well each sub-question is covered and which methods, countries and years the studies come from, then combines this with contested claims and the limitations and future-research notes authors state. The AI turns it into prioritised gaps (empirical, methodological, contextual, temporal, theoretical, conflicting, practical), each with the evidence, a suggested research question and a suggested method. Re-run it on selected cards only. Export a Research gaps brief (.docx/.md); gaps also go into the Excel matrix, the evidence pack and the draft's "Gaps and Further Research" section. | AI key for full gaps; basic count-based gaps work without it |
| **Bangladesh sources** | BanglaJOL journals, Bangladesh Bureau of Statistics, Bangladesh Bank, The Daily Star, Prothom Alo (in Bangla in Bangla mode). Ticked automatically for Bangla research. | nothing |

Turn full-text reading, citation trail, the agreement map and the gaps finder on or off under "Deeper research" when starting.
Exports use the cards you selected (or all cards if none are selected).

## Bangla mode (বাংলা)

- Click **বাংলা** (top right) to switch the whole interface to Bangla.
- Type the topic in Bangla or English and choose **ফলাফলের ভাষা → বাংলা**.
- AI writes the sub-questions, findings, data points, log and report draft in formal Bangla (প্রমিত বাংলা).
- Academic databases only work in English, so the AI translates your topic into English searches for them, and
  also searches Bangla Wikipedia, Bangla web and news, HadithBD, and adds the Bangla Qur'an translation
  (Muhiuddin Khan) next to the English one.
- Citations and the reference list stay in standard English Harvard format, as universities expect.
- Word exports use the Nirmala UI font (built into Windows) so Bangla displays correctly.
- Bangla mode needs the Gemini key: without AI, a Bangla topic cannot be translated for the English databases.

## Sources (all free)

| Group | Sources | Key |
|---|---|---|
| Academic papers | OpenAlex, Semantic Scholar, CrossRef, DOAJ, arXiv, PubMed, CORE | OpenAlex & CORE need a free key |
| Books | Open Library, Google Books | none |
| Data & reports | World Bank documents & reports | none |
| Reference | Wikipedia | none |
| Islamic sources | Qur'an (Sahih International via alquran.cloud), Hadith (Sunnah.com via web search) | none |
| Web & news | DuckDuckGo web and news | none |

Reliability tiers: **high** = peer-reviewed / journal / primary text, **medium** = preprints, books, reports, .gov/.edu sites,
news, **low** = general web pages and Wikipedia (good for leads, weak as citations).

## Depth and free limits

Quick (~3 min), Standard (~8 min), Deep (~15-25 min). A Deep run uses about 50 Gemini calls (planning, 20 full texts,
abstract batches, agreement map), inside the free daily limit, but run one Deep search at a time. If Gemini says its limit is reached, wait a few minutes or use Quick. For no limits at all, install
Ollama and set `LLM_PROVIDER=ollama` in `.env` (slower, runs on your computer).

Always open and check a source before citing it; abstracts and AI summaries are a starting point, not a substitute.

## Files

`app.py` web app · `agent.py` pipeline and prompts · `sources.py` all source connectors · `fulltext.py` PDF reading ·
`quality.py` quality checks · `gaps.py` research gaps finder · `matrix.py` Excel matrix · `translations.py` English/Bangla text · `llm.py` Gemini/Ollama ·
`citations.py` Harvard formatting · `db.py` SQLite storage · `exporter.py` Word/Markdown export ·
`tests/test_offline.py` full offline test (`python tests/test_offline.py`).

## Look and feel

The interface uses the CTENT website's own design system: `static/css/ctent.css` is a copy of the site's
`public/css/app.css`, with the same logo, icons, DM Sans font, maroon primary colour, sidebar layout and light/dark
theme (the moon button). Agent-only parts are in `static/css/agent.css` and use the same colour tokens.
If the website's design changes, copy its `app.css` over `static/css/ctent.css`. Set `CTENT_URL` in `.env` to change
where "Back to CTENT" points (default https://ctent.onrender.com).

## Moving it into CTENT later

`agent.py`, `sources.py`, `llm.py`, `citations.py` and `exporter.py` have no Flask dependency, so they drop straight
into the ctent repo. The research task page calls `agent.run_research(run_id)` in a background thread and links each
run to a task ID; the evidence cards table becomes shared by the team, so members can select cards together.
