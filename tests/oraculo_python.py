#!/usr/bin/env python3
"""Roda a lógica ORIGINAL em Python (tests/referencia/gerar_dashboard.py) sobre um CSV
e imprime o payload em JSON. Serve de oráculo: o JS tem de chegar ao mesmo número.

As planilhas de apoio (contas.xlsx / responsaveis.xlsx) são substituídas pelas
tabelas embutidas no HTML, que foram extraídas delas.
"""
import json, os, re, sys, types

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.modules.setdefault("openpyxl", types.ModuleType("openpyxl"))   # não é usado aqui
sys.path.insert(0, os.path.join(AQUI, "referencia"))
import gerar_dashboard as g  # noqa: E402

g.CSV_ENCODING = "cp1252"     # o navegador lê "ISO-8859-1" como windows-1252
html = open(os.path.join(AQUI, "referencia", "dashboard_original.html"), encoding="utf-8").read()
clas = {k: tuple(v) for k, v in json.loads(re.search(r"const CLASSIF=(\{.*?\});", html).group(1)).items()}
segmap = json.loads(re.search(r"const SEGMAP=(\{.*?\});", html).group(1))
print(json.dumps(g.carrega_base(sys.argv[1], clas, segmap), ensure_ascii=False))
