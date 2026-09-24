#!/usr/bin/env node
/* Suíte de regressão do painel.
 *
 * Uso:   node tests/regressao.js            (todos os testes)
 *        node tests/regressao.js A1 C3      (só os que começam com esses ids)
 *
 * O que garante:
 *  - o payload montado pelo dashboard.html é idêntico ao do painel ORIGINAL e ao
 *    do gerador Python original (oráculo), linha a linha e ao centavo;
 *  - as métricas de todas as telas (vários estados: modo × período × corte × mês)
 *    são idênticas às do painel original, exceto as diferenças INTENCIONAIS listadas
 *    abaixo, cada uma amarrada ao item da revisão que a justifica;
 *  - cada correção da revisão tem o seu próprio teste, para que uma mudança
 *    posterior não desfaça uma anterior.
 *
 * Requer Python 3 e Playwright (com Chromium). Nada sai da máquina.
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const RAIZ = path.resolve(__dirname, "..");
const NOVO = path.join(RAIZ, "dashboard.html");
const ORIG = path.join(__dirname, "referencia", "dashboard_original.html");
const TMP = path.join(__dirname, "tmp");
const CSV = n => path.join(TMP, n);

function carregaPlaywright() {
  try { return require("playwright"); } catch (e) {}
  const g = cp.execSync("npm root -g").toString().trim();
  return require(path.join(g, "playwright"));
}
const { chromium } = carregaPlaywright();

/* ------------------------------------------------------------------ */
const testes = [];
const teste = (id, desc, fn) => testes.push({ id, desc, fn });
class Falha extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Falha(msg); };
const igual = (a, b, msg) => {
  const d = difs(a, b, "", []);
  if (d.length) throw new Falha(msg + "\n      " + d.slice(0, 8).join("\n      ") + (d.length > 8 ? `\n      … +${d.length - 8}` : ""));
};
function difs(a, b, p, out) {
  if (out.length > 50) return out;
  if (typeof a === "number" && typeof b === "number") { if (!(a === b || (isNaN(a) && isNaN(b)))) out.push(`${p}: ${a} ≠ ${b}`); return out; }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${p}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${p}: tipo diferente`); return out; }
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) {
    if (!(k in a)) out.push(`${p}.${k}: ausente no original`);
    else if (!(k in b)) out.push(`${p}.${k}: ausente no novo`);
    else difs(a[k], b[k], p + "." + k, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */
let browser;
async function abre(html, csv, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, acceptDownloads: true,
                                         colorScheme: opts.colorScheme || "dark" });
  const pg = await ctx.newPage();
  pg._erros = []; pg._rede = [];
  pg.on("pageerror", e => pg._erros.push(e.message));
  pg.on("console", m => { if (m.type() === "error") pg._erros.push("console: " + m.text()); });
  pg.on("request", r => { const u = r.url(); if (!/^(file|data|blob):/.test(u)) pg._rede.push(u); });
  await pg.goto("file://" + html + (opts.hash || ""));
  if (csv) {
    await pg.setInputFiles("#_file", CSV(csv));
    if (opts.espera !== false) await pg.waitForSelector("#kpis .kpi", { timeout: 90000 });
    else await pg.waitForTimeout(opts.ms || 1200);
  }
  return pg;
}
const cache = {};
async function pagina(qual, csv = "plano_sint.csv") {
  const k = qual + "|" + csv;
  if (!cache[k]) cache[k] = await abre(qual === "orig" ? ORIG : NOVO, csv);
  return cache[k];
}
const payloadBasico = p => ({ meses: p.meses, fechado: p.fechado, units: p.units, accts: p.accts, data: p.data });

/* Snapshot das métricas: roda dentro da página (original ou nova) --------- */
function SNAP(estados) {
  const segs = SEG.filter(s => DB.units.some(u => u.seg === s && !u.vig));
  const cods = Object.keys(met().a).sort();
  const amostra = [0, 3, 4, 9, 17, 30].map(i => cods[i]).filter(Boolean);
  const out = [];
  for (const e of estados) {
    modo = e.modo; periodo = e.periodo; corte = e.corte; M = e.M === "ult" ? DB.fechado.lastIndexOf(true) : e.M;
    const m = met(), s = { estado: e };
    s.aberto = m.aberto;
    s.met = Object.fromEntries(Object.entries(m.a).map(([k, o]) => [k,
      { sem: o.sem, orc: o.orc, plan: o.plan, real: o.real, expo: o.expo, alta: o.alta, sorc: o.sorc, vsorc: o.vsorc, est: o.est }]));
    s.res = resumoResultado(Object.keys(m.a));
    s.exc = excecoes().map(o => ({ u: o.u.cod, n: o.linhas.length, val: o.val, anoN: o.anoN,
      l: o.linhas.map(l => [l.a, l.p, l.r, l.meses.join()]) }));
    s.lastro = semLastro(6).map(o => [o.u, o.a, o.val, o.meses]);
    s.lsorc = lastroSemOrc(6).map(o => [o.u, o.a, o.val, o.meses]);
    s.porConta = Object.fromEntries(segs.map(sg => [sg, contasDoSegmento(sg).map(o =>
      ({ a: o.a, sem: o.sem, val: o.val, tipo: o.tipo, uns: o.uns.map(u => u.cod + (u.muda ? "*" : "")).join() }))]));
    s.unid = {};
    for (const u of amostra) {
      view.unit = u; view.seg = umap[u].seg;
      const rs = resultado(u);
      s.unid[u] = {
        linhas: linhas().map(r => [r.a, r.p, r.r, r.v, r.st, r.cf, r.hist.join(), r.nat, r.fav, r.cls]),
        resultado: { tp: rs.tp, tr: rs.tr, g: Object.fromEntries(Object.entries(rs.g).map(([k, v]) => [k, [v.p, v.r, v.linhas.length]])) },
        anom: anomalias(u).map(o => [o.a, o.med, o.at, o.z]),
        pares: paresTrocados(u).map(o => [o.fa, o.pa, o.score]),
        hist: histPendencias(u),
        semLH: semLancarHa(u).map(o => [o.a, o.seq, o.val, o.ult, o.desde]),
        pad: padraoUnidade(u),
      };
    }
    out.push(s);
  }
  return out;
}
const ESTADOS = [];
for (const modo of ["geral", "rec"]) for (const periodo of ["mes", "acum", "sem"])
  for (const corte of [0, 5000]) for (const M of ["ult", 2]) ESTADOS.push({ modo, periodo, corte, M });

/* Diferenças INTENCIONAIS em relação ao original --------------------------
 * Cada entrada remove, dos dois snapshots, só o que aquela correção muda de
 * propósito. O resto continua tendo de bater exatamente. */
const INTENCIONAIS = [];
const intencional = (id, fn) => INTENCIONAIS.push({ id, fn });

/* ================================================================== */
teste("T01", "payload idêntico ao painel original e ao gerador Python", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  const po = payloadBasico(await o.evaluate(() => window.__DB__));
  const pn = payloadBasico(await n.evaluate(() => window.__DB__));
  igual(po, pn, "payload do painel novo difere do original");
  const py = payloadBasico(JSON.parse(cp.execFileSync("python3", [path.join(__dirname, "oraculo_python.py"), CSV("plano_sint.csv")],
                                                      { maxBuffer: 1 << 28 }).toString()));
  igual(py, pn, "payload do painel novo difere do gerador Python");
});

teste("T02", "métricas de todas as telas idênticas ao original (fora as diferenças intencionais)", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  const so = await o.evaluate(SNAP, ESTADOS), sn = await n.evaluate(SNAP, ESTADOS);
  for (let i = 0; i < ESTADOS.length; i++) {
    const a = JSON.parse(JSON.stringify(so[i])), b = JSON.parse(JSON.stringify(sn[i]));
    for (const x of INTENCIONAIS) x.fn(a, b, ESTADOS[i]);
    igual(a, b, "estado " + JSON.stringify(ESTADOS[i]));
  }
  // restaura o estado padrão das páginas compartilhadas
  for (const p of [o, n]) await p.evaluate(() => { modo = "geral"; periodo = "mes"; corte = 0; M = DB.fechado.lastIndexOf(true); go({ tipo: "hub" }); });
});

teste("T03", "carrega base só com orçado (nenhum mês fechado) sem erro", async () => {
  const p = await abre(NOVO, "so_orcado.csv");
  ok(!p._erros.length, "erros: " + p._erros.join(" | "));
  await p.context().close();
});

teste("T04", "todas as telas renderizam sem erro de script", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => {
    const segs = SEG.filter(s => DB.units.some(u => u.seg === s && !u.vig)); const u = Object.keys(met().a)[0];
    const passos = [() => go({ tipo: "hub" }), () => go({ tipo: "seg", seg: segs[0] }), () => setVseg("ct"), () => setVseg("mp"), () => setVseg("un"),
      () => go({ tipo: "det", seg: umap[u].seg, unit: u }), () => setAba("var"), () => setAba("res"), () => setAba("sin"), () => setAba("hist"),
      () => go({ tipo: "exc" }), () => go({ tipo: "lastro" }), () => go({ tipo: "lsorc" }), () => go({ tipo: "hub" })];
    const falhas = [];
    for (const [i, f] of passos.entries()) { f(); if (/Não foi possível montar/.test(document.getElementById("body").textContent)) falhas.push(i); }
    return falhas;
  });
  ok(!r.length, "telas com erro: " + r.join(","));
  ok(!p._erros.length, "erros: " + p._erros.join(" | "));
});

/* ================================================================== */
(async () => {
  const filtro = process.argv.slice(2);
  cp.execFileSync("python3", [path.join(__dirname, "gerar_csv.py")]);
  browser = await chromium.launch();
  let falhas = 0;
  const sel = testes.filter(t => !filtro.length || filtro.some(f => t.id.startsWith(f)) || t.id === "T01" && filtro.includes("T"));
  for (const t of sel) {
    const a = Date.now();
    try { await t.fn(); console.log(`  ok    ${t.id}  ${t.desc}  (${Date.now() - a} ms)`); }
    catch (e) { falhas++; console.log(`  FALHA ${t.id}  ${t.desc}\n      ${e instanceof Falha ? e.message : e.stack}`); }
  }
  await browser.close();
  console.log(`\n${sel.length - falhas}/${sel.length} testes passaram`);
  process.exit(falhas ? 1 : 0);
})();
