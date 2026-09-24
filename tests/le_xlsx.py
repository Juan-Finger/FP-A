#!/usr/bin/env python3
"""Lê um .xlsx gerado pelo painel (sem openpyxl) e imprime {aba: [[células]]} em JSON."""
import json, re, sys, zipfile
from xml.etree import ElementTree as ET
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
wb = ET.fromstring(z.read("xl/workbook.xml"))
out = {}
for i, s in enumerate(wb.find("m:sheets", NS), 1):
    ws = ET.fromstring(z.read(f"xl/worksheets/sheet{i}.xml"))
    linhas = []
    for row in ws.iter(f"{{{NS['m']}}}row"):
        cel = []
        for c in row:
            v = c.find("m:v", NS); t = c.find("m:is/m:t", NS)
            cel.append(float(v.text) if v is not None else (t.text if t is not None else None))
        linhas.append(cel)
    out[s.get("name")] = linhas
print(json.dumps(out, ensure_ascii=False))
