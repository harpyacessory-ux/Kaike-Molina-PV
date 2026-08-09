/* ============================================================
   Aba "Funil" — board kanban do CRM (crm-ui/funil.js)
   Contrato: IIFE, ES5, sem libs. Usa window.PANEL (api/el/skeleton/renderErro/registrar).
   Coleção: 'funil' → { colunas:[{id,titulo}], cards:[{id, leadId?, nome, whatsapp,
   valor, notas, origem('robo'|'manual'), coluna, criadoEm, atualizadoEm}] }
   ============================================================ */
(function () {
  var container = null;
  var doc = null;          // documento em memória
  var editId = null;       // id do card em edição inline
  var addCol = null;       // id da coluna com formulário de novo card aberto
  var dragId = null;       // id do card sendo arrastado
  var saveTimer = null;    // debounce do salvamento
  var cssOk = false;
  var eventosOk = false;

  /* ---------------- utilidades ---------------- */

  function esc(s) {
    s = (s === null || s === undefined) ? '' : String(s);
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMoeda(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    var neg = n < 0;
    var s = Math.abs(n).toFixed(2);
    var partes = s.split('.');
    var inteiro = partes[0];
    var out = '';
    while (inteiro.length > 3) {
      out = '.' + inteiro.slice(-3) + out;
      inteiro = inteiro.slice(0, -3);
    }
    return 'R$ ' + (neg ? '-' : '') + inteiro + out + ',' + partes[1];
  }

  function parseValor(s) {
    s = String(s === null || s === undefined ? '' : s).replace(/[Rr]\$/g, '').replace(/\s/g, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function valorParaCampo(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return String(n.toFixed(2)).replace('.', ',');
  }

  function soDigitos(s) {
    return String(s || '').replace(/\D/g, '');
  }

  function closest(el, className) {
    while (el && el !== container) {
      if (el.classList && el.classList.contains(className)) return el;
      el = el.parentNode;
    }
    return null;
  }

  function cardPorId(id) {
    var i;
    for (i = 0; i < doc.cards.length; i++) {
      if (doc.cards[i].id === id) return doc.cards[i];
    }
    return null;
  }

  /* ---------------- CSS ---------------- */

  function injetarCSS() {
    if (cssOk) return;
    cssOk = true;
    var st = document.createElement('style');
    st.id = 'fx-estilos';
    st.textContent = '' +
      '.fx-nota{font-size:12.5px;color:#94a3b8;margin:0 0 12px;padding:8px 12px;border:1px dashed #0e2c5e;border-radius:10px;background:#0a2147;}' +
      '.fx-nota b{color:#e2e8f0;font-weight:600;}' +
      '.fx-board{display:flex;gap:12px;overflow-x:auto;align-items:flex-start;padding-bottom:10px;-webkit-overflow-scrolling:touch;}' +
      '.fx-col{flex:0 0 auto;width:250px;min-width:230px;background:#0a2147;border:1px solid #0e2c5e;border-radius:12px;display:flex;flex-direction:column;transition:border-color .15s,box-shadow .15s;}' +
      '.fx-col-ganhou{border-color:rgba(34,197,94,.55);}' +
      '.fx-col-ganhou .fx-col-titulo{color:#22c55e;}' +
      '.fx-col-perdeu{border-color:rgba(239,68,68,.55);}' +
      '.fx-col-perdeu .fx-col-titulo{color:#ef4444;}' +
      '.fx-col-alvo{border-color:#2f6dff;box-shadow:0 0 0 2px rgba(47,109,255,.35);}' +
      '.fx-col-head{padding:10px 12px 6px;border-bottom:1px solid #0e2c5e;}' +
      '.fx-col-titulo{font-size:13.5px;font-weight:700;color:#e2e8f0;display:flex;align-items:center;gap:6px;}' +
      '.fx-cont{font-size:11px;font-weight:600;color:#94a3b8;background:#050f24;border:1px solid #0e2c5e;border-radius:999px;padding:1px 8px;}' +
      '.fx-soma{font-size:11.5px;color:#94a3b8;margin-top:3px;}' +
      '.fx-col-corpo{padding:8px;display:flex;flex-direction:column;gap:8px;min-height:28px;}' +
      '.fx-col-pe{padding:0 8px 8px;}' +
      '.fx-add-btn{width:100%;background:transparent;border:1px dashed #0e2c5e;border-radius:10px;color:#94a3b8;font-size:12.5px;padding:7px 0;cursor:pointer;}' +
      '.fx-add-btn:hover{color:#e2e8f0;border-color:#2f6dff;}' +
      '.fx-card{background:#050f24;border:1px solid #0e2c5e;border-radius:10px;padding:9px 10px;cursor:grab;font-size:13px;color:#e2e8f0;}' +
      '.fx-card:active{cursor:grabbing;}' +
      '.fx-card:hover{border-color:#2f6dff;}' +
      '.fx-arrastando{opacity:.45;}' +
      '.fx-card-nome{font-weight:700;font-size:13.5px;word-break:break-word;}' +
      '.fx-card-zap{margin-top:3px;font-size:12px;}' +
      '.fx-card-zap a{color:#2f6dff;text-decoration:none;}' +
      '.fx-card-zap a:hover{text-decoration:underline;}' +
      '.fx-card-valor{margin-top:3px;font-size:12.5px;font-weight:600;color:#22c55e;}' +
      '.fx-badge-robo{display:inline-block;margin-top:5px;font-size:10px;font-weight:600;color:#9db9ff;background:rgba(47,109,255,.16);border:1px solid rgba(47,109,255,.35);border-radius:999px;padding:1px 7px;}' +
      '.fx-form{background:#050f24;border:1px solid #2f6dff;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:7px;}' +
      '.fx-form input,.fx-form textarea,.fx-form select{width:100%;box-sizing:border-box;background:#0a2147;border:1px solid #0e2c5e;border-radius:8px;color:#e2e8f0;font-size:13px;padding:7px 9px;font-family:inherit;}' +
      '.fx-form input:focus,.fx-form textarea:focus,.fx-form select:focus{outline:none;border-color:#2f6dff;}' +
      '.fx-form textarea{min-height:56px;resize:vertical;}' +
      '.fx-form label{font-size:11px;color:#94a3b8;margin-bottom:-3px;}' +
      '.fx-form-acoes{display:flex;gap:7px;flex-wrap:wrap;margin-top:2px;}' +
      '.fx-mini{font-size:12px;padding:6px 11px;border-radius:8px;border:1px solid #0e2c5e;background:#0a2147;color:#e2e8f0;cursor:pointer;}' +
      '.fx-mini-acento{background:#2f6dff;border-color:#2f6dff;color:#fff;font-weight:600;}' +
      '.fx-mini-perigo{background:transparent;border-color:rgba(239,68,68,.55);color:#ef4444;margin-left:auto;}' +
      '.fx-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;background:#0a2147;border:1px solid #ef4444;color:#e2e8f0;font-size:12.5px;padding:9px 15px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.5);}' +
      '@media (max-width:480px){.fx-col{width:230px;}}';
    document.head.appendChild(st);
  }

  /* ---------------- persistência ---------------- */

  function agendarSalvar() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(salvarAgora, 400);
  }

  function salvarAgora() {
    saveTimer = null;
    PANEL.api('/api/crm/store', {
      method: 'POST',
      body: JSON.stringify({ col: 'funil', doc: doc })
    }).then(function (r) {
      if (!r || !r.ok) falhaSalvar();
    }).catch(function () {
      falhaSalvar();
    });
  }

  function falhaSalvar() {
    var t = document.createElement('div');
    t.className = 'fx-toast';
    t.textContent = 'Não foi possível salvar o funil. Recarregando…';
    document.body.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
      carregar(true);
    }, 1600);
  }

  /* ---------------- render ---------------- */

  function render() {
    if (!container) return;
    var html = '<div class="fx-nota">🤖 Leads do robô entram sozinhos aqui: <b>Conversando → Qualificado</b>.</div>';
    html += '<div class="fx-board">';
    var i;
    for (i = 0; i < doc.colunas.length; i++) html += renderColuna(doc.colunas[i]);
    html += '</div>';
    container.innerHTML = html;
    bindEventos();
  }

  function renderColuna(col) {
    var cards = [];
    var soma = 0;
    var i, c;
    for (i = 0; i < doc.cards.length; i++) {
      c = doc.cards[i];
      if (c.coluna === col.id) {
        cards.push(c);
        if (typeof c.valor === 'number' && isFinite(c.valor)) soma += c.valor;
      }
    }
    var extra = col.id === 'ganhou' ? ' fx-col-ganhou' : (col.id === 'perdeu' ? ' fx-col-perdeu' : '');
    var html = '<div class="fx-col' + extra + '" data-col="' + esc(col.id) + '">';
    html += '<div class="fx-col-head">' +
      '<div class="fx-col-titulo">' + esc(col.titulo) + ' <span class="fx-cont">' + cards.length + '</span></div>' +
      '<div class="fx-soma">' + fmtMoeda(soma) + '</div>' +
      '</div>';
    html += '<div class="fx-col-corpo">';
    for (i = 0; i < cards.length; i++) {
      html += (cards[i].id === editId) ? renderEdicao(cards[i]) : renderCard(cards[i]);
    }
    html += '</div>';
    html += '<div class="fx-col-pe">';
    if (addCol === col.id) {
      html += '<div class="fx-form fx-add-form">' +
        '<input type="text" class="fx-in-nome" placeholder="Nome" maxlength="120">' +
        '<input type="text" class="fx-in-zap" placeholder="WhatsApp (com DDD)" maxlength="30">' +
        '<input type="text" class="fx-in-valor" placeholder="Valor (R$)" maxlength="20">' +
        '<div class="fx-form-acoes">' +
          '<button type="button" class="fx-mini fx-mini-acento fx-add-salvar">Adicionar</button>' +
          '<button type="button" class="fx-mini fx-add-cancelar">Cancelar</button>' +
        '</div>' +
        '</div>';
    } else {
      html += '<button type="button" class="fx-add-btn">+ card</button>';
    }
    html += '</div></div>';
    return html;
  }

  function renderCard(c) {
    var html = '<div class="fx-card" draggable="true" data-id="' + esc(c.id) + '">';
    html += '<div class="fx-card-nome">' + esc(c.nome || '(sem nome)') + '</div>';
    var dig = soDigitos(c.whatsapp);
    if (dig) {
      html += '<div class="fx-card-zap"><a href="https://wa.me/' + esc(dig) + '" target="_blank" rel="noopener noreferrer">' + esc(c.whatsapp) + '</a></div>';
    } else if (c.whatsapp) {
      html += '<div class="fx-card-zap">' + esc(c.whatsapp) + '</div>';
    }
    if (typeof c.valor === 'number' && isFinite(c.valor)) {
      html += '<div class="fx-card-valor">' + fmtMoeda(c.valor) + '</div>';
    }
    if (c.origem === 'robo') html += '<span class="fx-badge-robo">🤖 robô</span>';
    html += '</div>';
    return html;
  }

  function renderEdicao(c) {
    var html = '<div class="fx-form fx-card-edit" data-id="' + esc(c.id) + '">';
    html += '<label>Nome</label><input type="text" class="fx-in-nome" maxlength="120" value="' + esc(c.nome) + '">';
    html += '<label>WhatsApp</label><input type="text" class="fx-in-zap" maxlength="30" value="' + esc(c.whatsapp) + '">';
    html += '<label>Valor (R$)</label><input type="text" class="fx-in-valor" maxlength="20" value="' + esc(valorParaCampo(c.valor)) + '">';
    html += '<label>Notas</label><textarea class="fx-in-notas" maxlength="2000">' + esc(c.notas) + '</textarea>';
    html += '<label>Mover para…</label><select class="fx-ed-mover">';
    var i, col;
    for (i = 0; i < doc.colunas.length; i++) {
      col = doc.colunas[i];
      html += '<option value="' + esc(col.id) + '"' + (col.id === c.coluna ? ' selected' : '') + '>' + esc(col.titulo) + '</option>';
    }
    html += '</select>';
    html += '<div class="fx-form-acoes">' +
      '<button type="button" class="fx-mini fx-mini-acento fx-ed-salvar">Salvar</button>' +
      '<button type="button" class="fx-mini fx-ed-cancelar">Cancelar</button>' +
      '<button type="button" class="fx-mini fx-mini-perigo fx-ed-excluir">Excluir</button>' +
      '</div>';
    html += '</div>';
    return html;
  }

  function focarPrimeiroCampo(seletor) {
    var el = container.querySelector(seletor);
    if (el) {
      var inp = el.querySelector('.fx-in-nome');
      if (inp) inp.focus();
    }
  }

  /* ---------------- mutações ---------------- */

  function criarCard(colId, nome, zap, valorTxt) {
    var agora = Date.now();
    doc.cards.push({
      id: 'm-' + agora,
      nome: nome,
      whatsapp: zap,
      valor: parseValor(valorTxt),
      notas: '',
      origem: 'manual',
      coluna: colId,
      criadoEm: agora,
      atualizadoEm: agora
    });
    addCol = null;
    render();
    agendarSalvar();
  }

  function salvarEdicao(form) {
    var c = cardPorId(form.getAttribute('data-id'));
    if (!c) return;
    c.nome = form.querySelector('.fx-in-nome').value.replace(/^\s+|\s+$/g, '');
    c.whatsapp = form.querySelector('.fx-in-zap').value.replace(/^\s+|\s+$/g, '');
    c.valor = parseValor(form.querySelector('.fx-in-valor').value);
    c.notas = form.querySelector('.fx-in-notas').value;
    c.coluna = form.querySelector('.fx-ed-mover').value || c.coluna;
    c.atualizadoEm = Date.now();
    editId = null;
    render();
    agendarSalvar();
  }

  function excluirCard(id) {
    if (!confirm('Excluir este card do funil?')) return;
    var i;
    for (i = doc.cards.length - 1; i >= 0; i--) {
      if (doc.cards[i].id === id) doc.cards.splice(i, 1);
    }
    editId = null;
    render();
    agendarSalvar();
  }

  function moverCard(id, colId) {
    var c = cardPorId(id);
    if (!c || !colId || c.coluna === colId) return;
    c.coluna = colId;
    c.atualizadoEm = Date.now();
    render();
    agendarSalvar();
  }

  /* ---------------- eventos (delegação, bind único) ---------------- */

  function limparAlvos() {
    var alvos = container.querySelectorAll('.fx-col-alvo');
    var i;
    for (i = 0; i < alvos.length; i++) alvos[i].classList.remove('fx-col-alvo');
  }

  function bindEventos() {
    if (eventosOk) return;
    eventosOk = true;

    container.addEventListener('click', function (ev) {
      var t = ev.target;

      /* botões do formulário de novo card */
      if (closest(t, 'fx-add-salvar')) {
        var form = closest(t, 'fx-add-form');
        var colEl = closest(t, 'fx-col');
        if (!form || !colEl) return;
        var nome = form.querySelector('.fx-in-nome').value.replace(/^\s+|\s+$/g, '');
        var zap = form.querySelector('.fx-in-zap').value.replace(/^\s+|\s+$/g, '');
        if (!nome && !zap) { form.querySelector('.fx-in-nome').focus(); return; }
        criarCard(colEl.getAttribute('data-col'), nome || '(sem nome)', zap, form.querySelector('.fx-in-valor').value);
        return;
      }
      if (closest(t, 'fx-add-cancelar')) { addCol = null; render(); return; }
      if (closest(t, 'fx-add-btn')) {
        var col = closest(t, 'fx-col');
        if (!col) return;
        addCol = col.getAttribute('data-col');
        editId = null;
        render();
        focarPrimeiroCampo('.fx-add-form');
        return;
      }

      /* botões da edição */
      if (closest(t, 'fx-ed-salvar')) {
        var f = closest(t, 'fx-card-edit');
        if (f) salvarEdicao(f);
        return;
      }
      if (closest(t, 'fx-ed-cancelar')) { editId = null; render(); return; }
      if (closest(t, 'fx-ed-excluir')) {
        var fe = closest(t, 'fx-card-edit');
        if (fe) excluirCard(fe.getAttribute('data-id'));
        return;
      }

      /* clique dentro da edição: não faz nada */
      if (closest(t, 'fx-card-edit')) return;

      /* clique no link do WhatsApp: deixa navegar */
      if (t.tagName === 'A' || (t.parentNode && t.parentNode.tagName === 'A')) return;

      /* clique no card abre edição */
      var card = closest(t, 'fx-card');
      if (card) {
        editId = card.getAttribute('data-id');
        addCol = null;
        render();
        focarPrimeiroCampo('.fx-card-edit');
      }
    });

    container.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t.classList && t.classList.contains('fx-ed-mover')) {
        var f = closest(t, 'fx-card-edit');
        if (f) moverCard(f.getAttribute('data-id'), t.value);
      }
    });

    container.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
      var t = ev.target;
      if (t.tagName === 'TEXTAREA') return;
      if (closest(t, 'fx-add-form')) {
        ev.preventDefault();
        var btn = closest(t, 'fx-add-form').querySelector('.fx-add-salvar');
        if (btn) btn.click();
      }
    });

    /* -------- drag & drop -------- */
    container.addEventListener('dragstart', function (ev) {
      var card = closest(ev.target, 'fx-card');
      if (!card || card.classList.contains('fx-card-edit')) return;
      dragId = card.getAttribute('data-id');
      card.classList.add('fx-arrastando');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', dragId); } catch (e) { /* IE */ }
      }
    });

    container.addEventListener('dragend', function (ev) {
      var card = closest(ev.target, 'fx-card');
      if (card) card.classList.remove('fx-arrastando');
      dragId = null;
      limparAlvos();
    });

    container.addEventListener('dragover', function (ev) {
      var col = closest(ev.target, 'fx-col');
      if (!col || !dragId) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      if (!col.classList.contains('fx-col-alvo')) {
        limparAlvos();
        col.classList.add('fx-col-alvo');
      }
    });

    container.addEventListener('dragleave', function (ev) {
      var col = closest(ev.target, 'fx-col');
      if (col && (!ev.relatedTarget || !closest(ev.relatedTarget, 'fx-col') || closest(ev.relatedTarget, 'fx-col') !== col)) {
        col.classList.remove('fx-col-alvo');
      }
    });

    container.addEventListener('drop', function (ev) {
      var col = closest(ev.target, 'fx-col');
      if (!col) return;
      ev.preventDefault();
      var id = dragId;
      if (!id && ev.dataTransfer) {
        try { id = ev.dataTransfer.getData('text/plain'); } catch (e) { /* IE */ }
      }
      dragId = null;
      limparAlvos();
      if (id) moverCard(id, col.getAttribute('data-col'));
    });
  }

  /* ---------------- carga ---------------- */

  function carregar(forcar) {
    container = PANEL.el('funilConteudo');
    injetarCSS();
    if (doc && !forcar) { render(); return; }
    if (saveTimer) { render(); return; } /* não sobrescreve mudanças ainda não salvas */
    container.innerHTML = PANEL.skeleton([46, 260]);
    PANEL.api('/api/crm/store?col=funil').then(function (r) {
      doc = (r && r.doc) ? r.doc : {};
      if (!doc.colunas || !doc.colunas.length) doc.colunas = [];
      if (!doc.cards) doc.cards = [];
      editId = null;
      addCol = null;
      render();
    }).catch(function () {
      PANEL.renderErro(container, function () { carregar(true); });
    });
  }

  PANEL.registrar('funil', { carregar: carregar });
})();
