"""Harvard-style citations (Cite Them Right) built from an item's metadata."""
import datetime
import re
import string
from collections import defaultdict

TYPE_LABELS = {"paper": "Journal / paper", "book": "Book", "report": "Report", "reference": "Reference",
               "religious": "Primary religious text", "web": "Web page", "news": "News"}

# Names that belong to an organisation, not a person: never turn these into "Surname, I."
CORPORATE = re.compile(r"\b(bank|bureau|ministry|department|organi[sz]ation|association|institute|institution|"
                       r"university|council|commission|committee|agency|authority|foundation|society|group|"
                       r"office|centre|center|corporation|company|ltd|inc|government|nations|union|forum|"
                       r"network|consortium|contributors|team|board|world|statistics|unesco|unicef|oecd|who)\b", re.I)
PARTICLES = {"van", "von", "der", "den", "de", "da", "del", "di", "du", "la", "le", "al", "el", "bin", "binti", "ibn"}


def _parse(name):
    """'Jane Q. Smith' -> ('Smith', 'J.Q.'); 'Smith, Jane' -> ('Smith', 'J.'); organisations stay whole."""
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not name:
        return "", ""
    if CORPORATE.search(name) or len(name.split()) > 5:
        return name, ""
    if "," in name:
        last, first = [p.strip() for p in name.split(",", 1)]
    else:
        parts = name.split(" ")
        if len(parts) == 1:
            return name, ""
        i = len(parts) - 1  # keep particles with the surname: "van der Berg"
        while i > 1 and parts[i - 1].lower() in PARTICLES:
            i -= 1
        last, first = " ".join(parts[i:]), " ".join(parts[:i])
    initials = "".join(f"{p[0].upper()}." for p in re.split(r"[\s\-.]+", first) if p and p[0].isalpha())
    return last, initials


def authors_str(authors):
    names = [f"{l}, {i}" if i else l for l, i in (_parse(a) for a in authors or []) if l]
    if not names:
        return ""
    if len(names) > 3:
        return f"{names[0]} et al."
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def _year(item):
    return item.get("year_label") or item.get("year") or "n.d."


def in_text(item):
    surnames = [_parse(a)[0] for a in item.get("authors") or [] if _parse(a)[0]]
    year = _year(item)
    if not surnames:
        title = item.get("title") or "Untitled"
        if item.get("source") == "quran":
            ref = title.split()[1] if len(title.split()) > 1 else ""
            return f"(Qur'an {ref})".replace(" )", ")")
        short = title if len(title) <= 40 else title[:37].rstrip() + "..."
        return f"({short}, {year})"
    if len(surnames) == 1:
        who = surnames[0]
    elif len(surnames) <= 3:  # Cite Them Right: name up to three authors, "et al." from four
        who = ", ".join(surnames[:-1]) + " and " + surnames[-1]
    else:
        who = f"{surnames[0]} et al."
    return f"({who}, {year})"


def harvard(item, accessed=None):
    accessed = accessed or datetime.date.today().strftime("%d %B %Y")
    au = authors_str(item.get("authors"))
    year = _year(item)
    title = (item.get("title") or "Untitled").rstrip(".")
    venue = item.get("venue") or ""
    url = item.get("url") or ""
    doi = item.get("doi") or ""
    link = f"doi: {doi}." if doi else (f"Available at: {url} (Accessed: {accessed})." if url else "")
    t = item.get("type")

    if item.get("source") == "quran":
        ref = title.split(" ", 1)[-1]
        translation = "Muhiuddin Khan and Sahih International" if "Bangla" in venue else "Sahih International"
        return f"The Qur'an (n.d.) {ref}. Translated by {translation}. Available at: {url} (Accessed: {accessed})."
    if t == "book":
        pub = f" {venue}." if venue else ""
        if au:
            return f"{au} ({year}) *{title}*.{pub}".strip()
        return f"*{title}* ({year}).{pub} {link if url else ''}".strip()
    if t == "paper":
        lead = au or venue or "Anonymous"
        parts = [f"{lead} ({year}) '{title}'"]
        if venue and venue != lead:
            parts.append(f"*{venue}*")
        return (", ".join(parts) + ". " + link).strip()
    lead = au or venue
    if lead:
        return f"{lead} ({year}) *{title}*. {link}".strip()
    return f"*{title}* ({year}). {link}".strip()


def apply(items):
    """Sets citation and in_text on every item. When two different works share the same author(s) and year,
    Harvard adds a letter to the year (2021a, 2021b) so each in-text citation points to one reference."""
    for it in items:
        it.pop("year_label", None)
    groups = defaultdict(list)
    for it in items:
        if it.get("source") != "quran":
            groups[in_text(it)].append(it)
    for group in groups.values():
        if len(group) > 1:
            group.sort(key=lambda x: (x.get("title") or "").lower())
            for letter, it in zip(string.ascii_lowercase, group):
                year = it.get("year") or "n.d."
                it["year_label"] = f"{year}{letter}" if year != "n.d." else f"n.d.-{letter}"
    for it in items:
        it["citation"] = harvard(it)
        it["in_text"] = in_text(it)
    return items
