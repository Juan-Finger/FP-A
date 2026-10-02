#!/usr/bin/env python3
"""Simula o analista preenchendo a planilha de justificativas no Excel (openpyxl grava como o Excel:
textos compartilhados e compressão deflate).
Uso: preenche_xlsx.py entrada.xlsx saida.xlsx '{"unidade|conta": ["texto", "por"]}'"""
import json, sys, warnings
warnings.filterwarnings("ignore")
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb["Justificativas"]
pedidos = json.loads(sys.argv[3])
cab = [c.value for c in ws[3]]
cu, cc, cj, cp = cab.index("Unidade") + 1, cab.index("Conta") + 1, cab.index("Justificativa") + 1, cab.index("Por") + 1
for r in range(4, ws.max_row + 1):
    k = f"{ws.cell(r, cu).value}|{ws.cell(r, cc).value}"
    if k in pedidos:
        ws.cell(r, cj).value, ws.cell(r, cp).value = pedidos[k]
# linha digitada errada (mês inválido) para o painel ignorar
r = ws.max_row + 1
ws.cell(r, 1).value, ws.cell(r, 3).value, ws.cell(r, 5).value, ws.cell(r, cj).value = "13/26", "4101A", "4.1.1.08.1.06", "x"
wb.save(sys.argv[2])

# Grava como o Excel: textos numa tabela compartilhada (xl/sharedStrings.xml, células t="s") e,
# na primeira justificativa, um trecho formatado (texto em partes <r>), que o painel precisa juntar.
import re, zipfile, shutil, os
from xml.sax.saxutils import escape
from html import unescape
tmp = sys.argv[2] + ".tmp"
zin = zipfile.ZipFile(sys.argv[2])
arqs = {n: zin.read(n) for n in zin.namelist()}
zin.close()
folha = arqs["xl/worksheets/sheet1.xml"].decode("utf-8")
sst, idx = [], {}
def troca(m):
    attrs, corpo = m.group(1), m.group(2)
    txt = unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", corpo, re.S)))
    if txt not in idx:
        idx[txt] = len(sst)
        sst.append(txt)
    attrs = attrs.replace(' t="inlineStr"', "")
    return f'<c{attrs} t="s"><v>{idx[txt]}</v></c>'
folha = re.sub(r'<c([^>]*t="inlineStr"[^>]*)><is>(.*?)</is></c>', troca, folha, flags=re.S)
def si(t, k):
    if t.startswith("NF de aluguel"):   # trecho em negrito: o Excel quebra o texto em partes
        a, b = t[:6], t[6:]
        return f'<si><r><rPr><b/></rPr><t xml:space="preserve">{escape(a)}</t></r><r><t xml:space="preserve">{escape(b)}</t></r></si>'
    return f'<si><t xml:space="preserve">{escape(t)}</t></si>'
arqs["xl/worksheets/sheet1.xml"] = folha.encode("utf-8")
arqs["xl/sharedStrings.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    f'count="{len(sst)}" uniqueCount="{len(sst)}">' + "".join(si(t, k) for k, t in enumerate(sst)) + "</sst>").encode("utf-8")
ct = arqs["[Content_Types].xml"].decode("utf-8")
arqs["[Content_Types].xml"] = ct.replace("</Types>", '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>').encode("utf-8")
rl = arqs["xl/_rels/workbook.xml.rels"].decode("utf-8")
arqs["xl/_rels/workbook.xml.rels"] = rl.replace("</Relationships>", '<Relationship Id="rIdSST" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>').encode("utf-8")
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for n, d in arqs.items():
        zout.writestr(n, d)
shutil.move(tmp, sys.argv[2])
