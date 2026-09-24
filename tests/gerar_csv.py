#!/usr/bin/env python3
"""Gera as bases sintéticas usadas pela suíte de regressão (tests/tmp/).

Formato igual ao export do Plano: ';', windows-1252, códigos ="...",
valores pt-BR. Nada aqui é dado real: contas e unidades vêm das tabelas
embutidas no próprio dashboard.html, valores são aleatórios com semente fixa.
"""
import json, os, random, re

AQUI = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(AQUI, "tmp")
os.makedirs(TMP, exist_ok=True)
html = open(os.path.join(AQUI, "referencia", "dashboard_original.html"), encoding="utf-8").read()
CLASSIF = json.loads(re.search(r"const CLASSIF=(\{.*?\});", html).group(1))
SEGMAP = json.loads(re.search(r"const SEGMAP=(\{.*?\});", html).group(1))
MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]
HDR = ["Conta", "Descrição conta", "Unidade", "Descrição unidade", "Empresa", "CC", "Resp", "Tipo"]
for m in MESES:
    HDR += [f"Planejado {m}/2026", f"Realizado {m}/2026"]
HDR += ["Total Planejado", "Total Realizado"]


def fmt(v):
    s = f"{abs(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if v < 0 else "") + s


def linha(conta, desc, unid, udesc, p, r):
    cel = [f'="{conta}"', desc, f'="{unid}"', udesc, '="001"', '="CC01"', "Fulano", "X"]
    for i in range(12):
        cel += [fmt(p[i]) if p[i] else "0", fmt(r[i]) if r[i] else "0"]
    return ";".join(cel + ["0", "0"])


def escreve(nome, linhas, enc="cp1252"):
    with open(os.path.join(TMP, nome), "w", encoding=enc, newline="") as fh:
        fh.write("\r\n".join([";".join(HDR)] + linhas) + "\r\n")


def principal():
    rnd = random.Random(7)
    contas = list(CLASSIF) + ["3.1.1.01.1.01", "3.1.1.01.1.02", "3.1.1.02.1.01",
                              "4.2.1.01.1.01", "4.3.1.01.1.01", "5.1.1.01.1.01"]
    desc = {c: ("(-) Dedução " + c if c.startswith("3.1.1.02") else f"Conta {c} – Serviço ç/ã") for c in contas}
    unids = list(SEGMAP) + ["4801A", "4419A", "5106A", "4402A", "5110A", "5003A", "5103A",
                            "4425A", "4417A", "5002A", "4001A", "DUMMYA"]
    nao_a = [u[:-1] + "S" for u in unids[:30]]
    novas = set(unids[3:6])            # unidades que só começam a lançar em JUN
    out = []
    for rep in range(7):
        for u in unids + nao_a:
            for c in rnd.sample(contas, 55):
                sinal = 1 if c.startswith("3.1.1.01") or c.startswith("4.3") else -1
                base = rnd.uniform(500, 200000)
                p, r = [0.0] * 12, [0.0] * 12
                parada = rnd.random() < .08               # conta que parou de lançar em JUN
                for i in range(12):
                    p[i] = round(sinal * base * rnd.uniform(.8, 1.2), 2) if rnd.random() > .1 else 0.0
                    if i < 8:
                        r[i] = 0.0 if rnd.random() < .12 else round(sinal * base * rnd.uniform(.7, 1.3), 2)
                        if i == 7 and rnd.random() < .45: r[i] = 0.0     # agosto parcial
                        if parada and i >= 5: r[i] = 0.0
                        if u in novas and i < 5: r[i] = 0.0
                        if rnd.random() < .004: r[i] = round(r[i] * 9, 2)  # anomalia
                out.append(linha(c, desc[c], u, f"Unidade {u} – Filial", p, r))
    escreve("plano_sint.csv", out)


def bordas():
    z = [0.0] * 12
    v = [-100.0] * 12
    escreve("so_orcado.csv", [linha("4.1.1.01.1.01", "Desc", "4101A", "U", v, z)])
    # aspa solta no meio do campo (csv.reader trata como literal)
    base = [linha("4.1.1.01.1.0%d" % i, "Desc", "4101A", "U", v, [-90.0] * 8 + [0] * 4) for i in range(1, 5)]
    base[1] = base[1].replace(";Desc;", ';Tubo 1/2" PVC;', 1)
    escreve("aspa_solta.csv", base)
    # números em formato inválido
    ln = linha("4.1.1.01.1.01", "Desc", "4101A", "U", v, [-90.0] * 8 + [0] * 4).split(";")
    ln[9] = "1.234,56-"; ln[11] = "1234.56"; ln[13] = "12,5 D"
    escreve("num_invalido.csv", [";".join(ln)])
    # Realizado antes do Planejado no cabeçalho (colunas trocadas)
    global HDR
    h0 = HDR[:]
    for i in range(12):
        HDR[8 + 2 * i], HDR[9 + 2 * i] = HDR[9 + 2 * i], HDR[8 + 2 * i]
    escreve("cab_trocado.csv", [linha("4.1.1.01.1.01", "Desc", "4101A", "U", v, v)])
    HDR = h0
    # nome com HTML e apóstrofo; unidade e conta fora das tabelas
    escreve("nomes.csv", [linha("4.9.9.99.9.99", 'Conta <img src=x onerror="window.__XSS__=1">',
                                "4999A", "Sant'Ana <b>X</b>", v, [-90.0] * 8 + [0] * 4)])
    # marcação e aspas em TODOS os campos de texto (nomes, descrições e códigos)
    inj = '<i data-inj=1>'
    linhas = []
    for k, (u, c) in enumerate([("44'01A", "4.1.1.01.1.01"), ('44"02A', "4.1.1.01.1.02"),
                                ("4" + inj + "A", "4.1.1.01.1.0" + inj), ("4101A", "4.1.1.02.1.01'x")]):
        for m in range(3):
            conta = c if m == 0 else "4.1.1.04.1.0%d" % (m + 1)
            r = [-90.0] * 8 + [0] * 4
            if m == 1: r[7] = 0.0
            linhas.append(linha(conta, "Conta " + inj + " d'x \"y\"", u, "Unid " + inj + " Sant'Ana \"Z\"", v, r))
    escreve("injecao.csv", linhas)
    # estados de unidade conhecidos: 4101A só começa em JUN; 4102A lança JAN–MAI e para;
    # 4103A lança o ano todo. Duas contas cada, orçadas em todos os meses.
    ests = []
    for u, meses in [("4101A", range(5, 8)), ("4102A", range(0, 5)), ("4103A", range(0, 8))]:
        for c in ["4.1.1.01.1.01", "4.1.1.04.1.01"]:
            ests.append(linha(c, "Desc " + c, u, "Unid " + u, v, [-90.0 if i in meses else 0.0 for i in range(12)]))
    escreve("estados.csv", ests)
    # mesma base em UTF-8
    escreve("utf8.csv", [linha("4.1.1.01.1.01", "Manutenção – veículos", "4101A", "São Paulo", v, v)], enc="utf-8")
    escreve("cp1252.csv", [linha("4.1.1.01.1.01", "Manutenção – veículos", "4101A", "São Paulo", v, v)])


if __name__ == "__main__":
    principal()
    bordas()
    print("ok", TMP)
