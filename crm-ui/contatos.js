/* Módulo de Contatos do painel CRM — aba 'contatos' (prefixo CSS 'ct-') */
(function () {
  var container = null;
  var doc = null;            // { contatos: [...] }
  var carregado = false;
  var estiloInjetado = false;

  /* ---------- utilidades ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function soDigitos(s) {
    return String(s == null ? '' : s).replace(/\D/g, '');
  }

  function novoId() {
    return 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function agora() {
    return new Date().toISOString();
  }

  function linkWa(whats) {
    var d = soDigitos(whats);
    if (!d) return '';
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return 'https://wa.me/' + d;
  }

  function formatarWhats(whats) {
    var d = soDigitos(whats);
    var pais = '';
    if ((d.length === 12 || d.length === 13) && d.indexOf('55') === 0) {
      pais = '+55 ';
      d = d.slice(2);
    }
    if (d.length === 11) {
      return pais + '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    }
    if (d.length === 10) {
      return pais + '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    }
    return String(whats || '');
  }

  /* ---------- estilo ---------- */

  function injetarEstilo() {
    if (estiloInjetado || document.getElementById('ct-estilo')) { estiloInjetado = true; return; }
    var st = document.createElement('style');
    st.id = 'ct-estilo';
    st.textContent =
      '.ct-topo{display:flex;flex-direction:column;gap:10px;margin-bottom:14px;}' +
      '.ct-busca{width:100%;box-sizing:border-box;background-color:var(--bg2,#0A1230);' +
        'background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%239AAAD0%22 stroke-width=%222%22 stroke-linecap=%22round%22%3E%3Ccircle cx=%2211%22 cy=%2211%22 r=%227%22/%3E%3Cpath d=%22M20.5 20.5l-4.2-4.2%22/%3E%3C/svg%3E");' +
        'background-repeat:no-repeat;background-position:13px 50%;background-size:17px 17px;' +
        'border:1px solid var(--borda,#1E2B5A);border-radius:10px;' +
        'color:var(--texto,#F1F5FF);padding:11px 12px 11px 40px;font-size:14px;outline:none;' +
        'transition:border-color .18s ease,box-shadow .18s ease,background-color .18s ease;}' +
      '.ct-busca::placeholder{color:var(--cinza,#5C6B95);}' +
      '.ct-busca:focus{border-color:var(--azul,#2E6BFF);box-shadow:0 0 0 2px rgba(46,107,255,.22);}' +
      '.ct-acoes{display:flex;gap:8px;flex-wrap:wrap;}' +
      '.ct-acoes .btn{flex:1;min-width:140px;border-radius:10px;transition:border-color .18s ease,filter .18s ease;}' +
      '.ct-lista{display:grid;grid-template-columns:1fr;gap:10px;}' +
      '.ct-card{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:14px;' +
        'border-radius:16px;transition:border-color .18s ease,box-shadow .18s ease;}' +
      '.ct-card:hover{border-color:var(--borda2,#2B3C74);box-shadow:var(--sombra,0 10px 30px rgba(0,0,0,.45));}' +
      '.ct-info{min-width:0;flex:1;}' +
      '.ct-nome{font-weight:700;color:var(--texto,#F1F5FF);font-size:15px;word-break:break-word;}' +
      '.ct-empresa{color:var(--texto2,#9AAAD0);font-size:13px;margin-top:2px;word-break:break-word;}' +
      '.ct-links{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:13px;}' +
      '.ct-links a{color:var(--azul-claro,#6098FF);text-decoration:none;word-break:break-all;transition:color .18s ease;}' +
      '.ct-links a:hover{text-decoration:underline;}' +
      '.ct-links a.ct-wa{color:var(--verde,#22C55E);}' +
      '.ct-notas{color:var(--texto2,#9AAAD0);font-size:12px;margin-top:6px;white-space:pre-wrap;word-break:break-word;}' +
      '.ct-botoes{display:flex;gap:6px;flex-shrink:0;}' +
      '.ct-icone{background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:10px;' +
        'color:var(--texto2,#9AAAD0);cursor:pointer;' +
        'width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;padding:0;' +
        'transition:color .18s ease,border-color .18s ease,background-color .18s ease;}' +
      '.ct-icone:hover{color:var(--texto,#F1F5FF);border-color:var(--azul,#2E6BFF);background:var(--card2,#131E45);}' +
      '.ct-icone:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px;}' +
      '.ct-icone.ct-perigo:hover{color:var(--vermelho-claro,#FF4767);border-color:var(--vermelho,#E11D3C);background:rgba(225,29,60,.12);}' +
      '.ct-icone svg{width:16px;height:16px;display:block;}' +
      '.ct-vazio{text-align:center;color:var(--texto2,#9AAAD0);padding:40px 16px;border:1px dashed var(--borda,#1E2B5A);' +
        'border-radius:16px;background:var(--bg2,#0A1230);font-size:14px;line-height:1.6;}' +
      '.ct-vazio strong{color:var(--texto,#F1F5FF);}' +
      '.ct-overlay{position:fixed;inset:0;background:rgba(6,11,31,.72);backdrop-filter:blur(6px);' +
        '-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;' +
        'justify-content:center;z-index:1000;padding:16px;}' +
      '.ct-modal{background:var(--card,#0E1738);border:1px solid var(--borda,#1E2B5A);border-radius:16px;' +
        'box-shadow:var(--sombra,0 10px 30px rgba(0,0,0,.45));width:100%;max-width:440px;' +
        'padding:18px;max-height:90vh;overflow-y:auto;box-sizing:border-box;}' +
      '.ct-modal h3{margin:0 0 14px;color:var(--texto,#F1F5FF);font-size:16px;}' +
      '.ct-campo{margin-bottom:12px;}' +
      '.ct-campo label{display:block;color:var(--texto2,#9AAAD0);font-size:12px;margin-bottom:4px;}' +
      '.ct-campo label b{color:var(--vermelho,#E11D3C);}' +
      '.ct-campo input,.ct-campo textarea{width:100%;box-sizing:border-box;background:var(--bg2,#0A1230);' +
        'border:1px solid var(--borda,#1E2B5A);' +
        'border-radius:10px;color:var(--texto,#F1F5FF);padding:10px 11px;font-size:14px;outline:none;font-family:inherit;' +
        'transition:border-color .18s ease,box-shadow .18s ease;}' +
      '.ct-campo input::placeholder,.ct-campo textarea::placeholder{color:var(--cinza,#5C6B95);}' +
      '.ct-campo input:focus,.ct-campo textarea:focus{border-color:var(--azul,#2E6BFF);box-shadow:0 0 0 2px rgba(46,107,255,.22);}' +
      '.ct-campo input.ct-invalido{border-color:var(--vermelho,#E11D3C);box-shadow:0 0 0 2px rgba(225,29,60,.20);}' +
      '.ct-campo textarea{resize:vertical;min-height:64px;}' +
      '.ct-modal-acoes{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;}' +
      '.ct-modal-acoes .btn{flex:1;min-width:100px;border-radius:10px;}' +
      '.ct-btn-excluir{background:transparent;border:1px solid rgba(225,29,60,.5);color:var(--vermelho-claro,#FF4767);border-radius:10px;' +
        'padding:10px 12px;cursor:pointer;font-size:14px;flex:1;min-width:100px;' +
        'transition:background-color .18s ease,color .18s ease,border-color .18s ease;}' +
      '.ct-btn-excluir:hover{background:var(--vermelho,#E11D3C);border-color:var(--vermelho,#E11D3C);color:var(--branco,#FFFFFF);}' +
      '.ct-btn-excluir:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px;}' +
      '.ct-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--card,#0E1738);' +
        'border:1px solid var(--verde,#22C55E);color:var(--texto,#F1F5FF);padding:11px 18px;border-radius:12px;font-size:14px;' +
        'z-index:1100;box-shadow:var(--sombra,0 10px 30px rgba(0,0,0,.45));max-width:90vw;text-align:center;}' +
      '.ct-toast.ct-toast-erro{border-color:var(--vermelho,#E11D3C);}' +
      '.ct-contador{color:var(--texto2,#9AAAD0);font-size:12px;margin-bottom:8px;}' +
      '@media(min-width:640px){' +
        '.ct-topo{flex-direction:row;align-items:center;}' +
        '.ct-busca{flex:1;}' +
        '.ct-acoes{flex-wrap:nowrap;}' +
        '.ct-acoes .btn{flex:0 0 auto;}' +
        '.ct-lista{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));}' +
      '}';
    document.head.appendChild(st);
    estiloInjetado = true;
  }

  /* ---------- toast ---------- */

  function toast(msg, erro) {
    var t = document.createElement('div');
    t.className = 'ct-toast' + (erro ? ' ct-toast-erro' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 3200);
  }

  /* ---------- persistência ---------- */

  function salvar() {
    return PANEL.api('/api/crm/store', {
      method: 'POST',
      body: JSON.stringify({ col: 'contatos', doc: doc })
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('resposta inválida');
      return r;
    })['catch'](function () {
      toast('Não foi possível salvar. Recarregando...', true);
      carregado = false;
      carregar(true);
    });
  }

  /* ---------- ícones (SVG inline) ---------- */

  var ICONE_EDITAR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
  var ICONE_EXCLUIR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  /* ---------- renderização ---------- */

  function renderTudo() {
    injetarEstilo();
    container.innerHTML =
      '<div class="ct-topo">' +
        '<input type="text" class="ct-busca" placeholder="Buscar por nome, empresa ou WhatsApp..." aria-label="Buscar contatos">' +
        '<div class="ct-acoes">' +
          '<button type="button" class="btn ct-btn-importar">Importar do funil</button>' +
          '<button type="button" class="btn btn-acento ct-btn-novo">+ Contato</button>' +
        '</div>' +
      '</div>' +
      '<div class="ct-contador"></div>' +
      '<div class="ct-lista"></div>';

    var busca = container.querySelector('.ct-busca');
    busca.addEventListener('input', function () { renderLista(); });

    container.querySelector('.ct-btn-novo').addEventListener('click', function () {
      abrirModal(null);
    });

    container.querySelector('.ct-btn-importar').addEventListener('click', importarFunil);

    container.querySelector('.ct-lista').addEventListener('click', function (e) {
      var alvo = e.target;
      while (alvo && alvo !== e.currentTarget && !(alvo.getAttribute && alvo.getAttribute('data-acao'))) {
        alvo = alvo.parentNode;
      }
      if (!alvo || alvo === e.currentTarget || !alvo.getAttribute) return;
      var acao = alvo.getAttribute('data-acao');
      var id = alvo.getAttribute('data-id');
      var contato = acharPorId(id);
      if (!contato) return;
      if (acao === 'editar') abrirModal(contato);
      else if (acao === 'excluir') excluirContato(contato);
    });

    renderLista();
  }

  function acharPorId(id) {
    var lista = doc.contatos;
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === id) return lista[i];
    }
    return null;
  }

  function filtrar(termo) {
    var lista = doc.contatos.slice();
    lista.sort(function (a, b) {
      var na = String(a.nome || '').toLowerCase();
      var nb = String(b.nome || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
    if (!termo) return lista;
    var q = termo.toLowerCase();
    var qd = soDigitos(termo);
    var res = [];
    for (var i = 0; i < lista.length; i++) {
      var c = lista[i];
      var bate =
        String(c.nome || '').toLowerCase().indexOf(q) >= 0 ||
        String(c.empresa || '').toLowerCase().indexOf(q) >= 0 ||
        String(c.whatsapp || '').toLowerCase().indexOf(q) >= 0 ||
        (qd && soDigitos(c.whatsapp).indexOf(qd) >= 0);
      if (bate) res.push(c);
    }
    return res;
  }

  function renderLista() {
    var alvo = container.querySelector('.ct-lista');
    var contador = container.querySelector('.ct-contador');
    if (!alvo) return;

    var buscaEl = container.querySelector('.ct-busca');
    var termo = buscaEl ? buscaEl.value.replace(/^\s+|\s+$/g, '') : '';
    var lista = filtrar(termo);
    var total = doc.contatos.length;

    if (contador) {
      contador.textContent = total === 0 ? '' :
        (termo ? lista.length + ' de ' + total + ' contato(s)' : total + ' contato(s)');
    }

    if (total === 0) {
      alvo.innerHTML =
        '<div class="ct-vazio"><strong>Nenhum contato cadastrado ainda.</strong><br>' +
        'Clique em <strong>+ Contato</strong> para adicionar o primeiro, ou use ' +
        '<strong>Importar do funil</strong> para trazer os clientes que já estão nos seus cards.</div>';
      return;
    }

    if (lista.length === 0) {
      alvo.innerHTML =
        '<div class="ct-vazio">Nenhum contato encontrado para <strong>' + esc(termo) + '</strong>.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < lista.length; i++) {
      var c = lista[i];
      var links = '';
      if (soDigitos(c.whatsapp)) {
        links += '<a class="ct-wa" href="' + esc(linkWa(c.whatsapp)) + '" target="_blank" rel="noopener">' +
          esc(formatarWhats(c.whatsapp)) + '</a>';
      }
      if (c.email) {
        links += '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>';
      }
      html +=
        '<div class="card ct-card">' +
          '<div class="ct-info">' +
            '<div class="ct-nome">' + esc(c.nome) + '</div>' +
            (c.empresa ? '<div class="ct-empresa">' + esc(c.empresa) + '</div>' : '') +
            (links ? '<div class="ct-links">' + links + '</div>' : '') +
            (c.notas ? '<div class="ct-notas">' + esc(c.notas) + '</div>' : '') +
          '</div>' +
          '<div class="ct-botoes">' +
            '<button type="button" class="ct-icone" title="Editar contato" data-acao="editar" data-id="' + esc(c.id) + '">' + ICONE_EDITAR + '</button>' +
            '<button type="button" class="ct-icone ct-perigo" title="Excluir contato" data-acao="excluir" data-id="' + esc(c.id) + '">' + ICONE_EXCLUIR + '</button>' +
          '</div>' +
        '</div>';
    }
    alvo.innerHTML = html;
  }

  /* ---------- modal criar/editar ---------- */

  function abrirModal(contato) {
    fecharModal();
    var editando = !!contato;
    var overlay = document.createElement('div');
    overlay.className = 'ct-overlay';
    overlay.id = 'ctOverlay';
    overlay.innerHTML =
      '<div class="ct-modal" role="dialog" aria-modal="true">' +
        '<h3>' + (editando ? 'Editar contato' : 'Novo contato') + '</h3>' +
        '<div class="ct-campo"><label>Nome <b>*</b></label>' +
          '<input type="text" class="ct-f-nome" maxlength="120" value="' + esc(editando ? contato.nome : '') + '"></div>' +
        '<div class="ct-campo"><label>WhatsApp</label>' +
          '<input type="tel" class="ct-f-whatsapp" maxlength="25" placeholder="(11) 91234-5678" value="' + esc(editando ? contato.whatsapp : '') + '"></div>' +
        '<div class="ct-campo"><label>E-mail</label>' +
          '<input type="email" class="ct-f-email" maxlength="160" value="' + esc(editando ? contato.email : '') + '"></div>' +
        '<div class="ct-campo"><label>Empresa</label>' +
          '<input type="text" class="ct-f-empresa" maxlength="120" value="' + esc(editando ? contato.empresa : '') + '"></div>' +
        '<div class="ct-campo"><label>Notas</label>' +
          '<textarea class="ct-f-notas" maxlength="2000">' + esc(editando ? contato.notas : '') + '</textarea></div>' +
        '<div class="ct-modal-acoes">' +
          (editando ? '<button type="button" class="ct-btn-excluir">Excluir</button>' : '') +
          '<button type="button" class="btn ct-btn-cancelar">Cancelar</button>' +
          '<button type="button" class="btn btn-acento ct-btn-salvar">' + (editando ? 'Salvar' : 'Adicionar') + '</button>' +
        '</div>' +
      '</div>';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) fecharModal();
    });
    overlay.querySelector('.ct-btn-cancelar').addEventListener('click', fecharModal);

    if (editando) {
      overlay.querySelector('.ct-btn-excluir').addEventListener('click', function () {
        excluirContato(contato);
      });
    }

    overlay.querySelector('.ct-btn-salvar').addEventListener('click', function () {
      var vNome = overlay.querySelector('.ct-f-nome');
      var nome = vNome.value.replace(/^\s+|\s+$/g, '');
      if (!nome) {
        vNome.className = vNome.className.replace(/\s*ct-invalido/g, '') + ' ct-invalido';
        vNome.focus();
        toast('Informe o nome do contato.', true);
        return;
      }
      var whatsapp = overlay.querySelector('.ct-f-whatsapp').value.replace(/^\s+|\s+$/g, '');
      var email = overlay.querySelector('.ct-f-email').value.replace(/^\s+|\s+$/g, '');
      var empresa = overlay.querySelector('.ct-f-empresa').value.replace(/^\s+|\s+$/g, '');
      var notas = overlay.querySelector('.ct-f-notas').value.replace(/^\s+|\s+$/g, '');

      if (editando) {
        contato.nome = nome;
        contato.whatsapp = whatsapp;
        contato.email = email;
        contato.empresa = empresa;
        contato.notas = notas;
        contato.atualizadoEm = agora();
      } else {
        doc.contatos.push({
          id: novoId(),
          nome: nome,
          whatsapp: whatsapp,
          email: email,
          empresa: empresa,
          notas: notas,
          criadoEm: agora(),
          atualizadoEm: agora()
        });
      }
      fecharModal();
      renderLista();
      salvar().then(function (r) {
        if (r) toast(editando ? 'Contato atualizado.' : 'Contato adicionado.');
      });
    });

    document.body.appendChild(overlay);
    var primeiro = overlay.querySelector('.ct-f-nome');
    if (primeiro) primeiro.focus();
  }

  function fecharModal() {
    var overlay = document.getElementById('ctOverlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function excluirContato(contato) {
    if (!confirm('Excluir o contato "' + String(contato.nome || '') + '"? Essa ação não pode ser desfeita.')) return;
    var novos = [];
    for (var i = 0; i < doc.contatos.length; i++) {
      if (doc.contatos[i].id !== contato.id) novos.push(doc.contatos[i]);
    }
    doc.contatos = novos;
    fecharModal();
    renderLista();
    salvar().then(function (r) {
      if (r) toast('Contato excluído.');
    });
  }

  /* ---------- importar do funil ---------- */

  function coletarDoFunil(v, saida, prof) {
    if (prof > 6 || v == null) return;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (var i = 0; i < v.length; i++) coletarDoFunil(v[i], saida, prof + 1);
      return;
    }
    if (typeof v !== 'object') return;
    var w = v.whatsapp != null ? v.whatsapp : (v.telefone != null ? v.telefone : v.fone);
    if (w != null && soDigitos(w)) {
      saida.push({
        nome: String(v.nome || v.titulo || v.cliente || v.contato || 'Sem nome'),
        whatsapp: String(w),
        email: String(v.email || ''),
        empresa: String(v.empresa || '')
      });
    }
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) {
        var filho = v[k];
        if (filho && typeof filho === 'object') coletarDoFunil(filho, saida, prof + 1);
      }
    }
  }

  function importarFunil() {
    var botao = container.querySelector('.ct-btn-importar');
    if (botao) { botao.disabled = true; botao.textContent = 'Importando...'; }

    function restaurar() {
      if (botao) { botao.disabled = false; botao.textContent = 'Importar do funil'; }
    }

    PANEL.api('/api/crm/store?col=funil').then(function (r) {
      restaurar();
      var docFunil = r ? r.doc : null;
      if (!docFunil) {
        toast('Nenhum dado encontrado no funil.', true);
        return;
      }
      var achados = [];
      coletarDoFunil(docFunil, achados, 0);

      var existentes = {};
      for (var i = 0; i < doc.contatos.length; i++) {
        var d = soDigitos(doc.contatos[i].whatsapp);
        if (d) existentes[d] = true;
      }

      var novos = 0;
      for (var j = 0; j < achados.length; j++) {
        var a = achados[j];
        var dj = soDigitos(a.whatsapp);
        if (!dj || existentes[dj]) continue;
        existentes[dj] = true;
        doc.contatos.push({
          id: novoId(),
          nome: a.nome,
          whatsapp: a.whatsapp,
          email: a.email,
          empresa: a.empresa,
          notas: '',
          criadoEm: agora(),
          atualizadoEm: agora()
        });
        novos++;
      }

      if (novos > 0) {
        renderLista();
        salvar().then(function (rs) {
          if (rs) toast(novos + ' contato(s) importado(s) do funil.');
        });
      } else {
        toast('Nenhum contato novo para importar: todos já estão na lista.');
      }
    })['catch'](function () {
      restaurar();
      toast('Não foi possível ler o funil. Tente novamente.', true);
    });
  }

  /* ---------- carregamento ---------- */

  function carregar(forcar) {
    container = PANEL.el('contatosConteudo');
    if (!container) return;
    injetarEstilo();

    if (carregado && doc && !forcar) {
      renderTudo();
      return;
    }

    container.innerHTML = PANEL.skeleton([44, 84, 84, 84]);

    PANEL.api('/api/crm/store?col=contatos').then(function (r) {
      doc = (r && r.doc) ? r.doc : { contatos: [] };
      if (!doc.contatos) doc.contatos = [];
      carregado = true;
      renderTudo();
    })['catch'](function () {
      PANEL.renderErro(container, function () { carregar(true); });
    });
  }

  PANEL.registrar('contatos', { carregar: carregar });
})();
