"""Harvard-style citations built from an item's metadata."""
import datetime
import re

TYPE_LABELS = {"paper": "Journal / paper", "book": "Book", "report": "Report", "reference": "Reference",
               "religious": "Primary religious text", "web": "Web page", "news": "News"}


def _parse(name):
    name = (name or "").strip()
    if not name:
        return "", ""
    if "," in name:
        last, first = [p.strip() for p in name.split(",", 1)]
    else:
        parts = name.split()
        if len(parts) == 1 or name.lower().startswith(("world bank", "wikipedia")):
            return name, ""
        last, first = parts[-1], " ".join(parts[:-1])
    initials = "".join(f"{p[0].upper()}." for p in re.split(r"[\s\-.]+", first) if p)
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


def in_text(item):
    surnames = [_parse(a)[0] for a in item.get("authors") or [] if _parse(a)[0]]
    year = item.get("year") or "n.d."
    if not surnames:
        title = item.get("title", "Untitled")
        if item.get("source") == "quran":
            return f"(Qur'an {title.split()[1] if len(title.split()) > 1 else ''})".replace(" )", ")")
        short = title if len(title) <= 40 else title[:37].rstrip() + "..."
        return f"({short}, {year})"
    if len(surnames) == 1:
        who = surnames[0]
    elif len(surnames) == 2:
        who = f"{surnames[0]} and {surnames[1]}"
    else:
        who = f"{surnames[0]} et al."
    return f"({who}, {year})"


def harvard(item, accessed=None):
    accessed = accessed or datetime.date.today().strftime("%d %B %Y")
    au = authors_str(item.get("authors"))
    year = item.get("year") or "n.d."
    title = item.get("title", "Untitled")
    venue = item.get("venue", "")
    url = item.get("url", "")
    doi = item.get("doi", "")
    link = f"doi: {doi}." if doi else (f"Available at: {url} (Accessed: {accessed})." if url else "")
    t = item.get("type")

    if item.get("source") == "quran":
        return f"The Qur'an (n.d.) {title.split(' ', 1)[-1]}. Translated by Sahih International. Available at: {url} (Accessed: {accessed})."
    if t == "book":
        pub = f" {venue}." if venue else ""
        return f"{au or title} ({year}) *{title}*.{pub} {link if url and not au else ''}".strip()
    if t == "paper":
        v = f" *{venue}*." if venue else ""
        return f"{au or 'Anonymous'} ({year}) '{title}',{v} {link}".replace(",.", ".").strip()
    lead = au or venue or title
    return f"{lead} ({year}) *{title}*. {link}".strip()
