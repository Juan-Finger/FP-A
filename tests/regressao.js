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
  const py = payloadBasico(JSON.parse(cp.execFileSync("python3", [path.join(__dirname, "oraculo_python.py"), CSV("plano_sint.csv")],
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
// A3: a lista "Por conta" mudou (sem receita); os dados dela são conferidos no T02 e no teste A3
TEXTO_INTENCIONAL.push(["A3", (o, n, k) => { if (k.startsWith("ct:")) { delete o.body; delete n.body; } }]);
// A4: mapa e histórico mudam para unidades que ainda não tinham começado a lançar (conferido no T02 e no A4)
TEXTO_INTENCIONAL.push(["A4", (o, n, k) => { if (k.startsWith("mp:") || /^det:.*:hist$/.test(k)) { delete o.body; delete n.body; } }]);
teste("T05", "texto visível de todas as telas idêntico ao original (estado padrão)", async () => {
  const [o, n] = await Promise.all([pagina("orig"), pagina("novo")]);
  const a = await o.evaluate(TELAS), b = await n.evaluate(TELAS);
  for (const k of Object.keys(a)) {
    const x = JSON.parse(JSON.stringify(a[k])), y = JSON.parse(JSON.stringify(b[k] || {}));
    for (const [, fn] of TEXTO_INTENCIONAL) fn(x, y, k);
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
  ok(!/https?:\/\/(?!www\.w3\.org|schemas\.openxmlformats\.org)/.test(html.replace(/xmlns(:\w+)?="[^"]+"/g, "")), "há URL externa no HTML");
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
  for (let i = 0; i < 3; i++) { await p.keyboard.press("Tab"); focos.push(await p.evaluate(() => document.activeElement.id || document.activeElement.tagName)); }
  ok(focos.every(f => f === "_file" || f === "BODY"), "Tab saiu da tela de carga: " + focos);
  await p.context().close();
});

teste("B1", "processamento da base de ~12 MB mais rápido que o original", async () => {
  const txt = new TextDecoder("windows-1252").decode(fs.readFileSync(CSV("plano_sint.csv")));
  const mede = async qual => { const p = await pagina(qual);
    return p.evaluate(t => { let m = Infinity; for (let k = 0; k < 3; k++) { const a = performance.now(); construirPayload(t); m = Math.min(m, performance.now() - a); } return m; }, txt); };
  const o = await mede("orig"), n = await mede("novo");
  console.log(`        processamento: original ${o.toFixed(0)} ms · novo ${n.toFixed(0)} ms (${(txt.length / 1e6).toFixed(1)} MB, melhor de 3)`);
  ok(n < o * 0.85, "não ficou mais rápido");
});

teste("A7", "carimbo usa a data do arquivo e avisa base velha", async () => {
  const velho = CSV("base_velha.csv");
  fs.copyFileSync(CSV("so_orcado.csv"), velho);
  const t = (Date.now() - 60 * 86400000) / 1000; fs.utimesSync(velho, t, t);
  let p = await abre(NOVO, "base_velha.csv");
  let g = await p.evaluate(() => document.getElementById("gerado").innerText);
  ok(/base_velha\.csv/.test(g) && /Arquivo de/.test(g) && /há 60 dias/.test(g), "carimbo: " + g);
  await p.context().close();
  p = await pagina("novo");
  g = await p.evaluate(() => document.getElementById("gerado").innerText);
  ok(!/desatualizado/.test(g), "base nova marcada como velha: " + g);
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

teste("A11", "unidade vigiada nunca abre no detalhe (sem métricas) nem quebra a exportação", async () => {
  const p = await pagina("novo");
  const r = await p.evaluate(() => { const v = DB.units.find(u => u.vig);
    go({ tipo: "det", seg: v.seg, unit: v.cod }); const t1 = view.tipo;
    go({ tipo: "hub" }); abreConta(v.cod, DB.accts[0].cod); const t2 = view.tipo;
    let erro = null; try { view.unit = v.cod; exportUnidade(); } catch (e) { erro = e.message; }
    go({ tipo: "hub" }); return { t1, t2, erro }; });
  igual({ t1: "exc", t2: "exc", erro: null }, r, "vigiada");
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
    const passos = [["hub", () => go({ tipo: "hub" })], ["seg", () => go({ tipo: "seg", seg: segs[1] })], ["ct", () => { setVseg("ct"); toggleConta(contasDoSegmento(segs[1])[0].a); }], ["mp", () => setVseg("mp")],
      ["det", () => { setVseg("un"); go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos"); toggleExp(linhas()[0].a); }], ["det-var", () => setAba("var")], ["det-res", () => setAba("res")], ["det-sin", () => setAba("sin")], ["det-hist", () => setAba("hist")],
      ["exc", () => go({ tipo: "exc" })], ["lastro", () => go({ tipo: "lastro" })], ["lsorc", () => go({ tipo: "lsorc" })],
      ["tooltip", () => { go({ tipo: "hub" }); const k = document.querySelectorAll(".kpi")[1]; k.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 300, clientY: 200 })); }],
      ["busca", () => { document.querySelector(".tip").style.display = "none"; abrePal(); montaPal("conta"); }], ["guia", () => { fechaPal(); abreGuia(); }], ["carga", () => { fechaGuia(); abreCarga(); }]];
    for (const [k, f] of passos) { f(); const a = eval("(" + window.__AUDITA__ + ")")(lim); if (a.length) res[k] = a; }
    fechaGuia(); go({ tipo: "hub" });
    return res;
  }, limite);
}
teste("C6", "C1/C2/C6: contraste WCAG AA e fonte ≥ 11px em todas as telas, nos temas escuro e claro", async () => {
  const falhas = [];
  for (const tema of ["escuro", "claro"]) {
    const p = await abre(NOVO, "plano_sint.csv");
    await p.evaluate(([t, f]) => { window.__AUDITA__ = f; if (t === "claro") document.body.classList.add("claro"); else document.body.classList.remove("claro"); }, [tema, AUDITA_CONTRASTE.toString()]);
    const r = await auditaTelas(p);
    for (const [k, v] of Object.entries(r)) falhas.push(`[${tema}/${k}] ${v.length} texto(s): ` + v.slice(0, 4).join(" · "));
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
  ok(r.esc === "#AA7AD3" && r.cla === "#7A5195", JSON.stringify(r));
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
    const telas = [() => go({ tipo: "hub" }), () => go({ tipo: "seg", seg: segs[0] }), () => setVseg("ct"), () => setVseg("mp"), () => setVseg("un"),
      () => { go({ tipo: "det", seg: umap[u].seg, unit: u }); setF("todos"); }, () => go({ tipo: "lastro" }), () => go({ tipo: "exc" })];
    for (const f of telas) { f(); await Promise.resolve(); document.querySelectorAll("[onclick],th[data-k]").forEach(el => { if (el.tabIndex < 0 && !el.closest("[inert]") && el.getBoundingClientRect().width) out.add(el.tagName + "." + el.className.split(" ")[0]); }); }
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
