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
  // o original recebe a mesma base com as unificações novas já aplicadas no CSV
  if (qual === "orig" && csv === "plano_sint.csv") csv = "plano_sint_orig.csv";
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
      ({ a: o.a, res: ehResultado(o.a), sem: o.sem, val: o.val, tipo: o.tipo, uns: o.uns.map(u => u.cod + (u.muda ? "*" : "")).join() }))]));
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
// A4: "muda" (parou de lançar) só olha meses ANTERIORES. Unidades que eram "muda" só por
// lançarem depois viram "inativa": aceita essa transição (e o que depende dela) e mais nada.
intencional("A4", (o, n) => {
  let houve = false;
  for (const u in o.met) if (o.met[u].est === "muda" && n.met[u] && n.met[u].est === "inativa") {
    houve = true; for (const k of ["est", "sem", "expo", "alta"]) { delete o.met[u][k]; delete n.met[u][k]; }
    if (o.unid[u]) { o.unid[u].linhas.forEach(l => l[4] = "?"); n.unid[u].linhas.forEach(l => l[4] = "?"); }
  }
  if (houve) { delete o.porConta; delete n.porConta; }
  for (const u in o.unid) { let mud = false;
    n.unid[u].hist.forEach(x => { if (x && x.inativa) mud = true; if (x) delete x.inativa; });   // campo novo
    o.unid[u].hist.forEach((m, i) => { const x = n.unid[u].hist[i]; if (m && x && m.muda && !x.muda) { o.unid[u].hist[i] = n.unid[u].hist[i] = "A4"; mud = true; } });
    if (mud) { delete o.unid[u].pad; delete n.unid[u].pad; } }
});
// A6: nos modos Acum./Sem. a confiança passou a olhar os meses ANTES do período
intencional("A6", (o, n, e) => {
  if (e.periodo === "mes") return;
  for (const u in o.met) { delete o.met[u].alta; if (n.met[u]) delete n.met[u].alta; }
  for (const u in o.unid) for (const s of [o.unid[u], n.unid[u]]) s.linhas.forEach(l => { l[5] = l[6] = "A6"; });
});
// A12: "há mais tempo sem lançamento" e a tendência param no mês analisado
intencional("A12", (o, n, e) => { if (e.M === "ult") return;
  for (const u in o.unid) for (const s of [o.unid[u], n.unid[u]]) { delete s.semLH; delete s.pad; } });
// A15: margem acima de ±1000% (receita desprezível) passou a ser "—"
intencional("A15", (o, n) => { for (const k of ["margem", "margemP"]) if (o.res[k] != null && Math.abs(o.res[k]) > 1000) o.res[k] = null; });
// A3: "Por conta" deixou de listar receita/dedução como falha
intencional("A3", (o, n) => { for (const sg in o.porConta) o.porConta[sg] = o.porConta[sg].filter(x => !x.res); });

/* ================================================================== */
teste("T01", "payload idêntico ao painel original e ao gerador Python", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  const po = payloadBasico(await o.evaluate(() => window.__DB__));
  const pn = payloadBasico(await n.evaluate(() => window.__DB__));
  igual(po, pn, "payload do painel novo difere do original");
  // Python lê a mesma base que o original (unificações e descrição das contas fundidas já aplicadas no CSV)
  const py = payloadBasico(JSON.parse(cp.execFileSync("python3", [path.join(__dirname, "oraculo_python.py"), CSV("plano_sint_orig.csv")],
                                                      { maxBuffer: 1 << 28 }).toString()));
  igual(py, pn, "payload do painel novo difere do gerador Python");
});

teste("T02", "métricas de todas as telas idênticas ao original (fora as diferenças intencionais)", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  try {
    const so = await o.evaluate(SNAP, ESTADOS), sn = await n.evaluate(SNAP, ESTADOS);
    for (let i = 0; i < ESTADOS.length; i++) {
      const a = JSON.parse(JSON.stringify(so[i])), b = JSON.parse(JSON.stringify(sn[i]));
      for (const x of INTENCIONAIS) x.fn(a, b, ESTADOS[i]);
      igual(a, b, "estado " + JSON.stringify(ESTADOS[i]));
    }
  } finally {   // restaura o estado padrão das páginas compartilhadas
    for (const p of [o, n]) await p.evaluate(() => { modo = "geral"; periodo = "mes"; corte = 0; M = DB.fechado.lastIndexOf(true); go({ tipo: "hub" }); });
  }
});

/* Texto visível das telas (estado padrão) — pega mudanças acidentais de renderização */
function TELAS() {
  const segs = SEG.filter(s => DB.units.some(u => u.seg === s && !u.vig));
  const cods = Object.keys(met().a).sort(), un = [cods[0], cods[4], cods[17]];
  const passos = [["hub", () => go({ tipo: "hub" })], ["exc", () => go({ tipo: "exc" })], ["lastro", () => go({ tipo: "lastro" })], ["lsorc", () => go({ tipo: "lsorc" })]];
  segs.forEach(s => passos.push(["seg:" + s, () => go({ tipo: "seg", seg: s })], ["ct:" + s, () => setVseg("ct")], ["mp:" + s, () => setVseg("mp")], ["un:" + s, () => setVseg("un")]));
  un.forEach(u => ["pend", "var", "res", "sin", "hist"].forEach(a => passos.push(["det:" + u + ":" + a, () => { go({ tipo: "det", seg: umap[u].seg, unit: u }); setAba(a); }])));
  const out = {};
  for (const [k, f] of passos) { f(); out[k] = { kpis: document.getElementById("kpis").innerText, body: document.getElementById("body").innerText,
    titulo: document.getElementById("title").innerText, sub: document.getElementById("subtitle").innerText }; }
  go({ tipo: "hub" });
  return out;
}
const TEXTO_INTENCIONAL = [];   // [id, fn(orig, novo, chave)] — normaliza diferenças de texto intencionais
// A15: margem acima de ±1000% vira "—" (faixa de resultado) ou some (aba Resultado)
const MG = "-?\\d{4,}(?:,\\d)?%";
TEXTO_INTENCIONAL.push(["A15", o => { if (!o.body) return;
  o.body = o.body.replace(new RegExp("^" + MG + "$", "gm"), "—").replace(new RegExp("^orç\\. " + MG + "\\n", "gm"), "")
    .replace(new RegExp("\\s*margem " + MG + "( · orçada [^\\n]*)?", "g"), "").replace(new RegExp(" · orçada " + MG, "g"), ""); }]);
// H1: a Visão Geral ganhou a alternância "Por segmento | Por conta" acima dos cards
TEXTO_INTENCIONAL.push(["H1", (o, n, k) => { if (k === "hub" && n.body) n.body = n.body.replace("Por segmento\nPor conta\nSEGMENTOS E UNIDADES\n", ""); }]);
// P1: botão "exportar provisão" ao lado das exportações de segmento e unidade
TEXTO_INTENCIONAL.push(["P1", (o, n) => { if (n.body) n.body = n.body.replace(/\s*exportar provisão/g, ""); if (o.body) o.body = o.body.replace(/(exportar (segmento|unidade))/g, "$1"); }]);
// A11: Exceções ganhou a dica de clique nas contas
TEXTO_INTENCIONAL.push(["A11", (o, n, k) => { if (k === "exc" && n.body) n.body = n.body.replace(/ Clique numa conta para abrir a unidade nela\./g, "").replace(/\nClique numa conta para abrir a unidade nela\./g, ""); }]);
// F2: conta que recebe fusão mostra "· inclui 4.1.1.01.1.98"
TEXTO_INTENCIONAL.push(["F2", (o, n) => { for (const k of ["body", "kpis"]) if (n[k]) n[k] = n[k].replace(/ · inclui 4\.1\.1\.01\.1\.98/g, ""); }]);
// U1: unidade que recebe unificações mostra os códigos somados nela ("· inclui 4417A")
TEXTO_INTENCIONAL.push(["U1", (o, n) => { if (n.kpis) n.kpis = n.kpis.replace(/ · inclui [^\n]*/g, ""); }]);
// A3: a lista "Por conta" mudou (sem receita); os dados dela são conferidos no T02 e no teste A3
TEXTO_INTENCIONAL.push(["A3", (o, n, k) => { if (k.startsWith("ct:")) { delete o.body; delete n.body; } }]);
// A4: mapa e histórico mudam para unidades que ainda não tinham começado a lançar (conferido no T02 e no A4)
TEXTO_INTENCIONAL.push(["A4", (o, n, k) => { if (k.startsWith("mp:") || /^det:.*:hist$/.test(k)) { delete o.body; delete n.body; } }]);
// I1: símbolos de texto usados como ícone (▸ ▾ ⚠ →, ▲ ▼ de ordenação) viraram SVG; o estado vai para aria-label (não entra no texto copiado)
TEXTO_INTENCIONAL.push(["I1", (o, n) => { for (const k of ["body", "kpis"]) {
  if (o[k]) o[k] = o[k].replace(/[▸▾]/g, "").replace(/⚠ ?/g, "").replace(/ →/g, " ").replace(/[▲▼]/g, "");
 } }]);
// R2: aba Resultado troca o gráfico receita × custo pelo resultado realizado × orçado (notação IBCS);
// os valores do gráfico estão no tooltip e na tabela acima, que continua idêntica
TEXTO_INTENCIONAL.push(["R2", (o, n, k) => { if (!/:res$/.test(k)) return;
  const M = "(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)";
  if (o.body) o.body = o.body.replace(new RegExp("Receita líquida\\s+Custos e despesas\\s+sinal abaixo = resultado do mês(\\n" + M + "\\n[+−])*", "g"), "#GRAF");
  if (n.body) n.body = n.body.replace(/Resultado mês a mês\nRealizado\nOrçado\nVariação \(verde favorável, vermelho desfavorável\)/g, "#GRAF"); }]);
// R2: botão "compacto" na barra da tabela da unidade
TEXTO_INTENCIONAL.push(["R2", (o, n) => { if (n.body) n.body = n.body.replace(/\ncompacto(?=\n)/g, ""); }]);
teste("T05", "texto visível de todas as telas idêntico ao original (estado padrão)", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  const a = await o.evaluate(TELAS), b = await n.evaluate(TELAS);
  for (const k of Object.keys(a)) {
    const x = JSON.parse(JSON.stringify(a[k])), y = JSON.parse(JSON.stringify(b[k] || {}));
    for (const [, fn] of TEXTO_INTENCIONAL) fn(x, y, k);

    if (process.env.DIFTXT && x.body !== y.body) {   // diagnóstico: DIFTXT=1 mostra a 1ª linha diferente
      const A = (x.body || "").split("\n"), B = (y.body || "").split("\n");
      for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { console.log(k, i, JSON.stringify(A.slice(i, i + 3)), "≠", JSON.stringify(B.slice(i, i + 3))); break; } }
    igual(x, y, "tela " + k);
  }
});

/* Snapshot APROVADO: hash de cada métrica em cada estado e do texto de cada tela.
 * Mudança intencional → rodar `node tests/regressao.js --aprovar` e commitar o
 * tests/referencia/snapshot_aprovado.json junto com a mudança, explicando o porquê. */
const APROVADO = path.join(__dirname, "referencia", "snapshot_aprovado.json");
const hash = o => require("crypto").createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
async function snapshotAtual() {
  const n = await pagina("novo");
  const padrao = () => { modo = "geral"; periodo = "mes"; corte = 0; M = DB.fechado.lastIndexOf(true); };
  const snaps = await n.evaluate(SNAP, ESTADOS);
  await n.evaluate(`(${padrao})()`); const telas = await n.evaluate(TELAS);
  await n.evaluate(() => { modo = "rec"; periodo = "acum"; corte = 5000; }); const telasAlt = await n.evaluate(TELAS);
  await n.evaluate(`(${padrao})();go({tipo:"hub"})`);
  const out = { metricas: {}, telas: {} };
  snaps.forEach(sn => { const k = JSON.stringify(sn.estado); out.metricas[k] = {};
    for (const [c, v] of Object.entries(sn)) if (c !== "estado") out.metricas[k][c] = hash(v); });
  for (const [k, v] of Object.entries(telas)) out.telas[k] = hash(v);
  for (const [k, v] of Object.entries(telasAlt)) out.telas["rec/acum/5000 " + k] = hash(v);
  return out;
}
teste("T06", "métricas e telas idênticas ao snapshot aprovado", async () => {
  const atual = await snapshotAtual();
  if (process.argv.includes("--aprovar")) { fs.writeFileSync(APROVADO, JSON.stringify(atual, null, 1) + "\n"); console.log("        snapshot aprovado gravado"); return; }
  ok(fs.existsSync(APROVADO), "sem snapshot aprovado: rode com --aprovar");
  if (process.argv.includes("--diff")) {
    const ap = JSON.parse(fs.readFileSync(APROVADO, "utf8")), mud = {};
    for (const g of ["metricas", "telas"]) for (const k of new Set([...Object.keys(ap[g]), ...Object.keys(atual[g])])) {
      if (g === "telas") { if (ap[g][k] !== atual[g][k]) (mud["tela " + k.split(":")[0]] ??= []).push(k); continue; }
      for (const c of new Set([...Object.keys(ap[g][k] || {}), ...Object.keys(atual[g][k] || {})]))
        if ((ap[g][k] || {})[c] !== (atual[g][k] || {})[c]) (mud["métrica " + c] ??= []).push(k);
    }
    for (const [c, ks] of Object.entries(mud)) console.log(`        mudou: ${c} em ${ks.length} estado(s)/tela(s)`);
  }
  igual(JSON.parse(fs.readFileSync(APROVADO, "utf8")), atual, "difere do snapshot aprovado");
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

teste("C0", "offline: nenhuma requisição de rede e CSP bloqueia exfiltração", async () => {
  const p = await pagina("novo");
  ok(!p._rede.length, "requisições externas: " + p._rede.join(", "));
  const html = fs.readFileSync(NOVO, "utf8");
  // única URL externa permitida: o link de exportação do Plano, aberto numa nova aba pelo usuário (navegação, não conexão)
  const PLANO = /var PLANO_PADRAO="https:\/\/plano\.allstrategy\.com\.br\/[^"]*";/;
  ok(PLANO.test(html) && (html.match(/PLANO_PADRAO/g) || []).length === 3 && /window\.open\(planoUrl\(\),"_blank","noopener,noreferrer"\)/.test(html),
     "link do Plano fora do lugar esperado");
  ok(!/https?:\/\/(?!www\.w3\.org|schemas\.openxmlformats\.org)/.test(html.replace(/xmlns(:\w+)?="[^"]+"/g, "").replace(PLANO, "")), "há URL externa no HTML");
  ok(/Content-Security-Policy[^>]+connect-src 'none'/.test(html), "CSP ausente");
  const r = await p.evaluate(async () => { const r = {};
    try { await fetch("https://example.com/?d=1"); r.fetch = "passou"; } catch (e) { r.fetch = "bloqueado"; }
    await new Promise(res => { const i = new Image(); i.onload = () => { r.img = "passou"; res(); }; i.onerror = () => { r.img = "bloqueado"; res(); }; i.src = "https://example.com/x.png"; });
    return r; });
  igual({ fetch: "bloqueado", img: "bloqueado" }, r, "CSP não bloqueou");
  p._erros = p._erros.filter(e => !/example\.com|Content Security Policy/.test(e));
});

/* ---------- carga do CSV ---------- */
const pyPayload = csv => payloadBasico(JSON.parse(cp.execFileSync("python3", [path.join(__dirname, "oraculo_python.py"), CSV(csv)], { maxBuffer: 1 << 28 }).toString()));
async function carrega(csv, html = NOVO) {
  const p = await abre(html, csv, { espera: false, ms: 1500 });
  const r = await p.evaluate(() => ({ db: window.__DB__ || null, ov: !!document.getElementById("_ov"), msg: (document.getElementById("_msg") || {}).textContent || "" }));
  r.erros = p._erros; await p.context().close(); return r;
}

teste("A1", "aspa solta no meio do campo é literal (como no csv.reader) e não engole linhas", async () => {
  const r = await carrega("aspa_solta.csv");
  ok(r.db, "não carregou: " + r.msg);
  igual(pyPayload("aspa_solta.csv"), payloadBasico(r.db), "difere do Python");
  ok(r.db.carga.usadas === 4, "linhas usadas: " + r.db.carga.usadas);
  ok(r.db.accts.some(a => a.desc === 'Tubo 1/2" PVC'), "descrição com aspa perdida");
});

teste("A9", "número fora do formato pt-BR converte igual ao Python e é reportado", async () => {
  const r = await carrega("num_invalido.csv");
  ok(r.db, "não carregou: " + r.msg);
  igual(pyPayload("num_invalido.csv"), payloadBasico(r.db), "difere do Python");
  ok(r.db.carga.invalidos === 3, "inválidos: " + r.db.carga.invalidos);
  igual(["1.234,56-", "1234.56", "12,5 D"], r.db.carga.amostrasInv.map(x => x.valor), "amostras");
});

teste("A10", "cabeçalho com Planejado/Realizado trocados é recusado com mensagem clara", async () => {
  const r = await carrega("cab_trocado.csv");
  ok(!r.db, "carregou uma base com colunas trocadas");
  ok(r.ov && /deveria ser Planejado de JAN/.test(r.msg), "mensagem: " + r.msg);
  const b = await carrega("plano_sint.csv");  // cabeçalho correto continua passando
  ok(b.db && !b.db.carga.cabecalho.erros.length, "cabeçalho correto recusado");
});

teste("A11e", "CSV em UTF-8 e em Windows-1252 dão o mesmo texto", async () => {
  const a = await carrega("utf8.csv"), b = await carrega("cp1252.csv");
  ok(a.db && b.db, "não carregou");
  igual(payloadBasico(b.db), payloadBasico(a.db), "UTF-8 × 1252");
  ok(a.db.accts[0].desc === "Manutenção – veículos" && a.db.carga.encoding === "UTF-8" && b.db.carga.encoding === "Windows-1252", "encoding");
});

teste("A14", "carga robusta: drop fora da área, erro de inicialização e teclado", async () => {
  // 1) soltar o arquivo em qualquer lugar da janela carrega o painel
  let p = await abre(NOVO);
  const txt = fs.readFileSync(CSV("so_orcado.csv"), "latin1");
  const prev = await p.evaluate(t => { const dt = new DataTransfer(); dt.items.add(new File([t], "x.csv"));
    const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }); document.body.dispatchEvent(ev); return ev.defaultPrevented; }, txt);
  ok(prev, "drop fora da área não foi interceptado");
  await p.waitForSelector("#kpis .kpi", { timeout: 10000 });
  await p.context().close();
  // 2) se o app falhar ao iniciar, a tela de carga fica e explica
  p = await abre(NOVO);
  await p.evaluate(() => { document.getElementById("app").textContent = "throw new Error('falha simulada')"; });
  await p.setInputFiles("#_file", CSV("so_orcado.csv")); await p.waitForTimeout(800);
  const st = await p.evaluate(() => ({ ov: !!document.getElementById("_ov"), msg: document.getElementById("_msg").textContent }));
  ok(st.ov && /falha simulada/.test(st.msg), "falha de inicialização: " + JSON.stringify(st));
  await p.context().close();
  // 3) teclado: o foco fica no seletor de arquivo; o painel por trás não recebe foco
  p = await abre(NOVO);
  const focos = [];
  for (let i = 0; i < 6; i++) { await p.keyboard.press("Tab");
    focos.push(await p.evaluate(() => { const a = document.activeElement; return a === document.body || !!a.closest("#_ov") ? "ov" : (a.id || a.tagName); })); }
  ok(focos.every(f => f === "ov"), "Tab saiu da tela de carga: " + focos);
  await p.context().close();
});

teste("B1", "processamento da base de ~12 MB mais rápido que o original", async () => {
  const txt = new TextDecoder("windows-1252").decode(fs.readFileSync(CSV("plano_sint.csv")));
  // alterna original e novo (melhor de 5 de cada) para a variação da máquina pesar igual nos dois
  const [po, pn] = [await pagina("orig"), await pagina("novo")];
  // semCC: sem o detalhamento por centro de custo (que o original não fazia), para comparar o mesmo trabalho
  const uma = (p, semCC) => p.evaluate(([t, semCC]) => {
    if (!semCC) { const a = performance.now(); construirPayload(t); return performance.now() - a; }
    const cc = window._colunaCC, cand = _CC_CANDIDATAS.slice();
    window._colunaCC = () => null; _CC_CANDIDATAS.length = 0;
    try { const a = performance.now(); construirPayload(t); return performance.now() - a; }
    finally { window._colunaCC = cc; _CC_CANDIDATAS.push(...cand); } }, [txt, semCC]);
  let o = Infinity, n = Infinity, s = Infinity;
  for (let k = 0; k < 5; k++) { o = Math.min(o, await uma(po, false)); s = Math.min(s, await uma(pn, true)); n = Math.min(n, await uma(pn, false)); }
  console.log(`        processamento: original ${o.toFixed(0)} ms · novo ${s.toFixed(0)} ms (com detalhe por CC ${n.toFixed(0)} ms) (${(txt.length / 1e6).toFixed(1)} MB, melhor de 5, alternados)`);
  ok(s < o * 0.85, "o processamento não ficou mais rápido");
  ok(n < o, "com o detalhe por CC ficou mais lento que o original");
});

teste("A7", "carimbo usa a data do arquivo e avisa base velha", async () => {
  const velho = CSV("base_velha.csv");
  fs.copyFileSync(CSV("so_orcado.csv"), velho);
  const t = (Date.now() - 60 * 86400000) / 1000; fs.utimesSync(velho, t, t);
  let p = await abre(NOVO, "base_velha.csv");
  let g = await p.evaluate(() => document.getElementById("gerado").innerText);
  ok(/base_velha\.csv/.test(g) && /Arquivo de/.test(g) && /há 60 dias/.test(g), "carimbo: " + g);
  await p.context().close();
  const nova = CSV("base_nova.csv"); fs.copyFileSync(CSV("so_orcado.csv"), nova);
  const agora = Date.now() / 1000; fs.utimesSync(nova, agora, agora);
  p = await abre(NOVO, "base_nova.csv");
  g = await p.evaluate(() => document.getElementById("gerado").innerText);
  ok(!/desatualizado/.test(g), "base nova marcada como velha: " + g);
  await p.context().close();
});

teste("D2", "resumo da carga: conciliação e avisos", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => { abreCarga(); const t = document.getElementById("guia").innerText; fechaGuia();
    let real = 0; DB.data.forEach(d => real += d.r[7]);
    return { t, real: fmtC(real), usadas: DB.carga.usadas, ign: DB.carga.naoA + DB.carga.dummy + DB.carga.semConta + DB.carga.vazias, linhas: DB.carga.linhas }; });
  ok(r.t.includes(r.real), "total de AGO ausente do resumo");
  ok(/Nome\s+plano_sint\.csv/.test(r.t) && /Aproveitadas \(família A\)\s+[\d.]+/.test(r.t), "rótulo e valor colados no resumo");
  ok(r.usadas + r.ign === r.linhas, "linhas não fecham: " + JSON.stringify(r));
  const q = await abre(NOVO, "num_invalido.csv");
  const aberto = await q.evaluate(() => document.getElementById("guia").classList.contains("on") && document.getElementById("guia").innerText);
  ok(aberto && /1\.234,56-/.test(aberto) && /3 célula/.test(aberto), "avisos não abriram sozinhos");
  const bt = await q.evaluate(() => document.getElementById("bcarga").textContent);
  ok(/aviso/.test(bt), "selo de aviso ausente: " + bt);
  await q.context().close();
});

teste("A5", "texto do CSV nunca vira HTML/JS (nomes, descrições e códigos com < ' \")", async () => {
  const p = await abre(NOVO, "injecao.csv");
  const r = await p.evaluate(async () => {
    const achados = [];
    const confere = onde => {
      if (document.querySelector("[data-inj]")) achados.push("elemento injetado em " + onde);
      document.querySelectorAll("[data-tip]").forEach(el => { if (/<i data-inj/i.test(decodeURIComponent(el.dataset.tip))) achados.push("tooltip em " + onde); });
      document.querySelectorAll("[onclick]").forEach(el => { try { new Function(el.getAttribute("onclick")); } catch (e) { achados.push("onclick inválido em " + onde + ": " + el.getAttribute("onclick").slice(0, 60)); } });
    };
    const segs = [...new Set(DB.units.map(u => u.seg))];
    const telas = [["hub", () => go({ tipo: "hub" })], ["exc", () => go({ tipo: "exc" })], ["lastro", () => go({ tipo: "lastro" })], ["lsorc", () => go({ tipo: "lsorc" })]];
    segs.filter(s => s !== "Vigiada").forEach(s => telas.push(["seg " + s, () => go({ tipo: "seg", seg: s })], ["ct " + s, () => { setVseg("ct"); const c = contasDoSegmento(s)[0]; if (c) toggleConta(c.a); }], ["mp " + s, () => setVseg("mp")], ["un", () => setVseg("un")]));
    DB.units.filter(u => !u.vig).forEach(u => ["pend", "var", "res", "sin", "hist"].forEach(a => telas.push(["det " + u.cod + " " + a, () => { go({ tipo: "det", seg: u.seg, unit: u.cod }); setAba(a); setF("todos"); toggleExp(linhas()[0] && linhas()[0].a); }])));
    for (const [nome, f] of telas) { f(); confere(nome); }
    abrePal(); montaPal("conta"); confere("busca global"); montaPal("unid"); confere("busca global unidades"); fechaPal();
    abreCarga(); confere("resumo da carga"); fechaGuia();
    return { achados: [...new Set(achados)].slice(0, 10), xss: !!window.__XSS__ };
  });
  ok(!r.xss && !r.achados.length, r.achados.join("\n      "));
  // a busca da unidade aceita aspas sem quebrar o campo
  const v = await p.evaluate(() => { const u = DB.units.find(u => !u.vig); go({ tipo: "det", seg: u.seg, unit: u.cod });
    view.busca = 'd"x'; renderDet(); return document.getElementById("busca").value; });
  ok(v === 'd"x', "valor da busca: " + v);
  ok(!p._erros.length, p._erros.join(" | "));
  await p.context().close();
});

teste("A2", "tooltip do KPI e hover do Top 10 batem com o número do cartão (todos os modos)", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => {
    const falhas = [];
    for (const m of ["geral", "rec"]) for (const per of ["mes", "acum", "sem"]) for (const c of [0, 5000]) {
      modo = m; periodo = per; corte = c; go({ tipo: "hub" });
      const {a} = met(); let sem = 0; Object.values(a).forEach(o => sem += o.sem);
      if (semLancEscopo().length !== sem) falhas.push(`${m}/${per}/${c}: tooltip ${semLancEscopo().length} × cartão ${sem}`);
      for (const o of Object.values(a)) if (topContasUnidade(o.cod, 10).total !== o.sem) { falhas.push(`${m}/${per}/${c} ${o.cod}: hover ≠ ranking`); break; }
    }
    modo = "geral"; periodo = "mes"; corte = 0; go({ tipo: "hub" });
    return falhas;
  });
  ok(!r.length, r.slice(0, 5).join("; "));
});

teste("A3", "'Por conta' não lista receita nem dedução como falha", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => { const out = [];
    SEG.forEach(s => { contasDoSegmento(s).forEach(o => { if (ehResultado(o.a)) out.push(s + ":" + o.a); }); });
    const s = SEG.find(s => DB.units.some(u => u.seg === s && !u.vig)); go({ tipo: "seg", seg: s }); setVseg("ct");
    const txt = document.getElementById("body").innerText; setVseg("un"); go({ tipo: "hub" });
    DB.accts.filter(a => ["rec", "ded"].includes(a.nat)).forEach(a => { if (txt.includes(a.cod)) out.push("tela:" + a.cod); });
    return out; });
  ok(!r.length, r.join(", "));
});

teste("A4", "'parou de lançar' só considera meses ANTERIORES ao analisado", async () => {
  const p = await abre(NOVO, "estados.csv");
  const r = await p.evaluate(() => {
    const est = mm => { M = mm; periodo = "mes"; return Object.fromEntries(Object.entries(met().a).map(([k, o]) => [k, o.est])); };
    const hist = c => histPendencias(c).slice(0, 8).map(m => m.muda ? "M" : "-").join("");
    const mar = est(2); go({ tipo: "hub" }); const alertaMar = !!document.querySelector(".alerta");
    const ago = est(7); go({ tipo: "hub" }); const alertaAgo = (document.querySelector(".alerta") || {}).innerText || "";
    return { mar, ago, alertaMar, alertaAgo, h1: hist("4101A"), h2: hist("4102A"), h3: hist("4103A"),
             cm: contasDoMes("4101A", 2).length, cm2: contasDoMes("4102A", 6).length,
             pad1: (M = 7, padraoUnidade("4101A").tipo), pad1t: padraoUnidade("4101A").txt };
  });
  igual({ "4101A": "inativa", "4102A": "ativa", "4103A": "ativa" }, r.mar, "estado em MAR");
  igual({ "4101A": "ativa", "4102A": "muda", "4103A": "ativa" }, r.ago, "estado em AGO");
  ok(!r.alertaMar, "alerta 'parou de lançar' em MAR para unidade que ainda não tinha começado");
  ok(/Unid 4102A/.test(r.alertaAgo) && !/4101A/.test(r.alertaAgo), "alerta em AGO: " + r.alertaAgo);
  igual({ h1: "--------", h2: "-----MMM", h3: "--------" }, { h1: r.h1, h2: r.h2, h3: r.h3 }, "histórico 'não lançou nada'");
  // meses antes de a unidade começar não entram na tendência como "zero pendências"
  ok(r.pad1 === "limpa" && r.pad1t === "sem pendências no período", "tendência da unidade nova: " + r.pad1 + " " + r.pad1t);
  ok(r.cm === 0 && r.cm2 === 2, "contasDoMes: " + r.cm + "/" + r.cm2);
  await p.context().close();
});

teste("A6", "confiança nos modos Acum./Sem. usa os meses anteriores ao período", async () => {
  const p = await abre(NOVO, "estados.csv");
  const r = await p.evaluate(() => {
    M = 7; const cf = per => { periodo = per; const d = DB.data.find(d => d.u === "4102A"); return confDe(d); };
    const out = { mes: cf("mes"), sem: cf("sem"), acum: cf("acum") };
    periodo = "acum"; go({ tipo: "hub" }); out.sub = document.querySelectorAll(".kpi .sub")[2].textContent;
    periodo = "mes"; return out; });
  // 4102A lançou JAN–MAI e parou: em AGO e no 2º semestre é "lançava todo mês"; no acumulado não há mês anterior
  igual({ mes: "media", sem: "alta", acum: "nd" }, { mes: r.mes, sem: r.sem, acum: r.acum }, "confiança");
  ok(/sem histórico/.test(r.sub), "subtítulo no acumulado: " + r.sub);
  await p.context().close();
});

teste("A12", "'há mais tempo sem lançamento' e tendência respeitam o mês selecionado", async () => {
  const p = await abre(NOVO, "estados.csv");
  const r = await p.evaluate(() => { periodo = "mes";
    const s = m => { M = m; return semLancarHa("4102A").map(o => o.seq + " desde " + o.desde).join(); };
    return { ago: s(7), mai: s(4) }; });
  igual({ ago: "3 desde JUN,3 desde JUN", mai: "" }, r, "4102A lançou até MAI");
  await p.context().close();
});

async function baixa(p, fn) {
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), p.evaluate(fn)]);
  const f = path.join(TMP, dl.suggestedFilename()); await dl.saveAs(f);
  return { nome: dl.suggestedFilename(), abas: JSON.parse(cp.execFileSync("python3", [path.join(__dirname, "le_xlsx.py"), f], { maxBuffer: 1 << 28 }).toString()) };
}
teste("A13", "exportação: centavos, contagens que fecham e unidade sem pendência", async () => {
  const p = await pagina("novo");
  const x = await baixa(p, () => { corte = 5000; exportGeral(); });
  const res = x.abas["Resumo"], cab = res[3], iSem = cab.indexOf("Contas sem lancamento");
  const falhas = [];
  res.slice(4).forEach(l => { const soma = l[iSem + 1] + l[iSem + 2] + l[iSem + 3] + l[iSem + 4]; if (soma !== l[iSem]) falhas.push(l[1] + ": " + soma + "≠" + l[iSem]); });
  ok(!falhas.length, "colunas de confiança não somam 'Contas sem lançamento': " + falhas.slice(0, 3));
  for (const [aba, ls] of Object.entries(x.abas)) for (const l of ls) for (const v of l)
    if (typeof v === "number" && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) { falhas.push(aba + ": " + v); break; }
  ok(!falhas.length, "valor com mais de 2 casas: " + falhas.slice(0, 3));
  ok(!/Z?\d{4}-\d{2}-\d{2}/.test(x.nome) || x.nome.includes(await p.evaluate(() => hoje())), "data do arquivo");
  const y = await baixa(p, () => { corte = 0; const o = Object.values(met().a).find(o => o.sem === 0) || Object.values(met().a)[0];
    view.unit = o.cod; view.seg = o.seg; exportUnidade(); });
  ok(Object.keys(y.abas).length === 2, "unidade exportada sozinha sem a aba dela: " + Object.keys(y.abas));
  const l = await baixa(p, () => exportLastro());
  const vals = l.abas["Sem lastro"].slice(4).map(r => r[7]);
  ok(vals.some(v => v % 1 !== 0), "lastro exportado sem centavos");
  await p.evaluate(() => { corte = 0; go({ tipo: "hub" }); });
});

teste("A11", "Exceções: clicar na conta abre a unidade vigiada nela; detalhe da vigiada funciona", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => {
    go({ tipo: "exc" });
    const tr = document.querySelector(".exT tbody tr[onclick]");
    if (!tr) return { erro: "linhas de Exceções sem clique" };
    const conta = tr.querySelector("td").textContent.trim(); tr.click();
    const out = { tipo: view.tipo, vig: !!(umap[view.unit] || {}).vig, busca: view.busca, filtro: view.filtro,
      linhas: [...document.querySelectorAll(".tw tbody tr.lin td:first-child")].map(td => td.textContent.replace(/[▸▾]/g, "").trim()),
      kpis: [...document.querySelectorAll(".kpi .lbl")].map(x => x.textContent).join("|"),
      crumb: document.getElementById("crumb").textContent };
    out.contaOk = out.linhas.length >= 1 && out.linhas.includes(conta);
    let erro = null; try { exportUnidade(); } catch (e) { erro = e.message; } out.erroExp = erro;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); out.volta = view.tipo;
    go({ tipo: "hub" }); return out; });
  ok(!r.erro, r.erro);
  ok(r.tipo === "det" && r.vig && r.filtro === "todos" && r.contaOk, "não abriu a vigiada na conta: " + JSON.stringify(r));
  ok(/Contas com movimento/.test(r.kpis) && /Exceções/.test(r.crumb), "detalhe da vigiada: " + r.kpis + " | " + r.crumb);
  ok(r.erroExp === null && r.volta === "exc", "exportação/Esc: " + JSON.stringify({ e: r.erroExp, v: r.volta }));
  // a exportação da vigiada gera a aba da unidade
  const x = await baixa(p, () => { const v = DB.units.find(u => u.vig); view.tipo = "det"; view.unit = v.cod; view.seg = v.seg; exportUnidade(); });
  ok(Object.keys(x.abas).length === 2, "exportação da vigiada: " + Object.keys(x.abas));
  await p.evaluate(() => go({ tipo: "hub" }));
});

/* Auditoria de contraste WCAG: todo texto visível, com fundo efetivo (camadas
 * translúcidas compostas) e opacidade herdada. Mínimo 4,5:1 (3:1 para texto grande). */
function AUDITA_CONTRASTE(limite) {
  const rgba = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
  const sobre = (c, b) => [0, 1, 2].map(i => c[i] * c[3] + b[i] * (1 - c[3])).concat(1);
  const L = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const fundo = el => { const pilha = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) pilha.push(c); if (c && c[3] === 1) break; }
    let b = [255, 255, 255, 1]; for (let i = pilha.length - 1; i >= 0; i--) b = sobre(pilha[i], b); return b; };
  const opac = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (!el || el.closest("[aria-hidden=true],.hidden,script,style,#_ov")) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === "hidden" || el.closest(".tip") && getComputedStyle(el.closest(".tip")).display === "none") continue;
    const bg = fundo(el), o = opac(el); let fg = rgba(cs.color); fg = [fg[0], fg[1], fg[2], fg[3] * o];
    const c = cr(sobre(fg, bg), bg), px = parseFloat(cs.fontSize), grande = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    const min = grande ? 3 : limite;
    if (px < 10.99) out.push(`fonte ${px}px "${n.textContent.trim().slice(0, 24)}" <${el.tagName.toLowerCase()} class="${el.className}">`);
    if (c < min - 0.01) out.push(`${c.toFixed(2)}:1 ${px}px "${n.textContent.trim().slice(0, 24)}" <${el.tagName.toLowerCase()} class="${el.className}">`);
  }
  return [...new Set(out)];
}
async function auditaTelas(p, limite = 4.5) {
  await p.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
  return p.evaluate(lim => {
    const res = {};
    const segs = SEG.filter(s => DB.units.some(u => u.seg === s && !u.vig)), u = Object.keys(met().a)[4];
    const passos = [["hub", () => go({ tipo: "hub" })], ["seg", () => go({ tipo: "seg", seg: segs[1] })], ["hubct", () => { go({ tipo: "hub" }); setVhub("ct"); hubFiltro("seg", segs[0]); toggleContaHub(contasHubFiltradas()[0].a); }],
      ["ct", () => { hubFiltro("limpar"); setVhub("seg"); go({ tipo: "seg", seg: segs[1] }); setVseg("ct"); toggleConta(contasDoSegmento(segs[1])[0].a); }], ["mp", () => setVseg("mp")],
      ["det", () => { setVseg("un"); go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos"); toggleExp(linhas()[0].a); }], ["det-var", () => setAba("var")], ["det-res", () => setAba("res")], ["det-sin", () => setAba("sin")], ["det-hist", () => setAba("hist")],
      ["exc", () => go({ tipo: "exc" })], ["lastro", () => go({ tipo: "lastro" })], ["lsorc", () => go({ tipo: "lsorc" })],
      ["tooltip", () => { go({ tipo: "hub" }); const k = document.querySelectorAll(".kpi")[1]; k.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 300, clientY: 200 })); }],
      ["busca", () => { document.querySelector(".tip").style.display = "none"; abrePal(); montaPal("conta"); }], ["guia", () => { fechaPal(); abreGuia(); }], ["carga", () => { fechaGuia(); abreCarga(); }]];
    for (const [k, f] of passos) { f(); const a = eval("(" + window.__AUDITA__ + ")")(lim); if (a.length) res[k] = a; }
    fechaGuia(); go({ tipo: "hub" });
    return res;
  }, limite);
}
teste("C6", "C1/C2/C6: contraste WCAG AA e fonte ≥ 11px em todas as telas, temas escuro e claro, desktop e celular", async () => {
  const falhas = [];
  for (const [tema, vp] of [["escuro"], ["claro"], ["escuro", 390], ["claro", 390]]) {
    const p = await abre(NOVO, "plano_sint.csv", vp ? { viewport: { width: vp, height: 844 } } : {});
    await p.evaluate(([t, f]) => { window.__AUDITA__ = f; if (t === "claro") document.body.classList.add("claro"); else document.body.classList.remove("claro"); }, [tema, AUDITA_CONTRASTE.toString()]);
    const r = await auditaTelas(p);
    for (const [k, v] of Object.entries(r)) falhas.push(`[${tema}${vp ? " celular" : ""}/${k}] ${v.length} texto(s): ` + v.slice(0, 4).join(" · "));
    await p.context().close();
  }
  ok(!falhas.length, falhas.join("\n      "));
});

teste("C8", "celular: barra do topo mostra a tela atual", async () => {
  const p = await abre(NOVO, "plano_sint.csv", { viewport: { width: 390, height: 844 } });
  const r = await p.evaluate(() => { const s = SEG.find(s => DB.units.some(u => u.seg === s && !u.vig)); go({ tipo: "seg", seg: s });
    const a = [document.getElementById("title").textContent, document.getElementById("tbtitulo").textContent];
    const u = Object.keys(met().a)[0]; go({ tipo: "det", seg: umap[u].seg, unit: u });
    return [a, [document.getElementById("title").textContent, document.getElementById("tbtitulo").textContent]]; });
  ok(r[0][0] === r[0][1] && r[1][0] === r[1][1], JSON.stringify(r));
  await p.context().close();
});

teste("C9", "cabeçalho da tabela fica visível ao rolar a lista", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => { const u = Object.keys(met().a)[0]; go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos");
    const tw = document.querySelector(".tw"); tw.scrollTop = 400;
    const d = tw.querySelector("thead th").getBoundingClientRect().top - tw.getBoundingClientRect().top;
    const rolou = tw.scrollTop; go({ tipo: "hub" }); return { d, rolou }; });
  ok(r.rolou > 0 && Math.abs(r.d) <= 2, JSON.stringify(r));
});

teste("C10", "CSS íntegro: nenhuma regra perdida por chave solta", async () => {
  const p = await pagina("novo");
  const css = fs.readFileSync(NOVO, "utf8").match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
  ok((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, "chaves desbalanceadas no CSS");
  const r = await p.evaluate(() => { const sels = []; const f = rs => [...rs].forEach(x => { if (x.selectorText) sels.push(x.selectorText); if (x.cssRules) f(x.cssRules); });
    f(document.styleSheets[0].cssRules); return { xbtn: sels.includes(".xbtn"), bg: getComputedStyle(document.querySelector(".xbtn")).borderStyle }; });
  ok(r.xbtn && r.bg === "solid", "regra .xbtn: " + JSON.stringify(r));
});

teste("C11", "cores de segmento acompanham o tema e a troca de tema redesenha", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => { const esc = cor("CDs"); document.getElementById("btema").click();
    const cla = cor("CDs"), tag = document.querySelector(".card .tag") && document.querySelector(".card .tag").getAttribute("style");
    document.getElementById("btema").click(); return { esc, cla, tag }; });
  ok(r.esc === "#B484DD" && r.cla === "#784F93", JSON.stringify(r));
});

teste("C12", "semântica: h1, rótulos, aria-pressed, tema do sistema, movimento reduzido, tela larga", async () => {
  const p = await abre(NOVO, "so_orcado.csv", { colorScheme: "light", viewport: { width: 2560, height: 1300 } });
  const r = await p.evaluate(() => { const m = document.querySelector("main").getBoundingClientRect(), a = document.querySelector(".app").getBoundingClientRect();
    document.querySelector('#perbar [data-p="acum"]').click();
    return { h1: document.querySelector("h1#title") !== null, label: !!document.querySelector('label[for="mes"]'),
      pressed: [...document.querySelectorAll("#perbar button")].map(b => b.getAttribute("aria-pressed")).join(),
      claro: document.body.classList.contains("claro"), centro: Math.abs((m.left - 230) - (a.right - m.right)) < 4,
      motion: [...document.styleSheets[0].cssRules].some(x => x.conditionText && x.conditionText.includes("prefers-reduced-motion")) }; });
  igual({ h1: true, label: true, pressed: "false,true,false", claro: true, centro: true, motion: true }, r, "semântica");
  await p.context().close();
});

teste("A15", "detalhes: 999,6 mil, margem sem sentido, link com estado, cabeçalho de tabela interna", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => {
    const out = { mi: fmtMi(999600), mg: margemPct(-90, 1), mg2: margemPct(50, 100) };
    const u = Object.keys(met().a)[0]; go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos"); toggleExp(linhas()[0].a);
    const sk = view.sk; document.querySelector("tr.exp thead th").click(); out.sort = view.sk === sk;
    go({ tipo: "hub" }); return out; });
  igual({ mi: "1,0 mi", mg: null, mg2: 50, sort: true }, r, "detalhes");
  const q = await abre(NOVO, "so_orcado.csv", { hash: "#v=lsorc&mes=0" });
  ok(await q.evaluate(() => view.tipo) === "lsorc", "link para 'Lastro sem orçamento' não restaurado");
  await q.context().close();
});

teste("C3", "teclado: tudo que é clicável recebe foco e abre com Enter/Espaço", async () => {
  const p = await abre(NOVO, "plano_sint.csv");
  const semFoco = await p.evaluate(async () => { const segs = SEG.filter(s => DB.units.some(u => u.seg === s && !u.vig)); const out = new Set();
    const u = Object.keys(met().a)[4];
    const telas = [() => go({ tipo: "hub" }), () => setVhub("ct"), () => { toggleContaHub(contasHubFiltradas()[0].a); }, () => setVhub("seg"), () => go({ tipo: "seg", seg: segs[0] }), () => setVseg("ct"), () => setVseg("mp"), () => setVseg("un"),
      () => { go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos"); }, () => go({ tipo: "lastro" }), () => go({ tipo: "exc" })];
    for (const f of telas) { f(); await Promise.resolve(); document.querySelectorAll("[onclick],th[data-k] .thb").forEach(el => { if (el.tabIndex < 0 && !el.closest("[inert]") && el.getBoundingClientRect().width) out.add(el.tagName + "." + el.className.split(" ")[0]); }); }
    go({ tipo: "hub" }); return [...out]; });
  ok(!semFoco.length, "clicáveis sem foco: " + semFoco.join(", "));
  // Tab chega na navegação; Enter abre o segmento; o foco não se perde no <body>
  let foco = "";
  for (let i = 0; i < 20 && !/^A:/.test(foco); i++) { await p.keyboard.press("Tab"); foco = await p.evaluate(() => document.activeElement.tagName + ":" + document.activeElement.textContent.trim().slice(0, 20)); }
  ok(/^A:/.test(foco), "Tab não chegou à navegação: " + foco);
  for (let i = 0; i < 3; i++) await p.keyboard.press("Tab");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.activeElement !== document.body, null, { timeout: 2000 }).catch(() => {});
  let r = await p.evaluate(() => ({ tipo: view.tipo, foco: document.activeElement.id || document.activeElement.tagName }));
  ok(r.tipo === "seg" && r.foco !== "BODY", "Enter na navegação: " + JSON.stringify(r));
  // Espaço num card abre a unidade
  await p.evaluate(() => document.querySelector(".card").focus()); await p.keyboard.press(" ");
  r = await p.evaluate(() => view.tipo); ok(r === "det", "Espaço no card: " + r);
  // aba via teclado mantém o foco na aba
  await p.evaluate(() => document.querySelectorAll(".abas button")[1].focus()); await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.activeElement !== document.body, null, { timeout: 2000 }).catch(() => {});
  r = await p.evaluate(() => ({ aba, foco: document.activeElement.textContent.trim().slice(0, 12) }));
  ok(r.aba === "var" && /Varia/.test(r.foco), "foco após trocar de aba: " + JSON.stringify(r));
  await p.context().close();
});

teste("C4", "tooltip abre por foco do teclado e fecha com Esc/toque fora", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(async () => { go({ tipo: "hub" }); await Promise.resolve(); const k = document.querySelectorAll(".kpi")[1]; k.focus();
    const tip = document.querySelector(".tip"); const aberto = tip.style.display === "block" && tip.textContent.includes("sem lançamento");
    const desc = k.getAttribute("aria-describedby"); k.blur(); const fechou = tip.style.display === "none";
    k.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); const esc = tip.style.display === "none";
    return { foco: k.tabIndex >= 0, aberto, desc, fechou, esc, role: tip.getAttribute("role") }; });
  igual({ foco: true, aberto: true, desc: "tip", fechou: true, esc: true, role: "tooltip" }, r, "tooltip");
  await p.evaluate(() => { document.activeElement.blur(); go({ tipo: "hub" }); });
});

teste("C5", "diálogos: papel, foco inicial, foco preso, Esc e retorno do foco", async () => {
  const p = await abre(NOVO, "so_orcado.csv");
  const r = await p.evaluate(async () => { const out = {};
    const b = document.getElementById("bguia"); b.focus(); b.click();
    const g = document.querySelector("#guia [role=dialog]"); out.guiaRole = !!g && g.getAttribute("aria-modal") === "true";
    out.guiaFoco = !!document.activeElement.closest("#guia"); out.fundoInerte = document.querySelector(".app > main").inert === true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); out.voltou = document.activeElement === b;
    out.fundoLivre = !document.querySelector(".app > main").inert;
    abrePal(); const inp = document.getElementById("palin"); montaPal("a");
    out.palRole = document.querySelector("#pal [role=dialog]") !== null && inp.getAttribute("role") === "combobox" && !!inp.getAttribute("aria-label");
    out.ativo = inp.getAttribute("aria-activedescendant") === document.querySelector(".palit.sel").id && document.querySelector(".palit.sel").getAttribute("aria-selected") === "true";
    fechaPal(); return out; });
  igual({ guiaRole: true, guiaFoco: true, fundoInerte: true, voltou: true, fundoLivre: true, palRole: true, ativo: true }, r, "diálogos");
  // foco preso no diálogo
  await p.evaluate(() => abreGuia());
  for (let i = 0; i < 12; i++) await p.keyboard.press("Tab");
  ok(await p.evaluate(() => !!document.activeElement.closest("#guia")), "Tab saiu do diálogo");
  await p.keyboard.press("Escape");
  // menu lateral do celular: Esc fecha e devolve o foco ao botão
  await p.setViewportSize({ width: 390, height: 844 });
  const m = await p.evaluate(() => { const h = document.getElementById("ham"); h.focus(); h.click();
    const aberto = document.querySelector(".side").classList.contains("aberta") && h.getAttribute("aria-expanded") === "true" && !!document.activeElement.closest(".side");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { aberto, fechou: !document.querySelector(".side").classList.contains("aberta"), foco: document.activeElement === h, inerte: document.querySelector(".side").inert }; });
  igual({ aberto: true, fechou: true, foco: true, inerte: true }, m, "menu do celular");
  await p.context().close();
});

teste("C7", "busca na unidade: não recria o campo, preserva cursor e filtra", async () => {
  const p = await pagina("novo");
  await p.evaluate(() => { const u = Object.keys(met().a)[0]; go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos"); window.__campo = document.getElementById("busca"); });
  await p.focus("#busca"); await p.keyboard.type("conta 4.1.1.0");
  await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await p.keyboard.type("X");
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => { const b = document.getElementById("busca");
    return { mesmo: b === window.__campo, valor: b.value, cursor: b.selectionStart, foco: document.activeElement === b,
             linhas: document.querySelectorAll(".tw tbody tr.lin").length, cont: document.querySelector(".tabq").textContent }; });
  ok(r.mesmo && r.foco && r.valor === "conta 4.1.1X.0" && r.cursor === 12, "campo: " + JSON.stringify(r));
  ok(r.linhas === 0 && /^0 de/.test(r.cont), "filtro não aplicado: " + JSON.stringify(r));
  await p.evaluate(() => { const b = document.getElementById("busca"); b.value = "conta 4.1.1.0"; b.dispatchEvent(new Event("input")); });
  await p.waitForTimeout(400);
  const n = await p.evaluate(() => document.querySelectorAll(".tw tbody tr.lin").length);
  ok(n > 0, "busca válida sem resultado");
  await p.evaluate(() => go({ tipo: "hub" }));
});

teste("A8", "ano vem da base (cabeçalho ou nome do arquivo), não do código", async () => {
  const le = async csv => { const p = await abre(NOVO, csv); const r = await p.evaluate(() => ({ ano: ANO, sub: document.getElementById("subtitle").textContent,
    opt: document.querySelector("#mes option").textContent, fonte: DB.carga.anoFonte })); await p.context().close(); return r; };
  const a = await le("ano_cab.csv"), b = await le("export_plano_2025.csv"), c = await le("plano_sint.csv");
  ok(a.ano === 2027 && /AGO\/27/.test(a.sub) && a.opt === "JAN/27" && /cabeçalho/.test(a.fonte), "cabeçalho: " + JSON.stringify(a));
  ok(b.ano === 2025 && /AGO\/25/.test(b.sub) && /nome/.test(b.fonte), "nome do arquivo: " + JSON.stringify(b));
  ok(c.ano === 2026, "base 2026: " + JSON.stringify(c));
  ok(!/\/26\b|2026/.test(fs.readFileSync(NOVO, "utf8").replace(/colL[^\n]*|Planejado JAN\/2026[^\n]*/g, "")), "ano fixo no código");
});

function SEQUENCIA_TELAS() {
  const segs = SEG.filter(s => DB.units.some(u => u.seg === s && !u.vig)), cods = Object.keys(met().a).sort();
  let melhor = Infinity;
  for (let k = 0; k < 3; k++) {
    for (const c in cache) delete cache[c]; for (const c in cacheHist) delete cacheHist[c];
    if (typeof _memo !== "undefined") _memo.clear();
    const a = performance.now();
    for (const m of ["geral", "rec"]) { modo = m;
      go({ tipo: "hub" });
      segs.forEach(s => { go({ tipo: "seg", seg: s }); setVseg("ct"); setVseg("mp"); setVseg("un"); });
      cods.slice(0, 12).forEach(u => { go({ tipo: "det", seg: umap[u].seg, unit: u }); ["var", "res", "sin", "hist"].forEach(setAba); });
      go({ tipo: "exc" }); go({ tipo: "lastro" }); go({ tipo: "lsorc" }); }
    melhor = Math.min(melhor, performance.now() - a);
  }
  modo = "geral"; go({ tipo: "hub" });
  return melhor;
}
teste("B3", "render de todas as telas mais rápido que o original", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  const to = await o.evaluate(SEQUENCIA_TELAS), tn = await n.evaluate(SEQUENCIA_TELAS);
  console.log(`        render (2 modos × hub, 6 segmentos × 4 visões, 12 unidades × 5 abas, diagnósticos): original ${to.toFixed(0)} ms · novo ${tn.toFixed(0)} ms`);
  ok(tn < to * 0.7, "não ficou mais rápido");
});

teste("F1", "trocar base volta à tela de carga mantendo a tela atual; cópia de negativos vai com '-' comum", async () => {
  const p = await abre(NOVO, "plano_sint.csv");
  await p.evaluate(() => { const s = SEG.find(s => DB.units.some(u => u.seg === s && !u.vig)); go({ tipo: "seg", seg: s }); });
  const copia = await p.evaluate(() => { const el = [...document.querySelectorAll(".frd")].find(x => x.textContent.includes("−"));
    const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r);
    const dt = new DataTransfer(); document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return { tela: el.textContent, copiado: dt.getData("text/plain") }; });
  ok(copia.copiado && !copia.copiado.includes("−") && copia.copiado === copia.tela.replace(/−/g, "-"), JSON.stringify(copia));
  await Promise.all([p.waitForEvent("load"), p.click("#btroca")]);
  ok(await p.evaluate(() => !!document.getElementById("_ov") && /v=seg/.test(location.hash)), "não voltou à tela de carga");
  await p.setInputFiles("#_file", CSV("plano_sint.csv")); await p.waitForSelector("#kpis .kpi", { timeout: 90000 });
  ok(await p.evaluate(() => view.tipo) === "seg", "tela atual não foi mantida");
  await p.context().close();
});

teste("R1", "SEGMAP sem as entradas 6xxx–9xxx; unidades 6–9 continuam Backoffice", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => ({ mortas: Object.keys(SEGMAP).filter(k => /^[6-9]/.test(k)),
    fora: DB.units.filter(u => /^[6-9]/.test(u.cod) && !u.vig && u.seg !== "Backoffice").map(u => u.cod) }));
  igual({ mortas: [], fora: [] }, r, "SEGMAP");
});

teste("R2", "mês em aberto (na semana de ajustes) aparece com os dados, marcado como em aberto; futuro fica de fora", async () => {
  const com = async (nome, data) => {
    const f = CSV(nome); fs.copyFileSync(CSV("fechamento.csv"), f); fs.utimesSync(f, data, data);
    const p = await abre(NOVO, nome);
    const r = await p.evaluate(() => { abreCarga(); const t = document.getElementById("guia").innerText; fechaGuia();
      return { usados: DB.meses.filter((m, i) => DB.fechado[i]).join(","), abertos: DB.meses.filter((m, i) => DB.emAberto[i]).join(","),
               padrao: DB.meses[M], resumo: t, opcao: [...document.querySelectorAll("#mes option")][7].textContent,
               sub: document.getElementById("subtitle").textContent, kpi: document.querySelectorAll(".kpi .v")[1].textContent,
               status: document.getElementById("mstxt").textContent, dez: [...document.querySelectorAll("#mes option")][11].textContent }; });
    await p.context().close(); return r;
  };
  // 07/09 23:59: agosto na semana de ajustes → aparece COM os dados, marcado em aberto; maio sem realizado; dezembro (provisão) é futuro
  const a = await com("fech_0709.csv", new Date(2026, 8, 7, 23, 59));
  igual({ usados: "JAN,FEV,MAR,ABR,JUN,JUL,AGO", abertos: "AGO", padrao: "AGO" }, { usados: a.usados, abertos: a.abertos, padrao: a.padrao }, "exportado em 07/09 23:59");
  ok(a.kpi !== "—", "mês em aberto sem números: " + a.kpi);
  ok(/em aberto · prazo de ajustes até 07\/09/.test(a.sub) && /em aberto/.test(a.status), "selo de em aberto: " + a.sub + " | " + a.status);
  ok(/AGO\/26[^\n]*em aberto[^\n]*07\/09/.test(a.resumo) && /DEZ\/26[^\n]*futuro/.test(a.resumo), "resumo: " + a.resumo.match(/(AGO|DEZ)\/26[^\n]*/g));
  ok(/em aberto/.test(a.opcao) && /futuro|sem dados/.test(a.dez), "seletor: " + a.opcao + " | " + a.dez);
  // 08/09 00:00: passou a semana → agosto fechado, sem selo
  const b = await com("fech_0809.csv", new Date(2026, 8, 8, 0, 0));
  igual({ usados: "JAN,FEV,MAR,ABR,JUN,JUL,AGO", abertos: "", padrao: "AGO" }, { usados: b.usados, abertos: b.abertos, padrao: b.padrao }, "exportado em 08/09 00:00");
  ok(!/em aberto/.test(b.sub), "selo em mês fechado: " + b.sub);
  // ano seguinte: dezembro deixa de ser futuro (em aberto até 07/01, fechado a partir de 08/01)
  const c = await com("fech_prox_ano.csv", new Date(2027, 0, 8, 0, 0));
  ok(c.usados.endsWith("AGO,DEZ") && c.abertos === "" && c.padrao === "DEZ", "dezembro no ano seguinte: " + JSON.stringify(c));
  const d = await com("fech_prox_ano2.csv", new Date(2027, 0, 3, 9, 0));
  ok(d.abertos === "DEZ" && d.padrao === "DEZ", "dezembro em aberto em 03/01: " + JSON.stringify({ a: d.abertos, p: d.padrao }));
});

teste("U1", "4205A, 4420A e 5111A viram uma unidade só (sem falso 'sem lançamento')", async () => {
  const p = await abre(NOVO, "unificacao.csv");
  const r = await p.evaluate(() => { M = 7; periodo = "mes"; for (const k in cache) delete cache[k];
    const o = met().a["4205A"];
    return { unidades: DB.units.map(u => u.cod).join(), sem: o && o.sem, sorc: o && o.sorc,
             linhas: DB.data.length, st: (() => { view.unit = "4205A"; return linhas().map(l => l.st).join(); })() }; });
  igual({ unidades: "4205A", sem: 0, sorc: 0, linhas: 2, st: "ok,ok" }, r, "unificação");
  igual(pyPayload("unificacao.csv"), payloadBasico(await p.evaluate(() => window.__DB__)), "difere do Python");
  await p.context().close();
  const q = await pagina("novo");
  ok(await q.evaluate(() => !umap["4420A"] && !umap["5111A"] && !!umap["4205A"]), "unidades de origem ainda aparecem na base principal");
  const r2 = await q.evaluate(() => { abrePal(); montaPal("5111"); const achou = palItens.some(i => i.x === "4205A"); fechaPal();
    go({ tipo: "det", seg: "Transportes", unit: "4205A" }); const sub = document.querySelectorAll(".kpi .sub")[0].textContent;
    abreCarga(); const res = document.getElementById("guia").innerText; fechaGuia(); go({ tipo: "hub" });
    return { achou, sub, res: /4420A \+ 5111A → 4205A/.test(res) }; });
  igual({ achou: true, sub: "4205A · inclui 4420A, 5111A", res: true }, r2, "unificação visível");
  const u = await abre(NOVO, "plano_sint.csv", { hash: "#v=det&seg=Transportes&un=5111A&mes=7" });
  ok(await u.evaluate(() => view.tipo === "det" && view.unit === "4205A"), "link antigo de 5111A não redireciona");
  await u.context().close();
});

teste("H1", "Visão Geral · Por conta: consolida todos os segmentos e bate com cada segmento", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => {
    const falhas = [], chave = o => ({ a: o.a, sem: o.sem, val: o.val, tipo: o.tipo, tot: o.tot, uns: o.uns.map(u => u.cod).join() });
    const segs = segsHub(), limpa = () => { hubF = { ...HUBF0, segs: [] }; };
    // 1) filtrar um segmento = exatamente a visão "Por conta" daquele segmento
    for (const s of segs) { limpa(); hubF.segs = [s];
      const a = JSON.stringify(contasHubFiltradas().map(chave)), b = JSON.stringify(contasDoSegmento(s).map(chave));
      if (a !== b) falhas.push("segmento " + s); }
    // 2) sem filtro = soma dos segmentos (unidades com falha e R$ exposto por conta)
    limpa(); const tudo = contasHubFiltradas(), soma = {};
    segs.forEach(s => contasDoSegmento(s).forEach(o => { const x = soma[o.a] = soma[o.a] || { sem: 0, val: 0 }; x.sem += o.sem; x.val += o.val; }));
    if (tudo.length !== Object.keys(soma).length) falhas.push("contas: " + tudo.length + " × " + Object.keys(soma).length);
    tudo.forEach(o => { const x = soma[o.a]; if (!x || x.sem !== o.sem || Math.abs(x.val - o.val) > 1e-6) falhas.push("conta " + o.a); });
    const nUn = DB.units.filter(u => !u.vig).length; if (tudo.some(o => o.tot !== nUn)) falhas.push("total de unidades");
    // 3) filtros: cada item respeita o filtro, e o filtro não perde nenhum item
    const casos = [["alc", "sistemico", o => o.tipo === "sistemico"], ["alc", "isolado", o => o.tipo === "isolado"],
      ["nat", "imp", o => natMap[o.a] === "imp"], ["fv", "Variável", o => (amap[o.a].fv || "—") === "Variável"],
      ["busca", "4.1.1.02", o => o.a.includes("4.1.1.02")]];
    for (const [k, v, f] of casos) { limpa(); hubF[k] = v; const l = contasHubFiltradas(), esperado = tudo.filter(f);
      if (l.length !== esperado.length || l.some(o => !f(o))) falhas.push(`filtro ${k}=${v}: ${l.length} × ${esperado.length}`); }
    limpa(); hubF.ord = "val"; const ord = contasHubFiltradas(); if (ord.some((o, i) => i && ord[i - 1].val < o.val)) falhas.push("ordem por valor");
    limpa(); return { falhas, n: tudo.length };
  });
  ok(!r.falhas.length && r.n > 0, r.falhas.slice(0, 6).join("; "));
});

teste("H2", "Visão Geral · Por conta: tela, filtros, busca, expansão, exportação e link", async () => {
  const p = await pagina("novo");
  await p.evaluate(() => { go({ tipo: "hub" }); setVhub("ct"); });
  const t1 = await p.evaluate(() => ({ linhas: document.querySelectorAll("#hubct-res tbody tr.lin").length, n: contasHubFiltradas().length,
    url: location.hash, resumo: document.getElementById("hubct-resumo").textContent.replace(/\s+/g, " ") }));
  ok(t1.linhas === t1.n && /hv=ct/.test(t1.url) && new RegExp(t1.n + " contas").test(t1.resumo), JSON.stringify(t1));
  // filtro de segmento pelo chip (teclado) + alcance
  const t2 = await p.evaluate(async () => { const c = [...document.querySelectorAll("#hubct-segs .chip")].find(x => x.dataset.v === "CDs");
    c.focus(); c.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const l1 = document.querySelectorAll("#hubct-res tbody tr.lin").length, esp = contasDoSegmento("CDs").length, pressed = c.getAttribute("aria-pressed");
    document.querySelector('#hubct-alc .chip[data-v="sistemico"]').click();
    const l2 = document.querySelectorAll("#hubct-res tbody tr.lin").length, esp2 = contasDoSegmento("CDs").filter(o => o.tipo === "sistemico").length;
    return { l1, esp, pressed, l2, esp2 }; });
  ok(t2.l1 === t2.esp && t2.pressed === "true" && t2.l2 === t2.esp2, JSON.stringify(t2));
  // busca: não recria o campo, filtra e mantém o cursor
  await p.evaluate(() => { hubFiltro("limpar"); window.__c = document.getElementById("buscahub"); });
  await p.focus("#buscahub"); await p.keyboard.type("4.1.1.02"); await p.waitForTimeout(400);
  const t3 = await p.evaluate(() => ({ mesmo: document.getElementById("buscahub") === window.__c, foco: document.activeElement.id,
    linhas: document.querySelectorAll("#hubct-res tbody tr.lin").length, esp: contasHubFiltradas().length,
    todas: [...document.querySelectorAll("#hubct-res tbody tr.lin td.num:not(.r)")].every(td => td.textContent.includes("4.1.1.02")) }));
  ok(t3.mesmo && t3.foco === "buscahub" && t3.linhas === t3.esp && t3.todas && t3.linhas > 0, JSON.stringify(t3));
  // expansão: todas as unidades do recorte, com segmento e total
  const t4 = await p.evaluate(() => { hubFiltro("limpar"); const o = contasHubFiltradas()[0]; toggleContaHub(o.a);
    const ex = document.querySelector("#hubct-res tr.exp"); const linhas = ex.querySelectorAll("tbody tr.clic").length;
    const esp = contaNasUnidades(DB.units.filter(u => !u.vig), o.a).length;
    return { linhas, esp, total: /Total do recorte/.test(ex.textContent), sem: ex.querySelectorAll(".st.sem").length, osem: o.sem }; });
  ok(t4.linhas === t4.esp && t4.total && t4.sem === t4.osem, JSON.stringify(t4));
  // exportação respeita o filtro
  await p.evaluate(() => { hubFiltro("limpar"); hubFiltro("seg", "Transportes"); });
  const x = await baixa(p, () => exportContasHub());
  const ab = x.abas["Contas"], esp = await p.evaluate(() => contasHubFiltradas().map(o => [o.a, o.sem, Math.round(o.val * 100) / 100]));
  igual(esp, ab.slice(4).map(l => [l[0], l[6], l[8]]), "exportação");
  ok(/Transportes/.test(ab[1][0]), "filtro não registrado na planilha: " + ab[1][0]);
  await p.evaluate(() => { hubFiltro("limpar"); setVhub("seg"); });
  // link com a visão "Por conta"
  const q = await abre(NOVO, "so_orcado.csv", { hash: "#hv=ct&mes=0" });
  ok(await q.evaluate(() => vhub === "ct" && !!document.querySelector(".vbar2 button.on") && document.querySelector(".vbar2 button.on").textContent === "Por conta"), "link hv=ct");
  await q.context().close();
});

teste("F2", "PPR: provisão (98) soma no PPR (99), que mantém o próprio nome; resumo mostra o que veio da 98", async () => {
  const p = await abre(NOVO, "fusao.csv");
  const r = await p.evaluate(() => { const d = DB.data.find(x => x.a === "4.1.1.01.1.99");
    view.unit = "4101A"; const l = linhas().find(x => x.a === "4.1.1.01.1.99");
    abreCarga(); const res = document.getElementById("guia").innerText; fechaGuia();
    go({ tipo: "det", seg: umap["4101A"].seg, unit: "4101A" }); setF("todos");
    const tela = document.querySelector(".tw tbody").innerText;
    abrePal(); montaPal("4.1.1.01.1.98"); let busca = palItens.some(i => i.x === "4.1.1.01.1.99");
    montaPal("provisao ppr"); busca = busca && palItens.some(i => i.x === "4.1.1.01.1.99"); fechaPal();
    view.busca = "Provisão"; busca = busca && linhasFiltradas(linhas()).some(x => x.a === "4.1.1.01.1.99"); view.busca = "";
    hubF = { ...HUBF0, segs: [], busca: "Provisão" }; const nHub = contasHubBase().length; hubF = { ...HUBF0, segs: [] };
    return { contas: DB.accts.map(a => a.cod + " " + a.desc).join("|"), mes: DB.meses[M], set: d.r[8], st: l.st, real: l.r,
      f: DB.carga.fusoes[0], res, tela: /inclui 4\.1\.1\.01\.1\.98/.test(tela), busca }; });
  ok(r.contas === "4.1.1.01.1.99 PPR Colaboradores", "contas: " + r.contas);
  ok(r.mes === "SET" && r.set === -500 && r.real === -500 && r.st !== "sem", "SET do PPR: " + JSON.stringify({ m: r.mes, set: r.set, st: r.st }));
  ok(r.f.linhas === 1 && r.f.r[8] === -500, "registro da fusão: " + JSON.stringify(r.f));
  ok(/4\.1\.1\.01\.1\.98 → 4\.1\.1\.01\.1\.99/.test(r.res) && /SET\/26\s+0,00\s+−500,00\s+em aberto/.test(r.res), "resumo: " + r.res.slice(r.res.indexOf("fundida"), r.res.indexOf("fundida") + 400));
  ok(r.tela && r.busca, "tela/busca: " + JSON.stringify({ t: r.tela, b: r.busca }));
  igual(pyPayload("fusao.csv").data, payloadBasico(await p.evaluate(() => window.__DB__)).data, "valores diferentes do Python");
  await p.context().close();
});

teste("P1", "provisão: conta, valor e centro de custo (unidade + 4 últimos do CC), com todas as opções", async () => {
  const p = await abre(NOVO, "provisao.csv");
  const r = await p.evaluate(() => {
    const lin = o => dadosProvisao(o).linhas.map(l => [l.conta, l.valor, l.cc]);
    const base = { escopo: "todos", contas: "todas", valor: "orc", parcial: false, ppr: false };
    return { mes: DB.meses[M], col: DB.carga.colCC,
      padrao: lin(base), parcial: lin({ ...base, parcial: true }), ppr: lin({ ...base, ppr: true }), media: lin({ ...base, valor: "media" }),
      sel: (provSel.clear(), provSel.add("4.1.1.08.1.06"), lin({ ...base, contas: "sel" })),
      seg: lin({ ...base, parcial: true, escopo: "seg:Transportes" }), un: lin({ ...base, escopo: "un:4101A" }) }; });
  ok(r.mes === "AGO" && r.col === 5, "mês/coluna: " + r.mes + " " + r.col);
  igual([["4.1.1.01.1.99", 500, "41021114"], ["4.1.1.08.1.06", 600, "41011101"], ["4.1.1.08.1.06", 400, "41011114"]], r.padrao, "padrão (orçado, sem lançamento)");
  igual([["4.1.1.01.1.99", 500, "41021114"], ["4.1.1.02.1.09", 300, "41011101"], ["4.1.1.04.1.06", 1569.29, "50021111"],
         ["4.1.1.08.1.06", 600, "41011101"], ["4.1.1.08.1.06", 400, "41011114"]], r.parcial, "com lançadas abaixo do orçado");
  igual(["4.1.1.01.1.98", 500, "41021114"], r.ppr[0], "PPR na provisão (98)");
  igual([["4.1.1.01.1.99", 480, "41021114"], ["4.1.1.08.1.06", 72, "41011101"], ["4.1.1.08.1.06", 48, "41011114"]], r.media, "média do realizado");
  igual([["4.1.1.08.1.06", 600, "41011101"], ["4.1.1.08.1.06", 400, "41011114"]], r.sel, "só as selecionadas");
  igual([["4.1.1.04.1.06", 1569.29, "50021111"]], r.seg, "segmento Transportes");
  igual([["4.1.1.08.1.06", 600, "41011101"], ["4.1.1.08.1.06", 400, "41011114"]], r.un, "unidade 4101A");
  // pela janela: baixa o XLSX no layout (Conta contábil | Valor | Centro de custo) + conferência
  await p.evaluate(() => { provSel.clear(); go({ tipo: "hub" }); abreProvisao(); });
  const dlg = await p.evaluate(() => document.getElementById("guia").innerText);
  ok(/3 linha/.test(dlg) && /1\.500,00/.test(dlg), "resumo da janela: " + dlg.slice(0, 300));
  const x = await baixa(p, () => document.getElementById("provBaixar").click());
  igual([["Conta contábil", "Valor", "Centro de custo"], ["4.1.1.01.1.99", 500, 41021114], ["4.1.1.08.1.06", 600, 41011101], ["4.1.1.08.1.06", 400, 41011114]],
        x.abas["Provisão"], "planilha de provisão");
  ok(x.abas["Conferência"].length >= 4 && /provis/i.test(x.nome), "conferência/nome: " + x.nome);
  await p.context().close();
  // cabeçalho sem nome reconhecível: escolhe a coluna pelos valores e permite trocar
  const q = await abre(NOVO, "provisao_cab.csv");
  const s = await q.evaluate(() => ({ det: DB.carga.colCC, cand: DB.carga.ccCandidatas.map(c => c.col), esc: colunaProvisao(),
    lin: dadosProvisao({ escopo: "todos", contas: "todas", valor: "orc", parcial: false, ppr: false }).linhas.map(l => l.cc) }));
  igual({ det: null, cand: [4, 5, 6, 7], esc: 5, lin: ["41021114", "41011101", "41011114"] }, s, "coluna de CC pelos valores");
  await q.context().close();
});

teste("R3", "periodicidade: fora do mês esperado ou já lançado no ciclo não é pendência", async () => {
  const p = await abre(NOVO, "periodo.csv");
  const r = await p.evaluate(() => {
    const st = (a, m) => { M = m; periodo = "mes"; for (const k in cache) delete cache[k]; view.unit = "4101A";
      const l = linhas().find(x => x.a === a); return l ? l.st : "-"; };
    const antes = { tAgo: st("4.1.1.08.1.06", 7), uJun: st("4.1.1.04.1.06", 5), uMar: st("4.1.1.04.1.06", 2) };
    const sug = sugereMeses("4.1.1.08.1.06");
    salvaAjustes({ versao: 1, rec: {}, meses: { "4.1.1.08.1.06": [2, 5, 8, 11], "4.1.1.04.1.06": [2, 5, 8, 11] } });
    const depois = { tAgo: st("4.1.1.08.1.06", 7), tJun: st("4.1.1.08.1.06", 5), uJun: st("4.1.1.04.1.06", 5), uMar: st("4.1.1.04.1.06", 2),
      wAgo: st("4.1.1.02.1.09", 7), tFev: st("4.1.1.08.1.06", 1) };
    M = 7; for (const k in cache) delete cache[k];
    const kpi = met().a["4101A"].sem;
    const prov = dadosProvisao({ escopo: "todos", contas: "todas", valor: "orc", parcial: false, ppr: false }).linhas.map(l => l.conta);
    const hist = histPendencias("4101A").slice(0, 8).map(m => m && m.n).join(",");
    salvaAjustes({ versao: 1, rec: {}, meses: {} });
    return { antes, sug, depois, kpi, prov, hist }; });
  igual({ tAgo: "sem", uJun: "sem", uMar: "sem" }, r.antes, "sem periodicidade");
  igual([2, 5, 8, 11], r.sug, "sugestão pelo padrão observado (MAR, JUN → trimestral)");
  // T: AGO não é mês esperado; JUN lançou. U: JUN e MAR sem lançamento, mas lançou em MAI e FEV (no ciclo). W segue mensal.
  igual({ tAgo: "cic", tJun: "ok", uJun: "cic", uMar: "cic", wAgo: "sem", tFev: "cic" }, r.depois, "com trimestral MAR/JUN/SET/DEZ");
  ok(r.kpi === 1 && r.prov.join() === "4.1.1.02.1.09", "KPI/provisão só com a mensal: " + JSON.stringify({ k: r.kpi, p: r.prov }));
  ok(r.hist === "0,0,0,0,0,0,0,1", "histórico: " + r.hist);
  await p.context().close();
});

teste("R4", "editar recorrentes: marca/desmarca, salva no navegador, exporta e importa", async () => {
  const p = await abre(NOVO, "periodo.csv");
  const r = await p.evaluate(() => {
    const antes = [...recSet].sort();
    abreAjustesRec();
    const linha = cod => [...document.querySelectorAll("#ajrec tbody tr")].find(tr => tr.dataset.a === cod);
    linha("4.1.1.08.1.06").querySelector("input.ajr").click();       // estava recorrente → deixa de ser
    linha("4.1.1.02.1.09").querySelector("input.ajr").click();
    document.getElementById("ajSalvar").click();
    const depois = [...recSet].sort(), nrec = N_REC, aberto = document.getElementById("guia").classList.contains("on");
    let guardado = null; try { guardado = JSON.parse(localStorage.getItem("fpa-ajustes")); } catch (e) {}
    view.unit = "4101A"; const cls = linhas().find(l => l.a === "4.1.1.08.1.06").cls;
    const json = textoAjustes();
    salvaAjustes({ versao: 1, rec: {}, meses: {} }); const limpo = [...recSet].sort();
    importaAjustesTexto(json); const reimportado = [...recSet].sort();
    let erro = null; try { importaAjustesTexto('{"x":1}'); } catch (e) { erro = e.message; }
    salvaAjustes({ versao: 1, rec: {}, meses: {} });
    return { antes, depois, nrec, aberto, guardado, cls, limpo, reimportado, erro }; });
  const esperado = r.antes.filter(a => a !== "4.1.1.08.1.06" && a !== "4.1.1.02.1.09");
  igual(esperado, r.depois, "recorrentes depois de editar");
  ok(r.nrec === esperado.length && !r.aberto, "N_REC/janela: " + JSON.stringify({ n: r.nrec, a: r.aberto }));
  igual({ "4.1.1.08.1.06": false, "4.1.1.02.1.09": false }, r.guardado && r.guardado.rec, "salvo no navegador");
  ok(/ajustad/.test(r.cls), "classificação não indica ajuste: " + r.cls);
  igual(r.antes, r.limpo, "restaurar padrão"); igual(r.depois, r.reimportado, "reimportar");
  ok(/ajustes/i.test(r.erro || ""), "arquivo inválido aceito: " + r.erro);
  await p.context().close();
});

teste("P2", "provisão: abre em 'contas marcadas' e, pelo realizado, mostra o mês a mês com o mês fora da curva", async () => {
  const p = await abre(NOVO, "provisao.csv");
  const r = await p.evaluate(() => {
    // PPR com um lançamento grande em JUL (4.800 contra 480 em MAI e JUN)
    DB.data.find(d => d.a === "4.1.1.01.1.99" && d.u === "4102A").r[6] = -4800;
    const lin = o => dadosProvisao(o).linhas.filter(l => l.contaOrig === "4.1.1.01.1.99").map(l => [l.valor, l.pico, l.hist.join()]);
    const base = { escopo: "todos", contas: "todas", valor: "orc", parcial: false, ppr: false };
    const media = lin({ ...base, valor: "media" }), med = lin({ ...base, valor: "mediana" });
    provSel.clear(); go({ tipo: "hub" }); abreProvisao(); const semSel = document.getElementById("provContas").value;
    fechaGuia(); provSel.add("4.1.1.01.1.99"); provOpt.contas = "todas"; abreProvisao();
    const comSel = document.getElementById("provContas").value, opt = { ...provOpt };
    const orcTxt = document.getElementById("provPrev").innerText;
    provAlt("valor", "media");
    const tab = [...document.querySelectorAll("#provPrev .provtab tbody tr")].map(tr => ({ pico: tr.classList.contains("pico"),
      alto: !!tr.querySelector("td.alto svg.ic"),
      c: [...tr.cells].map(td => td.textContent.trim()) }));
    const cab = [...document.querySelectorAll("#provPrev .provtab thead th")].map(th => th.textContent);
    const aviso = (document.querySelector("#provPrev .av") || {}).textContent || "";
    return { media, med, semSel, comSel, contasOpt: opt.contas, orcTxt, tab, cab, aviso }; });
  igual([[1920, 6, "4800,480,480"]], r.media, "média com mês fora da curva");
  igual([[480, 6, "4800,480,480"]], r.med, "mediana ignora o mês fora da curva");
  ok(r.semSel === "todas" && r.comSel === "sel" && r.contasOpt === "sel", "seleção: " + JSON.stringify([r.semSel, r.comSel, r.contasOpt]));
  ok(!/JUL/.test(r.orcTxt), "pelo orçado não deveria mostrar o detalhe: " + r.orcTxt);
  igual(["Conta", "Unidade", "MAI/26", "JUN/26", "JUL/26", "Orçado", "Provisão"], r.cab, "cabeçalho do detalhe");
  ok(r.tab.length === 1 && r.tab[0].pico && r.tab[0].c[4].includes("4.800,00") && r.tab[0].alto && r.tab[0].c[6] === "1.920,00",
     "detalhe: " + JSON.stringify(r.tab));
  ok(/1 conta\(s\) com um mês acima/.test(r.aviso) && /mediana/.test(r.aviso), "aviso: " + r.aviso);
  // planilha: meses e mês fora da curva na Conferência
  const x = await baixa(p, () => document.getElementById("provBaixar").click());
  const conf = x.abas["Conferência"], h = conf[3], l = conf[4];
  igual(["Realizado MAI/26 (conta × unidade)", "Realizado JUN/26 (conta × unidade)", "Realizado JUL/26 (conta × unidade)",
         "Base do cálculo (conta × unidade)", "Mês fora da curva"], h.slice(13), "colunas novas");
  igual([480, 480, 4800, 1920, "JUL/26"], l.slice(13), "valores na conferência");
  await p.context().close();
});

teste("X1", "acessibilidade (axe-core): nenhuma violação nas telas principais e janelas, nos dois temas", async () => {
  let src;
  try { src = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); }
  catch (e) { src = fs.readFileSync(path.join(cp.execSync("npm root -g").toString().trim(), "axe-core", "axe.min.js"), "utf8"); }
  const telas = {
    hub: () => go({ tipo: "hub" }), "por conta": () => { go({ tipo: "hub" }); vhub = "ct"; render(); },
    segmento: () => { vhub = "seg"; go({ tipo: "seg", seg: "CDs" }); },
    unidade: () => { const u = DB.units.find(u => u.seg === "CDs"); go({ tipo: "unit", unit: u.cod, seg: u.seg }); },
    exceções: () => go({ tipo: "exc" }), provisão: () => { go({ tipo: "hub" }); abreProvisao(); },
    recorrentes: () => { fechaGuia(); abreAjustesRec(); }, "resumo da carga": () => { fechaGuia(); abreCarga(); },
    justificativas: () => { fechaGuia(); salvaNota(M, DB.data[0].u, DB.data[0].a, "teste de acessibilidade"); abreNotas(); },
    "linha aberta com justificativa": () => { fechaGuia(); const u = DB.data[0].u; go({ tipo: "det", unit: u, seg: umap[u].seg }); setF("todos"); toggleExp(DB.data[0].a); },
    comparação: () => { abreComparacao(); } };
  const falhas = [];
  for (const cs of ["dark", "light"]) {
    const p = await abre(NOVO, "plano_sint.csv", { colorScheme: cs });
    await p.addScriptTag({ content: src });
    for (const [nome, f] of Object.entries(telas)) {
      await p.evaluate(`(${f.toString()})()`); await p.waitForTimeout(50);
      await p.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));   // cartões entram com fade
      const v = await p.evaluate(async () => (await axe.run(document, { resultTypes: ["violations"] })).violations
        .map(x => `${x.id} (${x.impact}): ${x.nodes.slice(0, 2).map(n => n.target.join(" ")).join(" | ")}`));
      v.forEach(x => falhas.push(`${cs}/${nome}: ${x}`));
    }
    await p.context().close();
  }
  ok(!falhas.length, "violações:\n      " + falhas.slice(0, 12).join("\n      "));
});

teste("V1", "IBCS, tabela compacta, coluna da conta fixa e ordenação no padrão W3C", async () => {
  const p = await abre(NOVO, "plano_sint.csv");
  const r = await p.evaluate(async () => {
    try { localStorage.removeItem("fpa-densidade"); } catch (e) {}
    go({ tipo: "det", unit: "4001A", seg: umap["4001A"].seg }); setF("todos");
    // ordenação: botão no cabeçalho, aria-sort só na coluna ordenada
    const sorts = () => [...document.querySelectorAll(".tw.det thead th[aria-sort]")].map(th => th.dataset.k + ":" + th.getAttribute("aria-sort"));
    const s0 = sorts();
    document.querySelector('.tw.det thead th[data-k="p"] .thb').click();
    const s1 = sorts(), ordP = view.sk;
    document.querySelector('.tw.det thead th[data-k="p"] .thb').click();
    const s2 = sorts();
    // compacto: ligado por padrão, alterna e é lembrado
    const comp0 = document.querySelector(".tw.det").classList.contains("compacto");
    document.getElementById("bdens").click();
    const comp1 = document.querySelector(".tw.det").classList.contains("compacto"), salvo = localStorage.getItem("fpa-densidade");
    document.getElementById("bdens").click();
    const fixa = getComputedStyle(document.querySelector(".tw.det tbody tr.lin td")).position;
    // gráfico IBCS na linha aberta: uma célula por mês fechado, variação = realizado − orçado
    const lin = linhas().find(l => DB.fechado.some((f, i) => f && Math.abs(l.d.r[i] - l.d.p[i]) > 1000));
    toggleExp(lin.a);
    const cels = [...document.querySelectorAll("tr.exp .ibr td.ibc")];
    const fech = DB.fechado.map((f, i) => f ? i : -1).filter(i => i >= 0);
    const sinais = cels.map((c, k) => { const v = lin.d.r[fech[k]] - lin.d.p[fech[k]], b = c.querySelector(".ibv i");
      return Math.abs(v) < EPS ? !b : !!b && b.classList.contains(v > 0 ? "pos" : "neg"); });
    const plAc = cels.every(c => c.querySelector(".ibp i.pl") && c.querySelector(".ibp i.ac"));
    setAba("res"); const res = document.querySelectorAll(".graf .ibcs .ibc").length;
    return { s0, s1, s2, ordP, comp0, comp1, salvo, fixa, nCel: cels.length, nFech: fech.length, sinais, plAc, res }; });
  igual(["st:descending"], r.s0, "aria-sort inicial");
  igual(["p:descending"], r.s1, "aria-sort depois de ordenar por Planejado");
  igual(["p:ascending"], r.s2, "aria-sort ao inverter");
  ok(r.ordP === "p", "ordenação pelo botão do cabeçalho");
  ok(r.comp0 && !r.comp1 && r.salvo === "confortavel", "densidade: " + JSON.stringify([r.comp0, r.comp1, r.salvo]));
  ok(r.fixa === "sticky", "coluna da conta não fica fixa: " + r.fixa);
  ok(r.nCel === r.nFech && r.sinais.every(Boolean) && r.plAc, "gráfico da linha aberta: " + JSON.stringify(r));
  ok(r.res === r.nFech, "gráfico do resultado: " + r.res);
  ok(!p._erros.length, "erros: " + p._erros);
  await p.context().close();
});

/* ---------- tela de carga: pasta da base e link do Plano ---------- */
// pasta simulada (File System Access): nada sai da máquina, os arquivos são montados na página
async function abrePasta(arquivos, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, colorScheme: "dark" });
  // nenhuma conexão real: a aba do Plano recebe uma página vazia local
  await ctx.route(/^https?:/, r => r.fulfill({ status: 200, contentType: "text/html", body: "<title>plano</title>" }));
  await ctx.addInitScript(([arqs, semFS]) => {
    if (semFS) { delete window.showDirectoryPicker; return; }
    window.__gravados__ = []; window.__picker__ = 0;
    window.__arquivosFake__ = Object.fromEntries(arqs.filter(a => /\.json$/.test(a.nome)).map(a => [a.nome, a.txt]));
    const itens = arqs.map(a => ({ kind: "file", name: a.nome,
      getFile: async () => new File([a.txt], a.nome, { lastModified: a.ms }) }));
    window.showDirectoryPicker = async () => { window.__picker__++; return {
      kind: "directory", name: "Base FP&A",
      values: async function* () { for (const i of itens) yield i; },
      queryPermission: async () => "granted", requestPermission: async () => "granted",
      getFileHandle: async (nome, op) => {
        if (!(nome in window.__arquivosFake__) && !(op && op.create)) throw new DOMException("não existe", "NotFoundError");
        return { getFile: async () => new File([window.__arquivosFake__[nome] || ""], nome),
          createWritable: async () => { let t = "";
            return { write: async x => { t += x; }, close: async () => { window.__arquivosFake__[nome] = t; window.__gravados__.push([nome, t]); } }; } }; } }; };
  }, [arquivos, !!opts.semFS]);
  const p = await ctx.newPage();
  p._erros = []; p._rede = [];
  p.on("pageerror", e => p._erros.push(e.message));
  p.on("request", r => { const u = r.url(); if (!/^(file|data|blob):/.test(u)) p._rede.push(u); });
  await p.goto("file://" + NOVO);
  return p;
}
const lerCSV = n => new TextDecoder("windows-1252").decode(fs.readFileSync(CSV(n)));
teste("L1", "pasta da base: lista os CSV com data e hora, abre o escolhido e grava os ajustes na pasta", async () => {
  const set = Date.UTC(2026, 9, 1, 14, 30), ago = Date.UTC(2026, 8, 10, 12, 0);
  const aj = JSON.stringify({ versao: 1, rec: { "4.1.1.02.1.09": false }, meses: { "4.1.1.08.1.06": [2, 5, 8, 11] }, salvoEm: "2099-01-01T00:00:00Z" });
  const p = await abrePasta([
    { nome: "base_agosto.csv", txt: lerCSV("so_orcado.csv"), ms: ago },
    { nome: "base_setembro.csv", txt: lerCSV("periodo.csv"), ms: set },
    { nome: "leia-me.txt", txt: "x", ms: set + 1 },
    { nome: "fpa-ajustes.json", txt: aj, ms: set } ]);
  await p.click("#_escPasta"); await p.waitForSelector("#_lista button");
  const itens = await p.$$eval("#_lista button", bs => bs.map(b => b.textContent));
  ok(itens.length === 2 && /^base_setembro\.csv/.test(itens[0]) && /mais recente/.test(itens[0]) && /^base_agosto/.test(itens[1]),
     "lista: " + JSON.stringify(itens));
  const fmt = ms => { const d = new Date(ms), z = n => String(n).padStart(2, "0");
    return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  ok(itens[0].includes(fmt(set)) && itens[1].includes(fmt(ago)), "data e hora: " + JSON.stringify(itens));
  ok(await p.evaluate(() => document.activeElement.dataset.nome === "base_setembro.csv"), "foco não foi para o mais recente");
  await p.click("#_lista button[data-nome='base_setembro.csv']");
  await p.waitForSelector("#kpis .kpi", { timeout: 30000 });
  const r = await p.evaluate(() => ({ arq: DB.carga.arquivo, mod: DB.carga.modificado, rec: ehRec("4.1.1.02.1.09"),
    meses: AJUSTES.meses["4.1.1.08.1.06"], origem: ORIGEM_AJ }));
  ok(r.arq === "base_setembro.csv" && r.mod === set, "base aberta: " + JSON.stringify(r));
  ok(r.rec === false && String(r.meses) === "2,5,8,11" && r.origem === "pasta", "ajustes da pasta: " + JSON.stringify(r));
  // salvar no editor grava fpa-ajustes.json na pasta
  await p.evaluate(() => { abreAjustesRec(); document.getElementById("ajSalvar").click(); });
  await p.waitForFunction(() => window.__gravados__.length > 0);
  const g = await p.evaluate(() => window.__gravados__);
  ok(g[0][0] === "fpa-ajustes.json" && JSON.parse(g[0][1]).meses["4.1.1.08.1.06"].join() === "2,5,8,11", "gravação: " + JSON.stringify(g).slice(0, 200));
  ok(!p._erros.length && !p._rede.length, "erros/rede: " + JSON.stringify([p._erros, p._rede]));
  await p.context().close();
  // ajuste do navegador mais novo que o da pasta prevalece
  const q = await abrePasta([{ nome: "b.csv", txt: lerCSV("periodo.csv"), ms: set },
    { nome: "fpa-ajustes.json", txt: aj.replace("2099", "2001"), ms: set }]);
  await q.evaluate(() => localStorage.setItem("fpa-ajustes", JSON.stringify({ versao: 1, rec: {}, meses: {}, salvoEm: "2026-01-01T00:00:00Z" })));
  await q.click("#_escPasta"); await q.click("#_lista button"); await q.waitForSelector("#kpis .kpi");
  ok(await q.evaluate(() => ORIGEM_AJ === "navegador" && ehRec("4.1.1.02.1.09")), "o mais recente não prevaleceu");
  await q.context().close();
});

teste("L2", "link do Plano: abre em nova aba (sem carimbo anti-cache) e pode ser editado", async () => {
  const p = await abrePasta([]);
  const abre1 = p.context().waitForEvent("page"); await p.click("#_plano"); const n1 = await abre1;
  const PAD = "https://plano.allstrategy.com.br/performance/dre-exportar-valores?NOME=plano&PLANEJAMENTO=31&idpro=330-1790938214";
  await n1.waitForLoadState().catch(() => {});
  ok(n1.url() === PAD, "url: " + n1.url());
  await n1.close();
  await p.click("#_planoEd"); await p.fill("#_planoUrl", "http://inseguro.example/x"); await p.click("#_planoOk");
  ok(/começar com https/.test(await p.textContent("#_msg")), "aceitou link sem https");
  await p.fill("#_planoUrl", "https://plano.allstrategy.com.br/performance/dre-exportar-valores?NOME=plano&PLANEJAMENTO=32&_=1790938213782");
  await p.click("#_planoOk");
  const salvo = await p.evaluate(() => localStorage.getItem("fpa-plano-url"));
  ok(salvo === "https://plano.allstrategy.com.br/performance/dre-exportar-valores?NOME=plano&PLANEJAMENTO=32", "salvo: " + salvo);
  const abre2 = p.context().waitForEvent("page"); await p.click("#_plano"); const n2 = await abre2;
  await n2.waitForLoadState().catch(() => {});
  ok(n2.url().includes("PLANEJAMENTO=32"), "link editado não usado: " + n2.url());
  ok(!p._rede.length, "a página do painel fez conexão: " + p._rede);
  await p.context().close();
});

teste("L3", "pasta sem File System Access (Firefox): escolhe a pasta pelo seletor e lista só os CSV dela", async () => {
  const p = await abrePasta([], { semFS: true });
  await p.click("#_escPasta");
  const dir = path.join(TMP, "pasta_l3"); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.copyFileSync(CSV("periodo.csv"), path.join(dir, "atual.csv")); fs.writeFileSync(path.join(dir, "sub", "velho.csv"), "x");
  fs.writeFileSync(path.join(dir, "nota.txt"), "x");
  await p.setInputFiles("#_dir", dir);
  await p.waitForSelector("#_lista button");
  const itens = await p.$$eval("#_lista button", bs => bs.map(b => b.dataset.nome));
  igual(["atual.csv"], itens, "lista sem File System Access");
  await p.click("#_lista button"); await p.waitForSelector("#kpis .kpi", { timeout: 30000 });
  ok(await p.evaluate(() => DB.carga.arquivo === "atual.csv" && !window.__gravaAjustesPasta__), "abriu a base sem gravar na pasta");
  await p.context().close();
});

teste("J1", "justificativas: salvar, juntar com a pasta sem apagar outro analista, remover e exportar", async () => {
  const ana = { versao: 1, itens: { "2026-08|4101A|4.1.1.04.1.06": { t: "Ana: NF atrasada", por: "Ana", em: "2026-09-10T10:00:00.000Z" } } };
  const p = await abrePasta([{ nome: "agora.csv", txt: lerCSV("comparacao_agora.csv"), ms: Date.UTC(2026, 8, 15) },
    { nome: "fpa-notas.json", txt: JSON.stringify(ana), ms: Date.UTC(2026, 8, 15) }]);
  await p.click("#_escPasta"); await p.click("#_lista button[data-nome='agora.csv']"); await p.waitForSelector("#kpis .kpi");
  const r1 = await p.evaluate(() => ({ ana: !!notaDe(7, "4101A", "4.1.1.04.1.06"), cont: document.getElementById("bnotas").textContent }));
  ok(r1.ana && /\(1\)/.test(r1.cont), "nota da pasta não carregada: " + JSON.stringify(r1));
  // outro analista grava depois que este painel abriu
  await p.evaluate(() => { const o = JSON.parse(window.__arquivosFake__["fpa-notas.json"]);
    o.itens["2026-08|4101A|4.1.1.02.1.09"] = { t: "Bia: reclassificação", por: "Bia", em: "2026-09-20T10:00:00.000Z" };
    window.__arquivosFake__["fpa-notas.json"] = JSON.stringify(o); });
  await p.evaluate(() => { go({ tipo: "det", unit: "4101A", seg: umap["4101A"].seg }); setF("todos"); toggleExp("4.1.1.08.1.06"); });
  await p.fill("#ntx", "Lançado em AGO após cobrança"); await p.fill("#ntaut", "Juan");
  await p.click("#ntsalva");
  await p.waitForFunction(() => /pasta/.test(document.getElementById("ntmsg").textContent));
  const r2 = await p.evaluate(() => { const f = JSON.parse(window.__arquivosFake__["fpa-notas.json"]).itens;
    return { chaves: Object.keys(f).sort(), nossa: f["2026-08|4101A|4.1.1.08.1.06"], icone: !!document.querySelector("tr.lin .ntic"),
      autor: localStorage.getItem("fpa-autor"), n: itensNotas(7).length }; });
  igual(["2026-08|4101A|4.1.1.02.1.09", "2026-08|4101A|4.1.1.04.1.06", "2026-08|4101A|4.1.1.08.1.06"], r2.chaves, "junção com a pasta");
  ok(r2.nossa.t === "Lançado em AGO após cobrança" && r2.nossa.por === "Juan" && r2.icone && r2.autor === "Juan" && r2.n === 3, "nota salva: " + JSON.stringify(r2));
  // exportação: uma linha por justificativa, com situação e valores do mês
  await p.evaluate(() => abreNotas());
  const x = await baixa(p, () => document.getElementById("ntexp").click());
  const aba = x.abas["Justificativas"], cab = aba[2], lin = aba.slice(3);
  igual(["Mês", "Segmento", "Unidade", "Nome da unidade", "Conta", "Descrição", "Situação no mês", "Orçado", "Realizado", "Variação", "Justificativa", "Por", "Registrada em"], cab, "cabeçalho");
  const ln = lin.find(l => l[4] === "4.1.1.08.1.06");
  ok(lin.length === 3 && ln && ln[0] === "AGO/26" && ln[7] === -100 && ln[8] === -100 && ln[9] === 0 && ln[10] === "Lançado em AGO após cobrança" && ln[11] === "Juan",
     "linha exportada: " + JSON.stringify(ln));
  const lnY = lin.find(l => l[4] === "4.1.1.04.1.06");
  ok(lnY && lnY[6] === "Sem lançamento", "situação no mês: " + JSON.stringify(lnY));
  // remover grava o item vazio (a remoção também chega à pasta)
  await p.evaluate(() => { fechaGuia(); toggleExp("4.1.1.08.1.06"); toggleExp("4.1.1.08.1.06"); });
  await p.evaluate(() => gravaNotaUI("4101A", "4.1.1.08.1.06", true));
  const r3 = await p.evaluate(() => ({ f: JSON.parse(window.__arquivosFake__["fpa-notas.json"]).itens["2026-08|4101A|4.1.1.08.1.06"], n: itensNotas(7).length }));
  ok(r3.f && r3.f.t === "" && r3.n === 2, "remoção: " + JSON.stringify(r3));
  ok(!p._erros.length && !p._rede.length, "erros/rede: " + JSON.stringify([p._erros, p._rede]));
  await p.context().close();
  // sem pasta e sem localStorage: salva na memória e não quebra
  const q = await abre(NOVO, "comparacao_agora.csv");
  const r4 = await q.evaluate(async () => { const ls = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("bloqueado"); };
    const ok = await salvaNota(7, "4101A", "4.1.1.08.1.06", "teste"); Storage.prototype.setItem = ls; return { ok, n: itensNotas(7).length }; });
  ok(r4.ok === false && r4.n === 1, "sem pasta/localStorage: " + JSON.stringify(r4));
  await q.context().close();
});

teste("K1", "comparar com outra base: recebeu, sumiu, mudou, orçamento, vigiada, pendências e exportação", async () => {
  const p = await abre(NOVO, "comparacao_agora.csv");
  await p.evaluate(() => abreComparacao());
  await p.setInputFiles("#cmpcorpo input[type=file]", CSV("comparacao_antes.csv"));
  await p.waitForSelector(".cmpkpis");
  const r = await p.evaluate(() => { const c = dadosComparacao();
    return { kp: [c.pendAntes, c.pendAgora, c.resolvidas, c.novas], l: c.linhas.map(l => [l.cat, l.u, l.a, l.antes, l.agora]).sort((a, b) => a[0].localeCompare(b[0])) }; });
  igual([1, 1, 1, 1], r.kp, "pendências antes/agora/resolvidas/novas");
  igual([["mudou", "4101A", "4.1.1.02.1.09", -80, -120], ["orc", "4101A", "4.1.1.07.1.01", -100, -150], ["receb", "4101A", "4.1.1.08.1.06", 0, -100],
         ["vig", "4801A", "4.1.1.02.1.09", 0, -30], ["zerou", "4101A", "4.1.1.04.1.06", -100, 0]], r.l, "categorias");
  const x = await baixa(p, () => [...document.querySelectorAll("#cmpres button")].find(b => /exportar/.test(b.textContent)).click());
  const aba = x.abas["Diferenças"];
  ok(aba[3][0] === "O que mudou" && aba.length === 9 && aba.slice(4).some(l => l[0] === "Recebeu lançamento" && l[4] === "4.1.1.08.1.06" && l[8] === -100),
     "exportação: " + JSON.stringify(aba.slice(3)));
  // clicar numa diferença abre a unidade na conta
  await p.evaluate(() => document.querySelector(".cmpcat tbody tr.clic").click());
  ok(await p.evaluate(() => view.tipo === "det" && !document.getElementById("guia").classList.contains("on")), "clique não abriu a unidade");
  // base de outro ano: avisa e não compara
  await p.evaluate(() => { BASE_B = null; abreComparacao(); });
  await p.setInputFiles("#cmpcorpo input[type=file]", CSV("ano_cab.csv"));
  await p.waitForFunction(() => /não dá para comparar|Não consegui/.test(document.getElementById("cmpres").textContent));
  ok(!p._erros.length && !p._rede.length, "erros/rede: " + JSON.stringify([p._erros, p._rede]));
  await p.context().close();
});

teste("E1", "efeitos: tela nova entra suave, janelas animadas, número que mudou pisca; 'reduzir movimento' desliga", async () => {
  const p = await abre(NOVO, "plano_sint.csv");
  const r = await p.evaluate(async () => {
    go({ tipo: "seg", seg: "CDs" });
    const trans = document.querySelector(".main").classList.contains("trans");
    const anim = getComputedStyle(document.getElementById("body")).animationName;
    const guiaT = getComputedStyle(document.getElementById("guia")).transitionProperty;
    go({ tipo: "hub" });
    const sel = document.getElementById("mes"); sel.value = String(+sel.value - 1); sel.dispatchEvent(new Event("change"));
    const piscou = document.querySelectorAll("#kpis .mudou").length;
    sel.value = String(+sel.value + 1); sel.dispatchEvent(new Event("change"));
    return { trans, anim, guiaT, piscou }; });
  ok(r.trans && r.anim === "entraTela", "entrada da tela: " + JSON.stringify(r));
  ok(/opacity/.test(r.guiaT) && /display/.test(r.guiaT), "transição das janelas: " + r.guiaT);
  ok(r.piscou > 0, "nenhum número piscou ao trocar o mês");
  await p.context().close();
  const ctx = await browser.newContext({ reducedMotion: "reduce" }); const q = await ctx.newPage();
  await q.goto("file://" + NOVO); await q.setInputFiles("#_file", CSV("plano_sint.csv")); await q.waitForSelector("#kpis .kpi");
  const s = await q.evaluate(() => { go({ tipo: "seg", seg: "CDs" });
    return { trans: document.querySelector(".main").classList.contains("trans"), anim: getComputedStyle(document.getElementById("body")).animationName,
      guia: getComputedStyle(document.getElementById("guia")).transitionDuration }; });
  ok(!s.trans && s.anim === "none" && /^0s/.test(s.guia), "reduzir movimento: " + JSON.stringify(s));
  await ctx.close();
});

/* ================================================================== */
(async () => {
  const filtro = process.argv.slice(2).filter(a => !a.startsWith("--"));
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
