"""Literature review matrix as an Excel workbook: Matrix, Consensus map, Data points and Charts sheets."""
from collections import Counter
from io import BytesIO

from openpyxl import Workbook
from openpyxl.chart import BarChart, PieChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

import citations
import gaps as gapfinder
import sources
from translations import CONSENSUS, FLAGS, PRIORITIES, TIERS, TYPES, gap_type, method_label
from translations import a as msg

HEAD_FILL = PatternFill("solid", fgColor="111111")
BAND_FILL = PatternFill("solid", fgColor="F6F6F6")
FLAG_FILL = PatternFill("solid", fgColor="FBE3E3")
CONS_FILL = {"strong": "DDF1E4", "moderate": "EAF4D9", "mixed": "FDF1D6", "contested": "FBE3E3", "single": "EEEEEE"}
THIN = Border(bottom=Side(style="thin", color="DDDDDD"))


def _sheet(ws, headers, widths, rows, font_name, flag_col=None):
    for c, (h, w) in enumerate(zip(headers, widths), 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.font = Font(name=font_name, bold=True, color="FFFFFF")
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(c)].width = w
    ws.row_dimensions[1].height = 30
    for r, row in enumerate(rows, 2):
        for c, val in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=val)
            cell.font = Font(name=font_name, size=10)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            cell.border = THIN
            if r % 2 == 0:
                cell.fill = BAND_FILL
        if flag_col and row[flag_col - 1]:
            ws.cell(row=r, column=flag_col).fill = FLAG_FILL
    ws.freeze_panes = "C2" if len(headers) > 6 else "A2"
    if rows:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"


PRIO_FILL = {"high": "FBE3E3", "medium": "FDF1D6", "low": "EEEEEE"}


def build(run, items, synthesis, gaps_result=None):
    lang = run.get("lang") or "en"
    L = lambda k: msg(lang, k)  # noqa: E731
    font_name = "Nirmala UI" if lang == "bn" else "Calibri"
    tier = lambda t: TIERS.get(lang, {}).get(t, t)  # noqa: E731
    typ = lambda t: TYPES.get(lang, {}).get(t) or citations.TYPE_LABELS.get(t, t)  # noqa: E731
    flag = lambda fs: "; ".join(FLAGS[lang].get(f, f) for f in fs or [])  # noqa: E731
    bullets = lambda xs: "\n".join(f"• {x}" for x in xs or [])  # noqa: E731

    wb = Workbook()
    ws = wb.active
    ws.title = L("m_title")[:31]
    headers = [L(k) for k in ("m_no", "m_cite", "m_authors", "m_year", "m_title_col", "m_venue", "m_type", "m_question",
                              "m_method", "m_sample", "m_findings", "m_data", "m_limits", "m_tier", "m_flags",
                              "m_cited", "m_full", "m_via", "m_link", "m_ref", "m_mtype", "m_country", "m_future")]
    widths = [5, 22, 24, 7, 40, 24, 12, 30, 26, 26, 55, 40, 30, 11, 18, 9, 9, 22, 30, 60, 18, 18, 34]
    rows = []
    for n, it in enumerate(items, 1):
        found = it.get("via") or ", ".join(sources.label(s) for s in it.get("found_in") or [it["source"]])
        rows.append([n, it["in_text"], "; ".join(it["authors"][:6]) + (" et al." if len(it["authors"]) > 6 else ""),
                     it.get("year") or "n.d.", it["title"], it.get("venue") or "", typ(it["type"]), it["question"],
                     it.get("method") or "", it.get("sample") or "", bullets(it["findings"]), bullets(it["data_points"]),
                     it.get("limitations") or "", tier(it["tier"]), flag(it.get("flags")), it.get("citations") or "",
                     L("yes") if it.get("fulltext") else L("no"), found, it.get("url") or "", it["citation"],
                     method_label(lang, gapfinder.classify_method(it)) if gapfinder.classify_method(it) else "",
                     ", ".join(gapfinder.item_countries(it)), it.get("future") or ""])
    _sheet(ws, headers, widths, rows, font_name, flag_col=15)
    for r in range(2, len(rows) + 2):
        link = ws.cell(row=r, column=19)
        if link.value:
            link.hyperlink = link.value
            link.font = Font(name=font_name, size=10, color="0B4F8A", underline="single")

    by_id = {it["id"]: it for it in items}
    ws2 = wb.create_sheet(L("s_consensus")[:31])
    rows2 = []
    for s in synthesis:
        for c in s["claims"]:
            sup = [by_id[i]["in_text"] for i in c["support"] if i in by_id]
            con = [by_id[i]["in_text"] for i in c["contradict"] if i in by_id]
            if sup or con:
                rows2.append([s["question"], c["claim"], CONSENSUS[lang].get(c["consensus"], c["consensus"]),
                              "\n".join(sup), "\n".join(con), c.get("note") or ""])
    _sheet(ws2, [L("m_question"), L("s_claim"), L("s_level"), L("s_support"), L("s_contra"), L("s_note")],
           [30, 60, 14, 26, 26, 45], rows2, font_name)
    for r, row in enumerate(rows2, 2):
        key = next((k for k, v in CONSENSUS[lang].items() if v == row[2]), "single")
        ws2.cell(row=r, column=3).fill = PatternFill("solid", fgColor=CONS_FILL[key])

    ws3 = wb.create_sheet(L("s_data")[:31])
    rows3 = [[it["in_text"], d, it["question"], tier(it["tier"]), it.get("url") or ""]
             for it in items for d in it["data_points"]]
    _sheet(ws3, [L("m_cite"), L("m_data"), L("m_question"), L("m_tier"), L("m_link")], [24, 70, 34, 12, 34], rows3, font_name)

    if gaps_result and gaps_result.get("gaps"):
        ws5 = wb.create_sheet(L("s_gaps")[:31])
        rows5 = []
        for g in gaps_result["gaps"]:
            ev = [by_id[i]["in_text"] for i in g.get("evidence", []) if i in by_id]
            rows5.append([PRIORITIES[lang].get(g["priority"], g["priority"]), gap_type(lang, g["type"]), g["title"],
                          g.get("description") or "", g.get("signal") or "", "\n".join(ev),
                          g.get("research_question") or "", g.get("method") or ""])
        _sheet(ws5, [L(k) for k in ("g_priority", "g_type", "g_gap", "g_desc", "g_signal", "g_evidence", "g_rq", "g_method")],
               [11, 18, 40, 60, 36, 24, 50, 40], rows5, font_name)
        for r, g in enumerate(gaps_result["gaps"], 2):
            ws5.cell(row=r, column=1).fill = PatternFill("solid", fgColor=PRIO_FILL.get(g["priority"], "EEEEEE"))
        cov = (gaps_result.get("stats") or {}).get("coverage") or []
        ws6 = wb.create_sheet(L("s_coverage")[:31])
        rows6 = [[c["question"], c["n"], c["high"], c["full"], c["data"], L("cov_thin") if c.get("thin") else ""] for c in cov]
        _sheet(ws6, [L("m_question"), "n", L("m_tier") + ": " + tier("high"), L("m_full"), L("m_data"), L("cov_thin")],
               [60, 8, 16, 14, 12, 16], rows6, font_name)
        for r, c in enumerate(cov, 2):
            if c.get("thin"):
                ws6.cell(row=r, column=6).fill = FLAG_FILL

    ws4 = wb.create_sheet(L("s_charts")[:31])
    years = Counter(int(it["year"]) for it in items if str(it.get("year") or "").isdigit())
    tiers = Counter(tier(it["tier"]) for it in items)
    srcs = Counter(sources.label(s) for it in items for s in (it.get("found_in") or [it["source"]]))
    methods = Counter(method_label(lang, m) for m in (gapfinder.classify_method(it) for it in items if it["type"] == "paper") if m)
    countries = Counter(c for it in items if it["type"] in ("paper", "report", "book") for c in gapfinder.item_countries(it))
    blocks = [(L("m_year"), sorted(years.items())), (L("m_tier"), list(tiers.items())), ("Source", srcs.most_common(12)),
              (L("m_mtype"), methods.most_common()), (L("m_country"), countries.most_common(12))]
    col = 1
    anchors = ["P2", "P20", "P38", "P56", "P74"]
    for (title, data), anchor, kind in zip(blocks, anchors, ("bar", "pie", "barh", "barh", "barh")):
        ws4.cell(row=1, column=col, value=title).font = Font(name=font_name, bold=True)
        ws4.cell(row=1, column=col + 1, value="n").font = Font(name=font_name, bold=True)
        for r, (k, v) in enumerate(data, 2):
            ws4.cell(row=r, column=col, value=k).font = Font(name=font_name)
            ws4.cell(row=r, column=col + 1, value=v)
        if data:
            chart = PieChart() if kind == "pie" else BarChart()
            if kind == "barh":
                chart.type = "bar"
            chart.title = title
            chart.legend = None if kind != "pie" else chart.legend
            chart.add_data(Reference(ws4, min_col=col + 1, min_row=1, max_row=len(data) + 1), titles_from_data=True)
            chart.set_categories(Reference(ws4, min_col=col, min_row=2, max_row=len(data) + 1))
            chart.height, chart.width = 8, 16
            ws4.add_chart(chart, anchor)
        ws4.column_dimensions[get_column_letter(col)].width = 26
        col += 3
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
