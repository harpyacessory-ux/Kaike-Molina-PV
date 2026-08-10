/* Módulo do painel: aba "atividade" — linha do tempo de rastreabilidade
   (ações aplicadas, decisões, notificações e atividade do robô).
   Também injeta o sino de notificações no cabeçalho do painel, que vive
   independente da aba: sobe junto com o script.
   Contrato: IIFE pura, ES5, sem libs externas. Depende de window.PANEL. */
(function () {
  var container = null;
  var dados = null;
  var carregando = false;
  var cssInjetado = false;
  var filtro = 'tudo';

  /* estado do sino */
  var sinoIniciado = false;
  var sinoEls = null;          /* { wrap, botao, contador, menu } */
  var sinoNotifs = [];
  var sinoNaoLidas = 0;
  var sinoBuscando = false;
  var sinoMenuAberto = false;
  var tmrRapido = null;
  var CHAVE_LIDAS = 'crm_notif_lidas_ate';

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

  function temChave() {
    try { return !!localStorage.getItem('panel_key'); } catch (e) { return false; }
  }

  function lidasAte() {
    try {
      var v = parseInt(localStorage.getItem(CHAVE_LIDAS), 10);
      return isFinite(v) ? v : 0;
    } catch (e) { return 0; }
  }

  function gravarLidasAte(ms) {
    try { localStorage.setItem(CHAVE_LIDAS, String(ms)); } catch (e) {}
  }

  /* aceita epoch em ms, em segundos ou texto ISO */
  function paraMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    if (typeof v === 'number') {
      if (!isFinite(v) || v <= 0) return null;
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    var n = Date.parse(v);
    return isNaN(n) ? null : n;
  }

  function plural(n, sing, plu) {
    return n + ' ' + (n === 1 ? sing : plu);
  }

  function fmtRelativo(ms) {
    if (ms === null || ms === undefined) return 'sem data';
    var d = Date.now() - ms;
    if (d < 0) d = 0;
    var seg = Math.floor(d / 1000);
    if (seg < 60) return 'agora';
    var min = Math.floor(seg / 60);
    if (min < 60) return 'há ' + min + ' min';
    var hor = Math.floor(min / 60);
    if (hor < 24) return 'há ' + hor + ' h';
    var dia = Math.floor(hor / 24);
    if (dia < 30) return 'há ' + plural(dia, 'dia', 'dias');
    var mes = Math.floor(dia / 30);
    if (mes < 12) return 'há ' + (mes === 1 ? '1 mês' : mes + ' meses');
    var ano = Math.floor(mes / 12);
    return 'há ' + plural(ano, 'ano', 'anos');
  }

  function dois(n) { return ('0' + n).slice(-2); }

  function fmtCompleto(ms) {
    if (ms === null || ms === undefined) return 'Sem data registrada';
    var d = new Date(ms);
    return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' às ' + dois(d.getHours()) + ':' + dois(d.getMinutes());
  }

  /* ---------- CSS ---------- */

  function injetarCss() {
    if (cssInjetado) return;
    cssInjetado = true;
    var style = document.createElement('style');
    style.setAttribute('data-mod', 'atividade');
    style.textContent =
      /* topo: filtros + atualizar */
      '.at-topo{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:14px}' +
      '.at-filtros{display:flex;flex-wrap:wrap;gap:6px;min-width:0}' +
      '.at-pill{background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);color:var(--texto2,#9AAAD0);padding:7px 13px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap;transition:background .18s ease,border-color .18s ease,color .18s ease,box-shadow .18s ease}' +
      '.at-pill:hover{color:var(--texto,#F1F5FF);border-color:var(--borda2,#2B3C74)}' +
      '.at-pill.at-on{background:rgba(46,107,255,.14);border-color:rgba(46,107,255,.45);color:var(--branco,#FFF);box-shadow:0 0 18px rgba(46,107,255,.20)}' +
      '.at-pill-n{margin-left:6px;font-weight:800;opacity:.72;font-size:11.5px}' +
      '.at-resumo{color:var(--texto2,#9AAAD0);font-size:12.5px;margin:0 0 12px 2px}' +
      /* linha do tempo */
      '.at-linha{list-style:none;margin:0;padding:0}' +
      '.at-item{position:relative;padding:0 0 18px 26px}' +
      '.at-item:last-child{padding-bottom:2px}' +
      '.at-item::before{content:"";position:absolute;left:5px;top:18px;bottom:0;width:2px;border-radius:2px;background:linear-gradient(180deg,var(--borda,#1E2B5A),rgba(30,43,90,.15))}' +
      '.at-item:last-child::before{display:none}' +
      '.at-marca{position:absolute;left:0;top:5px;width:12px;height:12px;border-radius:50%;background:var(--cinza,#5C6B95);box-shadow:0 0 0 3px rgba(92,107,149,.16)}' +
      '.at-acao .at-marca{background:var(--azul,#2E6BFF);box-shadow:0 0 0 3px rgba(46,107,255,.18)}' +
      '.at-decisao .at-marca{background:var(--roxo,#7C3AED);box-shadow:0 0 0 3px rgba(124,58,237,.20)}' +
      '.at-notificacao .at-marca{background:var(--amarelo,#F5B301);box-shadow:0 0 0 3px rgba(245,179,1,.18)}' +
      '.at-robo .at-marca{background:var(--verde,#22C55E);box-shadow:0 0 0 3px rgba(34,197,94,.18)}' +
      '.at-falhou .at-marca{background:var(--vermelho,#E11D3C);box-shadow:0 0 0 3px rgba(225,29,60,.20)}' +
      '.at-cab{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}' +
      '.at-titulo{color:var(--texto,#F1F5FF);font-size:14px;font-weight:600;line-height:1.35;word-wrap:break-word;overflow-wrap:break-word;min-width:0}' +
      '.at-hora{color:var(--cinza,#5C6B95);font-size:11.5px;white-space:nowrap;margin-left:auto;cursor:default}' +
      '.at-detalhe{color:var(--texto2,#9AAAD0);font-size:12.5px;line-height:1.45;margin-top:3px;word-wrap:break-word;overflow-wrap:break-word}' +
      '.at-tag{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;margin-top:6px}' +
      '.at-acao .at-tag{color:var(--azul-claro,#6098FF);background:rgba(46,107,255,.12);border:1px solid rgba(46,107,255,.32)}' +
      '.at-decisao .at-tag{color:#B695FF;background:rgba(124,58,237,.14);border:1px solid rgba(124,58,237,.34)}' +
      '.at-notificacao .at-tag{color:var(--amarelo,#F5B301);background:rgba(245,179,1,.12);border:1px solid rgba(245,179,1,.32)}' +
      '.at-robo .at-tag{color:var(--verde,#22C55E);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.32)}' +
      '.at-tag-erro{color:var(--vermelho-claro,#FF4767);background:rgba(225,29,60,.12);border:1px solid rgba(225,29,60,.38);margin-left:6px}' +
      /* vazio */
      '.at-vazio{text-align:center;padding:34px 14px;color:var(--texto2,#9AAAD0)}' +
      '.at-vazio-icone{font-size:26px;line-height:1;margin-bottom:8px;opacity:.75}' +
      '.at-vazio-txt{font-size:14px;color:var(--texto,#F1F5FF);font-weight:600}' +
      '.at-vazio-sub{font-size:12.5px;margin-top:5px}' +
      /* sino no cabeçalho */
      '.at-sino-wrap{position:relative;display:flex;flex:0 0 auto}' +
      '.at-sino{position:relative;display:inline-flex;align-items:center;justify-content:center;width:38px;height:34px;background:var(--card2,#131E45);border:1px solid var(--borda,#1E2B5A);border-radius:10px;color:var(--texto2,#9AAAD0);padding:0;transition:border-color .18s ease,color .18s ease,box-shadow .18s ease}' +
      '.at-sino:hover,.at-sino.at-aberto{border-color:var(--azul,#2E6BFF);color:var(--branco,#FFF);box-shadow:0 0 14px rgba(46,107,255,.20)}' +
      '.at-sino svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block}' +
      '.at-sino-n{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:var(--vermelho,#E11D3C);color:#fff;font-size:10.5px;font-weight:800;line-height:1;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg,#060B1F);box-shadow:0 0 10px rgba(225,29,60,.45)}' +
      '.at-sino-n[hidden]{display:none}' +
      '.at-sino-menu{position:absolute;right:0;top:calc(100% + 9px);width:320px;max-width:calc(100vw - 28px);background:var(--card,#0E1738);border:1px solid var(--borda2,#2B3C74);border-radius:14px;box-shadow:var(--sombra,0 10px 30px rgba(0,0,0,.45));z-index:80;overflow:hidden}' +
      '.at-sino-menu[hidden]{display:none}' +
      '.at-menu-topo{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border-bottom:1px solid var(--borda,#1E2B5A);background:var(--card2,#131E45)}' +
      '.at-menu-titulo{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--texto2,#9AAAD0)}' +
      '.at-menu-lidas{background:none;border:none;color:var(--azul-claro,#6098FF);font-size:12px;font-weight:600;padding:2px 4px;border-radius:8px;white-space:nowrap}' +
      '.at-menu-lidas:hover{color:var(--branco,#FFF)}' +
      '.at-menu-lidas[disabled]{opacity:.45;cursor:not-allowed}' +
      '.at-menu-lista{list-style:none;margin:0;padding:0;max-height:328px;overflow-y:auto}' +
      '.at-menu-item{display:flex;gap:9px;padding:10px 13px;border-bottom:1px solid rgba(30,43,90,.55)}' +
      '.at-menu-item:last-child{border-bottom:none}' +
      '.at-menu-ponto{flex:0 0 auto;width:7px;height:7px;border-radius:50%;margin-top:6px;background:transparent}' +
      '.at-menu-nova .at-menu-ponto{background:var(--azul,#2E6BFF);box-shadow:0 0 8px rgba(46,107,255,.6)}' +
      '.at-menu-corpo{min-width:0;flex:1 1 auto}' +
      '.at-menu-t{font-size:13px;color:var(--texto,#F1F5FF);line-height:1.35;word-wrap:break-word;overflow-wrap:break-word}' +
      '.at-menu-nova .at-menu-t{font-weight:700}' +
      '.at-menu-d{font-size:11.5px;color:var(--texto2,#9AAAD0);margin-top:2px;word-wrap:break-word;overflow-wrap:break-word}' +
      '.at-menu-h{font-size:11px;color:var(--cinza,#5C6B95);margin-top:3px}' +
      '.at-menu-vazio{padding:22px 14px;text-align:center;color:var(--texto2,#9AAAD0);font-size:13px}' +
      '.at-menu-rodape{padding:9px 13px;border-top:1px solid var(--borda,#1E2B5A);text-align:center;background:var(--bg2,#0A1230)}' +
      '.at-menu-todas{background:none;border:none;color:var(--azul-claro,#6098FF);font-size:12.5px;font-weight:600;padding:3px 6px;border-radius:8px}' +
      '.at-menu-todas:hover{color:var(--branco,#FFF)}' +
      '@media (max-width:520px){.at-hora{margin-left:0;width:100%}}';
    document.head.appendChild(style);
  }

  /* ---------- aba: render ---------- */

  var ROTULOS = { acao: 'Ação', decisao: 'Decisão', notificacao: 'Notificação', robo: 'Robô' };

  var FILTROS = [
    { chave: 'tudo', nome: 'Tudo' },
    { chave: 'acao', nome: 'Ações' },
    { chave: 'decisao', nome: 'Decisões' },
    { chave: 'notificacao', nome: 'Notificações' },
    { chave: 'robo', nome: 'Robô' }
  ];

  function itensDe(dados) {
    return (dados && dados.itens && dados.itens.length) ? dados.itens : [];
  }

  function contar(itens) {
    var c = { tudo: itens.length, acao: 0, decisao: 0, notificacao: 0, robo: 0 };
    for (var i = 0; i < itens.length; i++) {
      var tipo = itens[i] && itens[i].tipo;
      if (tipoValido(tipo)) c[tipo]++;
    }
    return c;
  }

  function tipoValido(tipo) {
    return tipo === 'acao' || tipo === 'decisao' || tipo === 'notificacao' || tipo === 'robo';
  }

  function htmlItem(it) {
    var tipo = (it && it.tipo) || '';
    if (!tipoValido(tipo)) tipo = 'acao';
    var ms = paraMs(it.t);
    var falhou = !!it.erro;
    return '<li class="at-item at-' + tipo + (falhou ? ' at-falhou' : '') + '">' +
      '<span class="at-marca" aria-hidden="true"></span>' +
      '<div class="at-corpo">' +
        '<div class="at-cab">' +
          '<span class="at-titulo">' + esc(it.titulo) + '</span>' +
          '<span class="at-hora" title="' + esc(fmtCompleto(ms)) + '">' + esc(fmtRelativo(ms)) + '</span>' +
        '</div>' +
        (it.detalhe ? '<div class="at-detalhe">' + esc(it.detalhe) + '</div>' : '') +
        '<span class="at-tag">' + esc(ROTULOS[tipo]) + '</span>' +
        (falhou ? '<span class="at-tag at-tag-erro">falhou</span>' : '') +
      '</div>' +
      '</li>';
  }

  function htmlVazio(temAlgum) {
    if (temAlgum) {
      return '<div class="at-vazio">' +
        '<div class="at-vazio-icone" aria-hidden="true">🔍</div>' +
        '<div class="at-vazio-txt">Nada neste filtro</div>' +
        '<div class="at-vazio-sub">Escolha outra categoria acima para ver o restante.</div>' +
        '</div>';
    }
    return '<div class="at-vazio">' +
      '<div class="at-vazio-icone" aria-hidden="true">🕘</div>' +
      '<div class="at-vazio-txt">Nenhuma atividade registrada ainda</div>' +
      '<div class="at-vazio-sub">Aplique ou descarte uma recomendação e o histórico começa a aparecer aqui.</div>' +
      '</div>';
  }

  function render() {
    if (!container) return;
    var itens = itensDe(dados);
    var contagem = contar(itens);
    var i;

    var html = '<div class="card">' +
      '<div class="at-topo"><div class="at-filtros">';
    for (i = 0; i < FILTROS.length; i++) {
      var f = FILTROS[i];
      html += '<button type="button" class="at-pill' + (filtro === f.chave ? ' at-on' : '') + '" data-filtro="' + esc(f.chave) + '"' +
        (filtro === f.chave ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        esc(f.nome) + '<span class="at-pill-n">' + contagem[f.chave] + '</span></button>';
    }
    html += '</div><button type="button" class="btn at-atualizar">↻ Atualizar</button></div>';

    var resumo = (dados && dados.resumo) || null;
    if (resumo) {
      html += '<p class="at-resumo">' +
        plural(resumo.acoes || 0, 'ação aplicada', 'ações aplicadas') + ' · ' +
        plural(resumo.decisoes || 0, 'decisão', 'decisões') + ' · ' +
        plural(resumo.notificacoes || 0, 'notificação', 'notificações') +
        (dados && dados.truncado ? ' · mostrando os 100 registros mais recentes' : '') +
        '</p>';
    }

    var visiveis = [];
    for (i = 0; i < itens.length; i++) {
      if (filtro === 'tudo' || itens[i].tipo === filtro) visiveis.push(itens[i]);
    }

    if (!visiveis.length) {
      html += htmlVazio(itens.length > 0);
    } else {
      html += '<ol class="at-linha">';
      for (i = 0; i < visiveis.length; i++) html += htmlItem(visiveis[i]);
      html += '</ol>';
    }

    html += '</div>';
    container.innerHTML = html;
    ligarEventos();
  }

  function ligarEventos() {
    var pills = container.querySelectorAll('.at-pill');
    for (var i = 0; i < pills.length; i++) {
      pills[i].addEventListener('click', function () {
        filtro = this.getAttribute('data-filtro');
        render();
      });
    }
    var btn = container.querySelector('.at-atualizar');
    if (btn) {
      btn.addEventListener('click', function () {
        carregar(true);
        buscarNotifs();
      });
    }
  }

  /* ---------- aba: carga ---------- */

  function carregar(forcar) {
    container = PANEL.el('atividadeConteudo');
    if (!container) return;
    injetarCss();
    if (dados && !forcar) { render(); return; }
    if (carregando) return;
    carregando = true;
    if (!dados) container.innerHTML = PANEL.skeleton([46, 70, 70, 70, 70]);
    PANEL.api('/api/crm/atividade').then(function (resp) {
      carregando = false;
      dados = resp || { itens: [] };
      if (!dados.itens) dados.itens = [];
      render();
    }).catch(function (err) {
      carregando = false;
      if (err && err.message === 'unauthorized') return;
      PANEL.renderErro(container, function () { carregar(true); });
    });
  }

  /* ================= sino de notificações (cabeçalho) ================= */

  /* o blob de notificações é escrito por outro módulo — toleramos os formatos prováveis */
  function normalizarNotifs(resp) {
    var bruto = resp;
    if (!bruto) return [];
    var lista = null;
    if (Object.prototype.toString.call(bruto) === '[object Array]') lista = bruto;
    else if (bruto.itens && bruto.itens.length !== undefined) lista = bruto.itens;
    else if (bruto.notificacoes && bruto.notificacoes.length !== undefined) lista = bruto.notificacoes;
    else if (bruto.lista && bruto.lista.length !== undefined) lista = bruto.lista;
    if (!lista) return [];
    var out = [];
    for (var i = 0; i < lista.length; i++) {
      var n = lista[i];
      if (!n || typeof n !== 'object') continue;
      var titulo = n.titulo || n.texto || n.mensagem || 'Notificação';
      var detalhe = n.detalhe || n.descricao || '';
      if (!detalhe && n.titulo && (n.texto || n.mensagem)) detalhe = n.texto || n.mensagem;
      out.push({
        t: paraMs(n.t !== undefined ? n.t : (n.criadoEm || n.data || n.quando)),
        titulo: String(titulo),
        detalhe: String(detalhe || ''),
        lida: !!(n.lida || n.lido || n.visto)
      });
    }
    return out;
  }

  function contarNaoLidas(resp, lista) {
    if (resp && typeof resp.naoLidas === 'number') return resp.naoLidas;
    if (resp && typeof resp.nao_lidas === 'number') return resp.nao_lidas;
    var n = 0;
    for (var i = 0; i < lista.length; i++) if (!lista[i].lida) n++;
    return n;
  }

  /* fallback quando não existe endpoint dedicado: usa a própria linha do tempo,
     com o "lido até" guardado no navegador */
  function notifsDaAtividade(resp) {
    var itens = (resp && resp.itens) || [];
    var corte = lidasAte();
    var out = [];
    for (var i = 0; i < itens.length; i++) {
      var it = itens[i];
      if (!it || it.tipo !== 'notificacao') continue;
      var ms = paraMs(it.t);
      out.push({
        t: ms,
        titulo: String(it.titulo || 'Notificação'),
        detalhe: String(it.detalhe || ''),
        lida: ms !== null && ms <= corte
      });
    }
    return out;
  }

  function iconeSino() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M18 8.5a6 6 0 1 0-12 0c0 6.2-2.4 7.9-2.4 7.9h16.8S18 14.7 18 8.5"/>' +
      '<path d="M13.7 20.2a2 2 0 0 1-3.4 0"/></svg>';
  }

  function montarSino() {
    var acoes = document.querySelector('.h-acoes');
    if (!acoes) return false;
    if (acoes.querySelector('.at-sino-wrap')) return false;

    var wrap = document.createElement('div');
    wrap.className = 'at-sino-wrap';
    wrap.innerHTML =
      '<button type="button" class="at-sino" aria-label="Notificações" aria-haspopup="true" aria-expanded="false" title="Notificações">' +
        iconeSino() +
        '<span class="at-sino-n" hidden>0</span>' +
      '</button>' +
      '<div class="at-sino-menu" hidden>' +
        '<div class="at-menu-topo">' +
          '<span class="at-menu-titulo">Notificações</span>' +
          '<button type="button" class="at-menu-lidas">Marcar todas como lidas</button>' +
        '</div>' +
        '<div class="at-menu-corpo-lista"></div>' +
        '<div class="at-menu-rodape"><button type="button" class="at-menu-todas">ver todas</button></div>' +
      '</div>';

    if (acoes.firstChild) acoes.insertBefore(wrap, acoes.firstChild);
    else acoes.appendChild(wrap);

    sinoEls = {
      wrap: wrap,
      botao: wrap.querySelector('.at-sino'),
      contador: wrap.querySelector('.at-sino-n'),
      menu: wrap.querySelector('.at-sino-menu'),
      lista: wrap.querySelector('.at-menu-corpo-lista'),
      lidas: wrap.querySelector('.at-menu-lidas'),
      todas: wrap.querySelector('.at-menu-todas')
    };

    sinoEls.botao.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (sinoMenuAberto) fecharMenu(); else abrirMenu();
    });
    sinoEls.menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
    sinoEls.lidas.addEventListener('click', marcarTodas);
    sinoEls.todas.addEventListener('click', function () {
      fecharMenu();
      try {
        var aba = document.querySelector('.aba-btn[data-tab="atividade"]');
        if (aba) aba.click();
      } catch (e) {}
    });
    document.addEventListener('click', function () { if (sinoMenuAberto) fecharMenu(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.keyCode === 27 && sinoMenuAberto) fecharMenu();
    });
    return true;
  }

  function abrirMenu() {
    if (!sinoEls) return;
    sinoMenuAberto = true;
    sinoEls.menu.removeAttribute('hidden');
    sinoEls.botao.classList.add('at-aberto');
    sinoEls.botao.setAttribute('aria-expanded', 'true');
    renderMenu();
    buscarNotifs();
  }

  function fecharMenu() {
    if (!sinoEls) return;
    sinoMenuAberto = false;
    sinoEls.menu.setAttribute('hidden', 'hidden');
    sinoEls.botao.classList.remove('at-aberto');
    sinoEls.botao.setAttribute('aria-expanded', 'false');
  }

  function renderMenu() {
    if (!sinoEls) return;
    var html = '';
    if (!sinoNotifs.length) {
      html = '<div class="at-menu-vazio">Nenhuma notificação por aqui.</div>';
    } else {
      html = '<ul class="at-menu-lista">';
      var max = sinoNotifs.length < 8 ? sinoNotifs.length : 8;
      for (var i = 0; i < max; i++) {
        var n = sinoNotifs[i];
        html += '<li class="at-menu-item' + (n.lida ? '' : ' at-menu-nova') + '">' +
          '<span class="at-menu-ponto" aria-hidden="true"></span>' +
          '<div class="at-menu-corpo">' +
            '<div class="at-menu-t">' + esc(n.titulo) + '</div>' +
            (n.detalhe ? '<div class="at-menu-d">' + esc(n.detalhe) + '</div>' : '') +
            '<div class="at-menu-h" title="' + esc(fmtCompleto(n.t)) + '">' + esc(fmtRelativo(n.t)) + '</div>' +
          '</div>' +
          '</li>';
      }
      html += '</ul>';
    }
    sinoEls.lista.innerHTML = html;
    sinoEls.lidas.disabled = sinoNaoLidas === 0;
  }

  /* mais recentes primeiro; sem data por último — as "últimas 8" precisam ser as últimas mesmo */
  function ordenarNotifs(a, b) {
    if (a.t === null && b.t === null) return 0;
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    return b.t - a.t;
  }

  function aplicarNotifs(lista, naoLidas) {
    sinoNotifs = lista || [];
    sinoNotifs.sort(ordenarNotifs);
    sinoNaoLidas = naoLidas > 0 ? naoLidas : 0;
    if (!sinoEls) return;
    if (sinoNaoLidas > 0) {
      sinoEls.contador.textContent = sinoNaoLidas > 99 ? '99+' : String(sinoNaoLidas);
      sinoEls.contador.removeAttribute('hidden');
      sinoEls.botao.setAttribute('aria-label', plural(sinoNaoLidas, 'notificação não lida', 'notificações não lidas'));
    } else {
      sinoEls.contador.setAttribute('hidden', 'hidden');
      sinoEls.botao.setAttribute('aria-label', 'Notificações');
    }
    if (sinoMenuAberto) renderMenu();
  }

  function pararPollRapido() {
    if (tmrRapido) { clearInterval(tmrRapido); tmrRapido = null; }
  }

  function buscarNotifs() {
    if (!window.PANEL || !PANEL.api) return;
    if (!temChave()) { aplicarNotifs([], 0); return; }
    if (sinoBuscando) return;
    sinoBuscando = true;
    PANEL.api('/api/crm/notificacoes').then(function (resp) {
      sinoBuscando = false;
      var lista = normalizarNotifs(resp);
      aplicarNotifs(lista, contarNaoLidas(resp, lista));
      pararPollRapido();
    }).catch(function (err) {
      sinoBuscando = false;
      pararPollRapido(); /* houve resposta do servidor — o poll rápido só existe para pegar o login */
      if (err && err.message === 'unauthorized') return;
      /* sem endpoint de notificações: cai para a linha do tempo da atividade */
      PANEL.api('/api/crm/atividade').then(function (resp) {
        var lista = notifsDaAtividade(resp);
        var n = 0;
        for (var i = 0; i < lista.length; i++) if (!lista[i].lida) n++;
        aplicarNotifs(lista, n);
        pararPollRapido();
      }).catch(function () {});
    });
  }

  function marcarTodas() {
    /* otimista: zera na hora e guarda o corte local (vale mesmo sem endpoint) */
    for (var i = 0; i < sinoNotifs.length; i++) sinoNotifs[i].lida = true;
    gravarLidasAte(Date.now());
    aplicarNotifs(sinoNotifs, 0);
    if (!window.PANEL || !PANEL.api || !temChave()) return;
    PANEL.api('/api/crm/notificacoes', {
      method: 'POST',
      body: JSON.stringify({ acao: 'marcar-todas-lidas' })
    }).then(function () {
      buscarNotifs();
    }).catch(function () { /* fallback local já aplicado */ });
  }

  function iniciarSino() {
    if (sinoIniciado) return;
    injetarCss(); /* antes de montar, para o sino nunca aparecer sem estilo */
    if (!montarSino()) return;
    sinoIniciado = true;
    buscarNotifs();
    /* enquanto não há chave (tela de login), tenta de novo rápido; depois só a cada 90 s */
    tmrRapido = setInterval(buscarNotifs, 6000);
    setInterval(buscarNotifs, 90000);
  }

  /* ---------- registro ---------- */

  PANEL.registrar('atividade', { carregar: carregar });

  /* o sino precisa existir mesmo que a aba Atividade nunca seja aberta */
  try {
    if (window.PANEL && window.PANEL.api) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          try { iniciarSino(); } catch (e) {}
        });
      } else {
        iniciarSino();
      }
    }
  } catch (e) {}
})();
