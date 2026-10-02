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


def linha(conta, desc, unid, udesc, p, r, cc=None):
    # centro de custo no formato do Plano: 4 dígitos da unidade + 4 do centro (ex.: 41011101)
    cc = cc if cc is not None else unid[:4] + "1101"
    cel = [f'="{conta}"', desc, f'="{unid}"', udesc, '="001"', f'="{cc}"', "Fulano", "X"]
    for i in range(12):
        cel += [fmt(p[i]) if p[i] else "0", fmt(r[i]) if r[i] else "0"]
    return ";".join(cel + ["0", "0"])


# Data fixa de "exportação" dos arquivos (a regra de mês fechado depende dela):
# 15/09/2026 — já passou a semana de ajustes de agosto, então JAN–AGO estão fechados.
DATA_EXPORT = __import__("datetime").datetime(2026, 9, 15, 12, 0).timestamp()


def escreve(nome, linhas, enc="cp1252"):
    caminho = os.path.join(TMP, nome)
    with open(caminho, "w", encoding=enc, newline="") as fh:
        fh.write("\r\n".join([";".join(HDR)] + linhas) + "\r\n")
    os.utime(caminho, (DATA_EXPORT, DATA_EXPORT))


def novas_unificacoes():
    """Unificações do painel atual que o original não tinha (origem -> destino)."""
    rx = r"const _UNIFICAR=(\{.*?\});"
    atual = json.loads(re.search(rx, open(os.path.join(AQUI, "..", "dashboard.html"), encoding="utf-8").read()).group(1))
    orig = json.loads(re.search(rx, html).group(1))
    return {k: v for k, v in atual.items() if orig.get(k) != v}


def principal():
    rnd = random.Random(7)
    contas = list(CLASSIF) + ["3.1.1.01.1.01", "3.1.1.01.1.02", "3.1.1.02.1.01",
                              "4.2.1.01.1.01", "4.3.1.01.1.01", "5.1.1.01.1.01"]
    desc = {c: ("(-) Dedução " + c if c.startswith("3.1.1.02") else f"Conta {c} – Serviço ç/ã") for c in contas}
    unids = list(SEGMAP) + ["4801A", "4419A", "5106A", "4402A", "5110A", "5003A", "5103A",
                            "4425A", "4417A", "5002A", "4001A", "DUMMYA"]
    nao_a = [u[:-1] + "S" for u in unids[:30]]
    novas = set(unids[3:6])            # unidades que só começam a lançar em JUN
    out, out_orig = [], []
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
                cc = u[:4] + ["1101", "1111", "1114", "1123"][(rep + sum(map(ord, c))) % 4]
                out.append(linha(c, desc[c], u, f"Unidade {u} – Filial", p, r, cc))
                d = NOVAS.get(u, u)   # mesma linha já com a unidade de destino (para o painel original)
                # conta fundida leva a descrição do destino (no painel atual a do destino prevalece)
                out_orig.append(linha(c, desc[FUNDIR.get(c, c)], d, f"Unidade {d} – Filial", p, r, cc))
    escreve("plano_sint.csv", out)
    # O painel original não conhece as unificações novas: recebe a base com elas já aplicadas
    # no próprio CSV (mesmo efeito da regra), para a comparação continuar valendo.
    escreve("plano_sint_orig.csv", out_orig)


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
    # ano: no cabeçalho ("JAN/27") ou só no nome do arquivo
    h0 = HDR[:]
    HDR = [c.replace("/2026", "/27") for c in h0]
    escreve("ano_cab.csv", [linha("4.1.1.01.1.01", "Desc", "4101A", "U", v, [-90.0] * 8 + [0] * 4)])
    t27 = __import__("datetime").datetime(2027, 9, 15, 12, 0).timestamp()   # base de 2027 exportada em 2027
    os.utime(os.path.join(TMP, "ano_cab.csv"), (t27, t27))
    HDR = [c.replace("/2026", "") for c in h0]
    escreve("export_plano_2025.csv", [linha("4.1.1.01.1.01", "Desc", "4101A", "U", v, [-90.0] * 8 + [0] * 4)])
    HDR = h0
    # fechamento: realizado JAN–AGO exceto MAI (mês passado sem realizado) + provisão isolada em DEZ
    r = [-90.0] * 8 + [0.0] * 4
    r[4] = 0.0; r[11] = -50.0
    escreve("fechamento.csv", [linha("4.1.1.01.1.01", "Desc", "4101A", "U", v, r),
                               linha("4.1.1.04.1.01", "Desc", "4101A", "U", v, [-90.0] * 4 + [0.0] + [-90.0] * 3 + [0.0] * 4)])
    # unificação: conta orçada em 4420A e lançada em 5111A (mesma unidade, empresas diferentes)
    so_p = [-100.0] * 12
    so_r = [-100.0] * 8 + [0.0] * 4
    escreve("unificacao.csv", [linha("4.1.1.01.1.01", "Desc", "4420A", "Unidade X", so_p, [0.0] * 12),
                               linha("4.1.1.01.1.01", "Desc", "5111A", "Unidade X", [0.0] * 12, so_r),
                               linha("4.1.1.04.1.01", "Desc", "4205A", "Unidade X", so_p, so_r)])
    # fusão PPR: provisão (98) lançada em SET, PPR (99) só orçado; a linha da 98 vem primeiro
    p99 = [-1000.0] * 12
    escreve("fusao.csv", [linha("4.1.1.01.1.98", "Provisão PPR Colaboradores", "4101A", "U", [0.0] * 12, [-400.0] * 8 + [-500.0] + [0.0] * 3),
                          linha("4.1.1.01.1.99", "PPR Colaboradores", "4101A", "U", p99, [-600.0] * 8 + [0.0] * 4)])
    t_out = __import__("datetime").datetime(2026, 10, 1, 9, 0).timestamp()   # setembro em aberto, com dados
    os.utime(os.path.join(TMP, "fusao.csv"), (t_out, t_out))
    # provisão (mês AGO = índice 7; JAN–JUL com realizado para a média):
    #  X 4.1.1.08.1.06 em 4101A: orçado AGO 600 no CC 1101 + 400 no CC 1114, sem realizado em AGO
    #  Y 4.1.1.04.1.06 em 5002A (unificada em 5001A): orçado AGO 1.619,29 no CC 1111, sem realizado
    #  Z 4.1.1.02.1.09 em 4101A: orçado AGO 1000, realizado 700 (abaixo do orçado)
    #  PPR 4.1.1.01.1.99 em 4102A: orçado AGO 500, sem realizado
    def serie(ago_p, ago_r, hist):
        return ([-ago_p] * 12, [-hist] * 7 + [-ago_r] + [0.0] * 4)
    pv = []
    for conta, unid, cc, ago_p, ago_r, hist in [
            ("4.1.1.08.1.06", "4101A", "41011101", 600.0, 0.0, 90.0),
            ("4.1.1.08.1.06", "4101A", "41011114", 400.0, 0.0, 30.0),
            ("4.1.1.04.1.06", "5002A", "50021111", 1619.29, 0.0, 1500.0),
            ("4.1.1.04.1.06", "5001A", "50011111", 0.0, 50.0, 50.0),
            ("4.1.1.02.1.09", "4101A", "41011101", 1000.0, 700.0, 900.0),
            ("4.1.1.01.1.99", "4102A", "41021114", 500.0, 0.0, 480.0)]:
        p_, r_ = serie(ago_p, ago_r, hist)
        pv.append(linha(conta, "Desc " + conta, unid, "Unidade " + unid, p_, r_, cc))
    escreve("provisao.csv", pv)
    # cabeçalho sem nome reconhecível para o centro de custo
    h0 = HDR[:]
    HDR[5] = "Campo 6"
    escreve("provisao_cab.csv", pv)
    HDR = h0
    # periodicidade (orçado 100 todo mês; realizado: T em MAR e JUN; U em FEV e MAI; W JAN–JUL;
    # V sem orçamento e com realizado JAN–AGO, para AGO ser um mês com dados)
    per = []
    for conta, meses_r in [("4.1.1.08.1.06", [2, 5]), ("4.1.1.04.1.06", [1, 4]), ("4.1.1.02.1.09", list(range(7)))]:
        per.append(linha(conta, "Desc " + conta, "4101A", "Unidade 4101A", [-100.0] * 12,
                         [(-100.0 if i in meses_r else 0.0) for i in range(12)]))
    per.append(linha("4.1.1.07.1.01", "Desc V", "4101A", "Unidade 4101A", [0.0] * 12, [-100.0] * 8 + [0.0] * 4))
    escreve("periodo.csv", per)
    # mesma base em UTF-8
    escreve("utf8.csv", [linha("4.1.1.01.1.01", "Manutenção – veículos", "4101A", "São Paulo", v, v)], enc="utf-8")
    escreve("cp1252.csv", [linha("4.1.1.01.1.01", "Manutenção – veículos", "4101A", "São Paulo", v, v)])


NOVAS = novas_unificacoes()
FUNDIR = json.loads(re.search(r"const _FUNDIR=(\{.*?\});", open(os.path.join(AQUI, "..", "dashboard.html"), encoding="utf-8").read()).group(1))

if __name__ == "__main__":
    principal()
    bordas()
    print("ok", TMP)
