/* Módulo do painel: aba "historico" — evolução diária das métricas em gráficos SVG puros.
   Contrato: IIFE pura, ES5, sem libs externas. Depende de window.PANEL.
   Fonte dos dados: GET /api/crm/historico (fotos gravadas por /api/crm/snapshot). */
(function () {
  var container = null;
  var dados = null;          /* { serie: [], baseline: {} } */
  var periodo = 30;          /* 7 | 14 | 30 */
  var carregando = false;
  var enviandoFoto = false;
  var cssInjetado = false;
  var seqGrad = 0;           /* ids únicos para os gradientes do SVG */

  var CORES = {
    azul:      { hex: '#2E6BFF', rgb: '46,107,255' },
    verde:     { hex: '#22C55E', rgb: '34,197,94' },
    vermelho:  { hex: '#E11D3C', rgb: '225,29,60' }
  };

  /* área de desenho dentro do viewBox 0..100 (o preenchimento desce até 100) */
  var TOPO = 9;
  var BASE = 89;

  /* ---------- utilitários ---------- */

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function numOuNulo(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    return (isNaN(n) || !isFinite(n)) ? null : n;
  }

  function agrupar(inteiro) {
    var out = '';
    var c = 0;
    for (var i = inteiro.length - 1; i >= 0; i--) {
      out = inteiro.charAt(i) + out;
      c++;
      if (c % 3 === 0 && i > 0) out = '.' + out;
    }
    return out;
  }

  function fmtMoeda(v) {
    if (v === null || v === undefined) return '—';
    var abs = Math.abs(v).toFixed(2);
    var partes = abs.split('.');
    return (v < 0 ? '-' : '') + 'R$ ' + agrupar(partes[0]) + ',' + partes[1];
  }

  function fmtInteiro(v) {
    if (v === null || v === undefined) return '—';
    return agrupar(String(Math.round(v)));
  }

  function fmtValor(v, tipo) {
    return tipo === 'moeda' ? fmtMoeda(v) : fmtInteiro(v);
  }

  function fmtPct(p) {
    var s = Math.abs(p).toFixed(1).replace('.', ',');
    return (p >= 0 ? '+' : '−') + s + '%';
  }

  function fmtDdMm(d) {
    /* 'YYYY-MM-DD' → 'dd/mm' */
    if (!d || d.length < 10) return '';
    return d.slice(8, 10) + '/' + d.slice(5, 7);
  }

  /* ---------- CSS ---------- */

  function injetarCss() {
    if (cssInjetado) return;
    cssInjetado = true;
    var style = document.createElement('style');
    style.setAttribute('data-mod', 'historico');
    style.textContent =
      '.hi-topo{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px}' +
      '.hi-pills{display:flex;gap:6px;flex:1 1 auto}' +
      '.hi-pill{background:transparent;border:1px solid var(--borda,#1E2B5A);color:var(--texto2,#9AAAD0);' +
        'padding:7px 13px;font-size:12.5px;font-weight:600;border-radius:999px;white-space:nowrap;cursor:pointer;' +
        'transition:background .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease}' +
      '.hi-pill:hover{color:var(--texto,#F1F5FF);border-color:var(--borda2,#2B3C74)}' +
      '.hi-pill:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.hi-pill.ativa{background:rgba(46,107,255,.14);color:var(--branco,#FFF);border-color:rgba(46,107,255,.45);' +
        'box-shadow:0 0 18px rgba(46,107,255,.18)}' +
      '.hi-grid{display:grid;grid-template-columns:1fr;gap:12px}' +
      '.hi-card{position:relative;padding:14px 14px 10px}' +
      '.hi-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}' +
      '.hi-tit{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--texto2,#9AAAD0)}' +
      '.hi-val{font-size:24px;font-weight:800;color:var(--branco,#FFF);line-height:1.15;margin-top:5px}' +
      '.hi-var{margin-left:auto;flex:0 0 auto;font-size:11.5px;font-weight:700;padding:4px 9px;border-radius:999px;' +
        'white-space:nowrap;display:inline-flex;align-items:center;gap:4px;margin-top:2px}' +
      '.hi-var-bom{color:#5BE08C;background:rgba(34,197,94,.13)}' +
      '.hi-var-ruim{color:var(--vermelho-claro,#FF4767);background:rgba(225,29,60,.13)}' +
      '.hi-var-neutro{color:var(--texto2,#9AAAD0);background:rgba(92,107,149,.18)}' +
      '.hi-plot{position:relative;height:104px;margin:0 -2px}' +
      '.hi-svg{position:absolute;top:0;left:0;width:100%;height:100%;display:block;overflow:visible}' +
      '.hi-dot{position:absolute;width:9px;height:9px;border-radius:50%;transform:translate(-50%,-50%);' +
        'border:2px solid var(--card,#0E1738);pointer-events:none}' +
      '.hi-basetag{position:absolute;right:0;transform:translateY(-50%);font-size:9.5px;font-weight:600;' +
        'color:var(--texto2,#9AAAD0);background:var(--card,#0E1738);padding:0 4px;border-radius:4px;' +
        'pointer-events:none;white-space:nowrap}' +
      '.hi-hover{position:absolute;top:0;bottom:0;width:1px;background:var(--borda2,#2B3C74);' +
        'pointer-events:none;display:none}' +
      '.hi-tip{position:absolute;top:0;transform:translate(-50%,-4px);background:var(--card2,#131E45);' +
        'border:1px solid var(--borda2,#2B3C74);border-radius:8px;padding:4px 8px;font-size:11.5px;' +
        'color:var(--texto,#F1F5FF);white-space:nowrap;pointer-events:none;display:none;z-index:2;' +
        'box-shadow:0 6px 18px rgba(0,0,0,.45)}' +
      '.hi-tip b{color:var(--branco,#FFF)}' +
      '.hi-tip span{color:var(--texto2,#9AAAD0);margin-right:5px}' +
      '.hi-eixo{position:relative;height:15px;margin-top:6px}' +
      '.hi-eixo span{position:absolute;top:0;font-size:10.5px;color:var(--texto2,#9AAAD0);white-space:nowrap}' +
      '.hi-vazio{text-align:center;padding:26px 14px}' +
      '.hi-vazio h3{font-size:15px;color:var(--texto,#F1F5FF);font-weight:700;margin:0 0 8px}' +
      '.hi-vazio p{color:var(--texto2,#9AAAD0);font-size:13.5px;line-height:1.55;margin:0 auto 14px;max-width:420px}' +
      '.hi-rodape{color:var(--texto2,#9AAAD0);font-size:12px;margin:10px 2px 0}' +
      '@media (min-width:720px){.hi-grid{grid-template-columns:1fr 1fr}.hi-plot{height:118px}}';
    document.head.appendChild(style);
  }

  /* ---------- escala e caminhos ---------- */

  function escalaY(valores, baseline) {
    var min = null, max = null, i, v;
    for (i = 0; i < valores.length; i++) {
      v = valores[i];
      if (v === null) continue;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
    if (min === null) return null;
    var minReal = min;
    if (baseline !== null) {
      if (baseline < min) min = baseline;
      if (baseline > max) max = baseline;
    }
    if (max === min) {
      var d = Math.abs(max) * 0.2 || 1;
      min -= d;
      max += d;
    } else {
      var pad = (max - min) * 0.18;
      min -= pad;
      max += pad;
    }
    /* métrica não-negativa nunca desce abaixo de zero na escala */
    if (min < 0 && minReal >= 0) min = 0;
    if (max === min) max = min + 1;
    return { min: min, max: max };
  }

  function paraY(v, escala) {
    return TOPO + ((escala.max - v) / (escala.max - escala.min)) * (BASE - TOPO);
  }

  function paraX(i, n) {
    return n > 1 ? (i / (n - 1)) * 100 : 50;
  }

  function caminhoLinha(pts) {
    var d = '';
    for (var i = 0; i < pts.length; i++) {
      d += (i === 0 ? 'M' : 'L') + pts[i].x.toFixed(2) + ' ' + pts[i].y.toFixed(2);
    }
    return d;
  }

  function caminhoArea(pts) {
    return caminhoLinha(pts) +
      'L' + pts[pts.length - 1].x.toFixed(2) + ' 100' +
      'L' + pts[0].x.toFixed(2) + ' 100Z';
  }

  /* ---------- eixo X ---------- */

  function indicesEixo(n) {
    var out = [], i, idx;
    if (n <= 0) return out;
    if (n === 1) return [0];
    var max = 6;
    if (n <= max) {
      for (i = 0; i < n; i++) out.push(i);
      return out;
    }
    for (i = 0; i < max; i++) {
      idx = Math.round((i * (n - 1)) / (max - 1));
      if (!out.length || out[out.length - 1] !== idx) out.push(idx);
    }
    return out;
  }

  function htmlEixo(serie) {
    var n = serie.length;
    var idxs = indicesEixo(n);
    var h = '';
    for (var k = 0; k < idxs.length; k++) {
      var i = idxs[k];
      var x = paraX(i, n);
      var estilo;
      if (x <= 0.01) estilo = 'left:0';
      else if (x >= 99.99) estilo = 'right:0';
      else estilo = 'left:' + x.toFixed(2) + '%;transform:translateX(-50%)';
      h += '<span style="' + estilo + '">' + esc(fmtDdMm(serie[i].data)) + '</span>';
    }
    return h;
  }

  /* ---------- um gráfico ---------- */

  /* cfg: { titulo, campo, tipo, maiorMelhor, baseline, rotuloBase } */
  function htmlGrafico(serie, cfg) {
    var n = serie.length;
    var valores = [];
    var i;
    for (i = 0; i < n; i++) valores.push(numOuNulo(serie[i][cfg.campo]));

    /* primeiro e último valores válidos do período */
    var primeiro = null, ultimo = null, iPrimeiro = -1, iUltimo = -1;
    for (i = 0; i < n; i++) {
      if (valores[i] === null) continue;
      if (primeiro === null) { primeiro = valores[i]; iPrimeiro = i; }
      ultimo = valores[i];
      iUltimo = i;
    }

    /* variação vs o primeiro ponto do período (precisa de dois pontos com valor) */
    var variacao = null;
    if (primeiro !== null && iUltimo > iPrimeiro && primeiro !== 0) {
      variacao = ((ultimo - primeiro) / Math.abs(primeiro)) * 100;
    }
    var subiu = variacao !== null && variacao > 0.05;
    var caiu = variacao !== null && variacao < -0.05;
    var bom = cfg.maiorMelhor ? subiu : caiu;
    var ruim = cfg.maiorMelhor ? caiu : subiu;

    /* cor: azul para gasto/leads; verde/vermelho conforme a tendência em CPL/CPM */
    var cor = CORES.azul;
    if (!cfg.maiorMelhor) {
      if (caiu) cor = CORES.verde;
      else if (subiu) cor = CORES.vermelho;
    }

    var baseVal = (cfg.baseline === null || cfg.baseline === undefined) ? null : cfg.baseline;
    var escala = escalaY(valores, baseVal);

    /* cabeçalho */
    var clsVar = bom ? 'hi-var-bom' : (ruim ? 'hi-var-ruim' : 'hi-var-neutro');
    var seta = subiu ? '▲' : (caiu ? '▼' : '■');
    var htmlVar = variacao === null
      ? '<span class="hi-var hi-var-neutro" title="Sem ponto anterior no período para comparar">sem base</span>'
      : '<span class="hi-var ' + clsVar + '" title="Variação vs ' + esc(fmtDdMm(serie[iPrimeiro].data)) + '">' +
          '<span aria-hidden="true">' + seta + '</span>' + esc(fmtPct(variacao)) + '</span>';

    var h = '<div class="card hi-card">' +
      '<div class="hi-head"><div>' +
        '<div class="hi-tit">' + esc(cfg.titulo) + '</div>' +
        '<div class="hi-val">' + esc(fmtValor(ultimo, cfg.tipo)) + '</div>' +
      '</div>' + htmlVar + '</div>';

    if (!escala) {
      h += '<div class="hi-plot"></div><div class="hi-eixo"></div></div>';
      return h;
    }

    /* pontos com valor — dia sem valor (CPL sem lead, por exemplo) não vira zero inventado */
    var pts = [];
    for (i = 0; i < n; i++) {
      if (valores[i] === null) continue;
      pts.push({ x: paraX(i, n), y: paraY(valores[i], escala), i: i, v: valores[i] });
    }

    var idGrad = 'hi-grad-' + (++seqGrad);
    var yBase = baseVal === null ? null : paraY(baseVal, escala);

    var svg = '<svg class="hi-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="' + idGrad + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + cor.hex + '" stop-opacity="0.32"/>' +
        '<stop offset="100%" stop-color="' + cor.hex + '" stop-opacity="0"/>' +
      '</linearGradient></defs>';
    if (yBase !== null) {
      svg += '<line x1="0" y1="' + yBase.toFixed(2) + '" x2="100" y2="' + yBase.toFixed(2) + '" ' +
        'stroke="#9AAAD0" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="4 4" ' +
        'vector-effect="non-scaling-stroke"/>';
    }
    if (pts.length > 1) {
      svg += '<path d="' + caminhoArea(pts) + '" fill="url(#' + idGrad + ')"/>' +
        '<path d="' + caminhoLinha(pts) + '" fill="none" stroke="' + cor.hex + '" stroke-width="2" ' +
        'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }
    svg += '</svg>';

    var extras = '';
    if (yBase !== null && cfg.rotuloBase) {
      extras += '<span class="hi-basetag" style="top:' + yBase.toFixed(2) + '%">' + esc(cfg.rotuloBase) + '</span>';
    }
    if (pts.length) {
      var ult = pts[pts.length - 1];
      extras += '<span class="hi-dot" style="left:' + ult.x.toFixed(2) + '%;top:' + ult.y.toFixed(2) + '%;' +
        'background:' + cor.hex + ';box-shadow:0 0 0 4px rgba(' + cor.rgb + ',.20)"></span>';
    }
    extras += '<div class="hi-hover"></div><div class="hi-tip"></div>';

    h += '<div class="hi-plot" data-campo="' + esc(cfg.campo) + '" data-tipo="' + esc(cfg.tipo) + '">' +
      svg + extras + '</div>' +
      '<div class="hi-eixo">' + htmlEixo(serie) + '</div>' +
      '</div>';
    return h;
  }

  /* ---------- tabela ---------- */

  function htmlTabela(serie) {
    var h = '<h2 class="sec">Dias registrados</h2>' +
      '<div class="tabela-wrap"><table>' +
      '<thead><tr><th>Data</th><th class="num">Gasto</th><th class="num">Cliques</th>' +
      '<th class="num">Leads</th><th class="num">CPL</th></tr></thead><tbody>';
    for (var i = serie.length - 1; i >= 0; i--) {
      var r = serie[i];
      h += '<tr>' +
        '<td>' + esc(fmtDdMm(r.data)) + '</td>' +
        '<td class="num">' + esc(fmtMoeda(numOuNulo(r.gasto))) + '</td>' +
        '<td class="num">' + esc(fmtInteiro(numOuNulo(r.cliques))) + '</td>' +
        '<td class="num">' + esc(fmtInteiro(numOuNulo(r.leads))) + '</td>' +
        '<td class="num">' + esc(fmtMoeda(numOuNulo(r.cpl))) + '</td>' +
        '</tr>';
    }
    return h + '</tbody></table></div>';
  }

  /* ---------- render ---------- */

  function botaoFoto(classeExtra) {
    return '<button type="button" class="btn ' + classeExtra + '" data-acao="foto"' +
      (enviandoFoto ? ' disabled' : '') + '>' +
      (enviandoFoto ? 'Registrando...' : 'Registrar foto de hoje') + '</button>';
  }

  function htmlPills() {
    var opcoes = [7, 14, 30];
    var h = '<div class="hi-pills" role="group" aria-label="Período do histórico">';
    for (var i = 0; i < opcoes.length; i++) {
      h += '<button type="button" class="hi-pill' + (periodo === opcoes[i] ? ' ativa' : '') + '" ' +
        'data-dias="' + opcoes[i] + '"' + (periodo === opcoes[i] ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        opcoes[i] + ' dias</button>';
    }
    return h + '</div>';
  }

  function render() {
    if (!container) return;
    var serie = (dados && dados.serie) ? dados.serie : [];
    var base = (dados && dados.baseline) ? dados.baseline : {};
    var baseCpl = numOuNulo(base.cpl);
    var baseCpm = numOuNulo(base.cpm);

    if (!serie.length) {
      container.innerHTML = '<div class="card hi-vazio">' +
        '<h3>Nenhuma foto guardada ainda</h3>' +
        '<p>O painel guarda uma foto das métricas todo dia às 8h — é com essas fotos que os ' +
        'gráficos são montados. Como a primeira ainda não foi tirada, não há o que comparar. ' +
        'Você pode forçar a de hoje agora mesmo.</p>' +
        botaoFoto('btn-acento') +
        '</div>';
      ligarEventos();
      return;
    }

    var periodoSerie = serie.slice(Math.max(0, serie.length - periodo));

    var html = '<div class="hi-topo">' + htmlPills() + botaoFoto('btn-acento') + '</div>' +
      '<div class="hi-grid">' +
      htmlGrafico(periodoSerie, { titulo: 'Gasto', campo: 'gasto', tipo: 'moeda', maiorMelhor: true, baseline: null, rotuloBase: null }) +
      htmlGrafico(periodoSerie, { titulo: 'Leads', campo: 'leads', tipo: 'inteiro', maiorMelhor: true, baseline: null, rotuloBase: null }) +
      htmlGrafico(periodoSerie, { titulo: 'CPL', campo: 'cpl', tipo: 'moeda', maiorMelhor: false, baseline: baseCpl, rotuloBase: baseCpl === null ? null : 'base ' + fmtMoeda(baseCpl) }) +
      htmlGrafico(periodoSerie, { titulo: 'CPM', campo: 'cpm', tipo: 'moeda', maiorMelhor: false, baseline: baseCpm, rotuloBase: baseCpm === null ? null : 'base ' + fmtMoeda(baseCpm) }) +
      '</div>' +
      '<p class="hi-rodape">' + periodoSerie.length + (periodoSerie.length === 1 ? ' dia' : ' dias') +
      ' no período · ' + serie.length + (serie.length === 1 ? ' foto guardada' : ' fotos guardadas') +
      ' · a linha tracejada marca o baseline pré-consolidação.</p>' +
      htmlTabela(periodoSerie);

    container.innerHTML = html;
    ligarEventos();
    ligarHover(periodoSerie);
  }

  /* ---------- eventos ---------- */

  function ligarEventos() {
    var i;
    var pills = container.querySelectorAll('.hi-pill');
    for (i = 0; i < pills.length; i++) {
      pills[i].addEventListener('click', function () {
        var d = parseInt(this.getAttribute('data-dias'), 10);
        if (!d || d === periodo) return;
        periodo = d;
        render();
      });
    }
    var botoes = container.querySelectorAll('button[data-acao="foto"]');
    for (i = 0; i < botoes.length; i++) {
      botoes[i].addEventListener('click', registrarFoto);
    }
  }

  /* crosshair + tooltip: o SVG é esticado, então a leitura é feita em % da largura */
  function ligarHover(serie) {
    var plots = container.querySelectorAll('.hi-plot[data-campo]');
    var n = serie.length;
    for (var p = 0; p < plots.length; p++) {
      (function (plot) {
        var linha = plot.querySelector('.hi-hover');
        var tip = plot.querySelector('.hi-tip');
        var campo = plot.getAttribute('data-campo');
        var tipo = plot.getAttribute('data-tipo');
        if (!linha || !tip) return;

        function mover(e) {
          var r = plot.getBoundingClientRect();
          if (!r.width) return;
          var px = ((e.clientX - r.left) / r.width) * 100;
          var i = n > 1 ? Math.round((px / 100) * (n - 1)) : 0;
          if (i < 0) i = 0;
          if (i > n - 1) i = n - 1;
          var reg = serie[i];
          if (!reg) return;
          var x = paraX(i, n);
          linha.style.left = x.toFixed(2) + '%';
          linha.style.display = 'block';
          tip.innerHTML = '<span>' + esc(fmtDdMm(reg.data)) + '</span><b>' +
            esc(fmtValor(numOuNulo(reg[campo]), tipo)) + '</b>';
          tip.style.left = Math.min(88, Math.max(12, x)).toFixed(2) + '%';
          tip.style.display = 'block';
        }
        function sair() {
          linha.style.display = 'none';
          tip.style.display = 'none';
        }
        plot.addEventListener('mousemove', mover);
        plot.addEventListener('mouseleave', sair);
      })(plots[p]);
    }
  }

  function registrarFoto() {
    if (enviandoFoto) return;
    enviandoFoto = true;
    var botoes = container.querySelectorAll('button[data-acao="foto"]');
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].disabled = true;
      botoes[i].textContent = 'Registrando...';
    }
    PANEL.api('/api/crm/snapshot', { method: 'POST', body: '{}' }).then(function (r) {
      enviandoFoto = false;
      if (!r || !r.ok) throw new Error('falha');
      carregar(true);
    }).catch(function (err) {
      enviandoFoto = false;
      if (err && err.message === 'unauthorized') return;
      alert('Não foi possível registrar a foto de hoje. A leitura da Meta pode estar indisponível — tente de novo em alguns minutos.');
      render();
    });
  }

  /* ---------- carga ---------- */

  function normalizar(serie) {
    var out = [];
    for (var i = 0; i < serie.length; i++) {
      var r = serie[i];
      if (!r || typeof r.data !== 'string') continue;
      out.push({
        data: r.data,
        gasto: numOuNulo(r.gasto),
        impressoes: numOuNulo(r.impressoes),
        cliques: numOuNulo(r.cliques),
        ctr: numOuNulo(r.ctr),
        cpm: numOuNulo(r.cpm),
        leads: numOuNulo(r.leads),
        cpl: numOuNulo(r.cpl)
      });
    }
    out.sort(function (a, b) {
      if (a.data < b.data) return -1;
      if (a.data > b.data) return 1;
      return 0;
    });
    return out;
  }

  function carregar(forcar) {
    container = PANEL.el('historicoConteudo');
    if (!container) return;
    injetarCss();
    if (dados && !forcar) {
      render();
      return;
    }
    if (carregando) return;
    carregando = true;
    container.innerHTML = PANEL.skeleton([42, 190, 190, 140]);
    PANEL.api('/api/crm/historico').then(function (resp) {
      carregando = false;
      dados = {
        serie: normalizar((resp && resp.serie) || []),
        baseline: (resp && resp.baseline) || {}
      };
      render();
    }).catch(function (err) {
      carregando = false;
      if (err && err.message === 'unauthorized') return;
      PANEL.renderErro(container, function () { carregar(true); });
    });
  }

  PANEL.registrar('historico', { carregar: carregar });
})();
