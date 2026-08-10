/* Módulo do painel: assistente — widget de chat flutuante.
   NÃO é uma aba: não chama PANEL.registrar. Auto-inicializa no fim do body
   e funciona em qualquer aba. Contrato: IIFE pura, ES5, sem libs externas.
   Depende de window.PANEL (se não existir, não faz nada). */
(function () {
  if (typeof window === 'undefined' || !window.PANEL || !window.PANEL.api) return;

  /* ---------- constantes ---------- */

  var CHAVE_STORAGE = 'harpy_chat';
  var MAX_HISTORICO = 20;   /* mensagens enviadas à API */
  var MAX_GUARDADAS = 60;   /* mensagens mantidas no sessionStorage */
  var MAX_ALTURA_TXT = 102; /* 4 linhas de 20px + padding + borda */
  var LARGURA_MOBILE = 640;

  var SUGESTOES = [
    'Como está a campanha hoje?',
    'Tem lead novo esperando resposta?',
    'Qual post do Instagram foi melhor?',
    'O que eu deveria fazer agora?'
  ];

  var BOAS_VINDAS = 'Oi! Sou o assistente da Harpy.\n' +
    'Estou ligado aos seus dados: campanha, leads, Instagram, funil e tarefas. ' +
    'Pergunte o que quiser — ou comece por uma destas:';

  var ROTULO_FERRAMENTA = {
    ver_campanha: 'campanha',
    ver_leads: 'leads',
    ver_instagram: 'Instagram',
    ver_status: 'status',
    ver_colecao: 'dados',
    criar_tarefa: 'criou tarefa',
    criar_card_funil: 'criou card'
  };
  var FERRAMENTA_ACAO = { criar_tarefa: 1, criar_card_funil: 1 };

  var SVG_BALAO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M20.5 11.6c0 4.4-3.9 8-8.7 8-1.3 0-2.6-.3-3.7-.8l-4.6 1.6 1.6-4.2c-1-1.3-1.6-2.9-1.6-4.6 0-4.4 3.9-8 8.7-8s8.3 3.6 8.3 8z"/>' +
    '<path d="M8.6 11.6h.01M12 11.6h.01M15.4 11.6h.01"/></svg>';

  var SVG_LIXEIRA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l.9 13h9.2l.9-13M10.2 10.5v6M13.8 10.5v6"/></svg>';

  var SVG_FECHAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true" focusable="false">' +
    '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

  var SVG_ENVIAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M20.5 3.5L3.8 10.2l6.7 2.8 2.8 6.7 7.2-16.2zM10.5 13L20.5 3.5"/></svg>';

  /* ---------- estado ---------- */

  var cssInjetado = false;
  var criado = false;
  var aberto = false;
  var enviando = false;
  var mensagens = [];

  var fab = null;
  var janela = null;
  var corpo = null;
  var campoTexto = null;
  var btnEnviar = null;

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

  /* escapa PRIMEIRO, depois converte as quebras de linha em <br> */
  function escLinhas(s) {
    return esc(s).replace(/\r\n|\r|\n/g, '<br>');
  }

  function trim(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/^\s+|\s+$/g, '');
  }

  function ehArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function ehMobile() {
    return window.innerWidth <= LARGURA_MOBILE;
  }

  /* ---------- CSS ---------- */

  function injetarCss() {
    if (cssInjetado) return;
    cssInjetado = true;
    var grad = 'var(--grad,linear-gradient(135deg,#2E6BFF 0%,#7C3AED 45%,#E11D3C 100%))';
    var sombra = 'var(--sombra,0 10px 30px rgba(0,0,0,.45))';
    var glow = 'var(--glow-azul,0 0 24px rgba(46,107,255,.35))';
    var style = document.createElement('style');
    style.setAttribute('data-mod', 'assistente');
    style.textContent =
      /* botão flutuante */
      '.as-fab{position:fixed;right:18px;bottom:18px;z-index:60;width:56px;height:56px;padding:0;border:none;border-radius:50%;background:' + grad + ';color:var(--branco,#FFF);box-shadow:' + sombra + ',' + glow + ';cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .18s ease,filter .18s ease}' +
      '.as-fab:hover{transform:scale(1.05);filter:brightness(1.06)}' +
      '.as-fab:active{transform:scale(.98)}' +
      '.as-fab:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:3px}' +
      '.as-fab svg{width:26px;height:26px;display:block}' +

      /* janela */
      '.as-oculto{display:none !important}' +
      '.as-janela{position:fixed;right:18px;bottom:86px;z-index:60;width:380px;max-width:calc(100vw - 36px);height:78vh;max-height:560px;background:var(--card,#0E1738);border:1px solid var(--borda,#1E2B5A);border-radius:18px;box-shadow:' + sombra + ';display:flex;flex-direction:column;overflow:hidden;animation:as-entra .18s ease-out}' +
      '@keyframes as-entra{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}' +

      /* cabeçalho */
      '.as-topo{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:14px 10px 11px 14px;border-bottom:1px solid var(--borda,#1E2B5A);background:var(--card,#0E1738)}' +
      '.as-topo::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:' + grad + '}' +
      '.as-tit{flex:1 1 auto;min-width:0}' +
      '.as-tit strong{display:block;color:var(--branco,#FFF);font-size:14.5px;font-weight:700;line-height:1.2;letter-spacing:.01em}' +
      '.as-tit span{display:block;color:var(--texto2,#9AAAD0);font-size:11.5px;line-height:1.3;margin-top:2px}' +
      '.as-ico{flex:0 0 auto;width:30px;height:30px;padding:0;border:none;background:none;color:var(--texto2,#9AAAD0);border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .18s ease,background-color .18s ease}' +
      '.as-ico:hover{color:var(--texto,#F1F5FF);background:var(--card2,#131E45)}' +
      '.as-ico:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.as-ico svg{width:17px;height:17px;display:block}' +

      /* corpo */
      '.as-corpo{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}' +
      '.as-msg{max-width:86%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.5;color:var(--texto,#F1F5FF);word-wrap:break-word;overflow-wrap:break-word}' +
      '.as-msg-user{align-self:flex-end;background:rgba(46,107,255,.16);border:1px solid rgba(46,107,255,.38);border-bottom-right-radius:6px}' +
      '.as-msg-bot{align-self:flex-start;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-bottom-left-radius:6px}' +
      '.as-msg-erro{border-color:rgba(225,29,60,.40);background:rgba(225,29,60,.08)}' +
      '.as-retry{display:block;width:auto;margin-top:9px;background:none;border:1px solid var(--borda2,#2B3C74);color:var(--azul-claro,#6098FF);font-size:12px;font-family:inherit;padding:5px 10px;border-radius:999px;cursor:pointer;transition:border-color .18s ease,background-color .18s ease}' +
      '.as-retry:hover{border-color:var(--azul,#2E6BFF);background:rgba(46,107,255,.12)}' +
      '.as-retry:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.as-tools{align-self:flex-start;max-width:86%;margin-top:-6px;padding-left:4px;color:var(--cinza,#5C6B95);font-size:11px;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word}' +

      /* pensando */
      '.as-pensando{align-self:flex-start;display:flex;align-items:center;gap:5px;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:14px;border-bottom-left-radius:6px;padding:13px 14px}' +
      '.as-ponto{width:6px;height:6px;border-radius:50%;background:var(--azul-claro,#6098FF);animation:as-pulsa 1.2s ease-in-out infinite}' +
      '.as-ponto:nth-child(2){animation-delay:.15s}' +
      '.as-ponto:nth-child(3){animation-delay:.3s}' +
      '@keyframes as-pulsa{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}' +

      /* sugestões */
      '.as-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px}' +
      '.as-chip{background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);color:var(--texto2,#9AAAD0);font-size:12px;font-family:inherit;line-height:1.3;text-align:left;padding:7px 11px;border-radius:999px;cursor:pointer;transition:color .18s ease,border-color .18s ease,background-color .18s ease}' +
      '.as-chip:hover{color:var(--texto,#F1F5FF);border-color:var(--azul,#2E6BFF);background:var(--card2,#131E45)}' +
      '.as-chip:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +

      /* rodapé */
      '.as-rodape{flex:0 0 auto;display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--borda,#1E2B5A);background:var(--card,#0E1738)}' +
      '.as-txt{flex:1 1 auto;min-width:0;height:42px;max-height:102px;resize:none;overflow-y:hidden;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:12px;color:var(--texto,#F1F5FF);font-family:inherit;font-size:13.5px;line-height:20px;padding:10px 12px;outline:none;transition:border-color .18s ease,box-shadow .18s ease}' +
      '.as-txt::placeholder{color:var(--cinza,#5C6B95)}' +
      '.as-txt:focus{border-color:var(--azul,#2E6BFF);box-shadow:0 0 0 2px rgba(46,107,255,.22)}' +
      '.as-enviar{flex:0 0 auto;width:38px;height:38px;padding:0;border:none;border-radius:11px;background:' + grad + ';color:var(--branco,#FFF);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:filter .18s ease,opacity .18s ease}' +
      '.as-enviar:hover{filter:brightness(1.08)}' +
      '.as-enviar:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.35)}' +
      '.as-enviar:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.as-enviar svg{width:18px;height:18px;display:block}' +

      /* mobile */
      '@media (max-width:640px){' +
      '.as-fab{right:14px;bottom:14px;width:52px;height:52px}' +
      '.as-fab svg{width:24px;height:24px}' +
      '.as-janela{inset:0;width:auto;max-width:none;height:auto;max-height:none;border:none;border-radius:0}' +
      '.as-msg{max-width:90%}' +
      '}';
    document.head.appendChild(style);
  }

  /* ---------- persistência (sessionStorage) ---------- */

  function carregarConversa() {
    var out = [];
    try {
      var bruto = window.sessionStorage.getItem(CHAVE_STORAGE);
      if (!bruto) return out;
      var arr = JSON.parse(bruto);
      if (!ehArray(arr)) return out;
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (!m || typeof m.content !== 'string') continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        out.push({
          role: m.role,
          content: m.content,
          erro: !!m.erro,
          ferramentas: ehArray(m.ferramentas) ? m.ferramentas : []
        });
      }
    } catch (e) { return []; }
    return out;
  }

  function salvarConversa() {
    try {
      var lista = mensagens;
      if (lista.length > MAX_GUARDADAS) lista = lista.slice(lista.length - MAX_GUARDADAS);
      window.sessionStorage.setItem(CHAVE_STORAGE, JSON.stringify(lista));
    } catch (e) { /* storage cheio ou bloqueado: segue sem persistir */ }
  }

  function apagarConversa() {
    try { window.sessionStorage.removeItem(CHAVE_STORAGE); } catch (e) {}
  }

  /* ---------- histórico enviado à API ---------- */

  function historicoParaApi() {
    var lista = [];
    for (var i = 0; i < mensagens.length; i++) {
      if (mensagens[i].erro) continue; /* bolhas de erro não entram no histórico */
      lista.push({ role: mensagens[i].role, content: mensagens[i].content });
    }
    if (lista.length > MAX_HISTORICO) lista = lista.slice(lista.length - MAX_HISTORICO);
    while (lista.length && lista[0].role !== 'user') lista.shift();
    return lista;
  }

  /* ---------- leitura da resposta ---------- */

  function extrairTexto(r) {
    if (!r) return '';
    if (typeof r === 'string') return r;
    var chaves = ['resposta', 'texto', 'mensagem', 'message', 'reply', 'content', 'output'];
    for (var i = 0; i < chaves.length; i++) {
      if (typeof r[chaves[i]] === 'string' && trim(r[chaves[i]])) return r[chaves[i]];
    }
    if (ehArray(r.content)) {
      var partes = [];
      for (var j = 0; j < r.content.length; j++) {
        var bloco = r.content[j];
        if (bloco && typeof bloco.text === 'string' && trim(bloco.text)) partes.push(bloco.text);
      }
      if (partes.length) return partes.join('\n');
    }
    return '';
  }

  function extrairFerramentas(r) {
    if (!r || typeof r !== 'object') return [];
    var chaves = ['ferramentasUsadas', 'ferramentas', 'ferramentas_usadas', 'toolsUsadas', 'tools'];
    for (var i = 0; i < chaves.length; i++) {
      if (ehArray(r[chaves[i]])) return r[chaves[i]];
    }
    return [];
  }

  function nomeFerramenta(item) {
    if (item === null || item === undefined) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') {
      return String(item.nome || item.name || item.ferramenta || item.tool || '');
    }
    return String(item);
  }

  function htmlFerramentas(lista) {
    if (!ehArray(lista) || !lista.length) return '';
    var consultas = [];
    var acoes = [];
    var vistos = {};
    for (var i = 0; i < lista.length; i++) {
      var nome = trim(nomeFerramenta(lista[i]));
      if (!nome || vistos['k_' + nome]) continue;
      vistos['k_' + nome] = 1;
      var proprio = Object.prototype.hasOwnProperty;
      var rotulo = proprio.call(ROTULO_FERRAMENTA, nome) ? ROTULO_FERRAMENTA[nome] : nome.replace(/_/g, ' ');
      if (proprio.call(FERRAMENTA_ACAO, nome)) acoes.push(rotulo);
      else consultas.push(rotulo);
    }
    var partes = [];
    if (consultas.length) partes.push('consultou: ' + consultas.join(', '));
    if (acoes.length) partes.push(acoes.join(', '));
    if (!partes.length) return '';
    return '<div class="as-tools">' + esc(partes.join(' · ')) + '</div>';
  }

  /* ---------- render ---------- */

  function htmlMensagem(m) {
    var html;
    if (m.role === 'user') {
      html = '<div class="as-msg as-msg-user">' + escLinhas(m.content) + '</div>';
      return html;
    }
    html = '<div class="as-msg as-msg-bot' + (m.erro ? ' as-msg-erro' : '') + '">' + escLinhas(m.content);
    if (m.erro) {
      html += '<button type="button" class="as-retry" data-acao="retry">Tentar de novo</button>';
    }
    html += '</div>';
    if (!m.erro) html += htmlFerramentas(m.ferramentas);
    return html;
  }

  function renderMensagens() {
    if (!corpo) return;
    var html = '';
    var i;
    if (!mensagens.length) {
      html += '<div class="as-msg as-msg-bot">' + escLinhas(BOAS_VINDAS) + '</div>';
      html += '<div class="as-chips">';
      for (i = 0; i < SUGESTOES.length; i++) {
        html += '<button type="button" class="as-chip" data-sug="' + i + '">' + esc(SUGESTOES[i]) + '</button>';
      }
      html += '</div>';
    } else {
      for (i = 0; i < mensagens.length; i++) html += htmlMensagem(mensagens[i]);
    }
    if (enviando) {
      html += '<div class="as-pensando" role="status" aria-label="pensando">' +
        '<span class="as-ponto"></span><span class="as-ponto"></span><span class="as-ponto"></span></div>';
    }
    corpo.innerHTML = html;
    ligarEventosCorpo();
    rolarFim();
  }

  function ligarEventosCorpo() {
    var i;
    var chips = corpo.querySelectorAll('.as-chip');
    for (i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-sug'), 10);
        if (isNaN(idx) || !SUGESTOES[idx]) return;
        enviarPergunta(SUGESTOES[idx]);
      });
    }
    var retries = corpo.querySelectorAll('button[data-acao="retry"]');
    for (i = 0; i < retries.length; i++) {
      retries[i].addEventListener('click', tentarDeNovo);
    }
  }

  function rolarFim() {
    if (corpo) corpo.scrollTop = corpo.scrollHeight;
  }

  function atualizarBotaoEnviar() {
    if (!btnEnviar) return;
    btnEnviar.disabled = enviando || !trim(campoTexto ? campoTexto.value : '');
  }

  function ajustarAltura() {
    if (!campoTexto) return;
    campoTexto.style.height = 'auto';
    var borda = campoTexto.offsetHeight - campoTexto.clientHeight;
    if (isNaN(borda) || borda < 0) borda = 0;
    var alvo = campoTexto.scrollHeight + borda;
    var passou = alvo > MAX_ALTURA_TXT;
    campoTexto.style.height = (passou ? MAX_ALTURA_TXT : alvo) + 'px';
    campoTexto.style.overflowY = passou ? 'auto' : 'hidden';
  }

  /* ---------- conversa ---------- */

  function removerErros() {
    var novas = [];
    for (var i = 0; i < mensagens.length; i++) {
      if (!mensagens[i].erro) novas.push(mensagens[i]);
    }
    mensagens = novas;
  }

  function enviarPergunta(txt) {
    if (enviando) return;
    txt = trim(txt);
    if (!txt) return;
    removerErros();
    mensagens.push({ role: 'user', content: txt, erro: false, ferramentas: [] });
    salvarConversa();
    if (campoTexto) {
      campoTexto.value = '';
      ajustarAltura();
    }
    chamarApi();
  }

  function tentarDeNovo() {
    if (enviando) return;
    removerErros();
    if (!historicoParaApi().length) { renderMensagens(); return; }
    chamarApi();
  }

  function chamarApi() {
    enviando = true;
    atualizarBotaoEnviar();
    renderMensagens();

    PANEL.api('/api/crm/chat', {
      method: 'POST',
      body: JSON.stringify({ mensagens: historicoParaApi() })
    }).then(function (r) {
      enviando = false;
      var txt = trim(extrairTexto(r));
      mensagens.push({
        role: 'assistant',
        content: txt || 'Recebi sua mensagem, mas não consegui montar uma resposta agora. Pode perguntar de outro jeito?',
        erro: false,
        ferramentas: extrairFerramentas(r)
      });
      salvarConversa();
      atualizarBotaoEnviar();
      renderMensagens();
      if (aberto && campoTexto && !ehMobile()) campoTexto.focus();
    }).catch(function (err) {
      enviando = false;
      var msg = (err && err.message === 'unauthorized')
        ? 'Sua sessão do painel expirou. Entre de novo com a sua chave para continuar a conversa.'
        : 'Não consegui falar com o servidor agora. Confira sua conexão e tente de novo.';
      mensagens.push({ role: 'assistant', content: msg, erro: true, ferramentas: [] });
      salvarConversa();
      atualizarBotaoEnviar();
      renderMensagens();
    });
  }

  function limpar() {
    if (enviando) return;
    if (mensagens.length && !confirm('Apagar esta conversa?')) return;
    mensagens = [];
    apagarConversa();
    renderMensagens();
    if (campoTexto && !ehMobile()) campoTexto.focus();
  }

  /* ---------- abrir / fechar ---------- */

  function aoTeclaGlobal(ev) {
    var k = ev.key || '';
    if (k === 'Escape' || k === 'Esc' || ev.keyCode === 27) fechar();
  }

  function aoCliqueFora(ev) {
    if (!aberto || ehMobile()) return;
    var alvo = ev.target;
    if (!alvo || !alvo.nodeType) return;
    if ((janela && janela.contains(alvo)) || (fab && fab.contains(alvo))) return;
    fechar();
  }

  function abrir() {
    if (aberto) return;
    aberto = true;
    janela.classList.remove('as-oculto');
    fab.setAttribute('aria-expanded', 'true');
    fab.setAttribute('aria-label', 'Fechar o assistente Harpy');
    renderMensagens();
    atualizarBotaoEnviar();
    ajustarAltura();
    document.addEventListener('keydown', aoTeclaGlobal);
    document.addEventListener('mousedown', aoCliqueFora, true);
    if (!ehMobile()) {
      setTimeout(function () { if (campoTexto && aberto) campoTexto.focus(); }, 60);
    }
  }

  function fechar() {
    if (!aberto) return;
    aberto = false;
    janela.classList.add('as-oculto');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-label', 'Abrir o assistente Harpy');
    document.removeEventListener('keydown', aoTeclaGlobal);
    document.removeEventListener('mousedown', aoCliqueFora, true);
    if (fab && fab.focus) fab.focus();
  }

  function alternar() {
    if (aberto) fechar();
    else abrir();
  }

  /* ---------- construção ---------- */

  function criar() {
    if (criado || !document.body) return;
    criado = true;
    injetarCss();
    mensagens = carregarConversa();

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'as-fab';
    fab.setAttribute('aria-label', 'Abrir o assistente Harpy');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('title', 'Assistente Harpy');
    fab.innerHTML = SVG_BALAO;

    janela = document.createElement('div');
    janela.className = 'as-janela as-oculto';
    janela.setAttribute('role', 'dialog');
    janela.setAttribute('aria-label', 'Assistente Harpy');
    janela.innerHTML =
      '<div class="as-topo">' +
        '<div class="as-tit">' +
          '<strong>Assistente Harpy</strong>' +
          '<span>conectado aos seus dados</span>' +
        '</div>' +
        '<button type="button" class="as-ico as-limpar" aria-label="Limpar conversa" title="Limpar conversa">' + SVG_LIXEIRA + '</button>' +
        '<button type="button" class="as-ico as-fechar" aria-label="Fechar assistente" title="Fechar">' + SVG_FECHAR + '</button>' +
      '</div>' +
      '<div class="as-corpo" role="log" aria-live="polite"></div>' +
      '<form class="as-rodape">' +
        '<textarea class="as-txt" rows="1" maxlength="2000" placeholder="Pergunte alguma coisa..." aria-label="Sua mensagem"></textarea>' +
        '<button type="submit" class="as-enviar" aria-label="Enviar mensagem" title="Enviar">' + SVG_ENVIAR + '</button>' +
      '</form>';

    document.body.appendChild(fab);
    document.body.appendChild(janela);

    corpo = janela.querySelector('.as-corpo');
    campoTexto = janela.querySelector('.as-txt');
    btnEnviar = janela.querySelector('.as-enviar');

    fab.addEventListener('click', alternar);
    janela.querySelector('.as-fechar').addEventListener('click', fechar);
    janela.querySelector('.as-limpar').addEventListener('click', limpar);

    janela.querySelector('.as-rodape').addEventListener('submit', function (ev) {
      ev.preventDefault();
      enviarPergunta(campoTexto ? campoTexto.value : '');
    });

    campoTexto.addEventListener('input', function () {
      ajustarAltura();
      atualizarBotaoEnviar();
    });

    campoTexto.addEventListener('keydown', function (ev) {
      /* não interrompe teclado com acentuação/IME em composição */
      if (ev.isComposing || ev.keyCode === 229) return;
      var k = ev.key || '';
      if ((k === 'Enter' || ev.keyCode === 13) && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        enviarPergunta(campoTexto.value);
      }
    });

    atualizarBotaoEnviar();
    renderMensagens();
  }

  if (document.body) criar();
  else document.addEventListener('DOMContentLoaded', criar);
})();
