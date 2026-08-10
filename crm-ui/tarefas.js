/* Módulo do painel: aba "tarefas" — lista de tarefas com data opcional.
   Contrato: IIFE pura, ES5, sem libs externas. Depende de window.PANEL. */
(function () {
  var container = null;
  var doc = null;
  var carregando = false;
  var mostrarConcluidas = false;
  var cssInjetado = false;

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

  function hojeStr() {
    var d = new Date();
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var dia = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + m + '-' + dia;
  }

  function fmtDdMm(q) {
    /* q = 'YYYY-MM-DD' → 'dd/mm' */
    return q.slice(8, 10) + '/' + q.slice(5, 7);
  }

  function novoId() {
    return 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function achar(id) {
    var lista = doc && doc.tarefas ? doc.tarefas : [];
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === id) return lista[i];
    }
    return null;
  }

  /* ---------- CSS ---------- */

  function injetarCss() {
    if (cssInjetado) return;
    cssInjetado = true;
    var style = document.createElement('style');
    style.setAttribute('data-mod', 'tarefas');
    style.textContent =
      '.tf-form{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin-bottom:12px}' +
      '.tf-form input[type=text]{flex:1 1 160px;min-width:0;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:10px;color:var(--texto,#F1F5FF);padding:10px 12px;font-size:14px;outline:none;transition:border-color .18s ease,box-shadow .18s ease}' +
      '.tf-form input[type=date]{flex:0 1 150px;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:10px;color:var(--texto,#F1F5FF);padding:9px 10px;font-size:13px;outline:none;color-scheme:dark;transition:border-color .18s ease,box-shadow .18s ease}' +
      '.tf-form input::placeholder{color:var(--cinza,#5C6B95)}' +
      '.tf-form input:focus{border-color:var(--azul,#2E6BFF);box-shadow:0 0 0 2px rgba(46,107,255,.22)}' +
      '.tf-form button{flex:0 0 auto;border-radius:10px;transition:filter .18s ease,border-color .18s ease}' +
      '.tf-contador{color:var(--texto2,#9AAAD0);font-size:13px;margin:0 0 10px 2px}' +
      '.tf-contador .tf-atrasadas-on{color:var(--vermelho-claro,#FF4767);font-weight:600}' +
      '.tf-lista{list-style:none;margin:0;padding:0}' +
      '.tf-item{display:flex;align-items:flex-start;gap:10px;background:var(--card,#0E1738);border:1px solid var(--borda,#1E2B5A);border-radius:14px;padding:11px 12px;margin-bottom:8px;transition:border-color .18s ease,background-color .18s ease,opacity .18s ease}' +
      '.tf-item:hover{border-color:var(--borda2,#2B3C74);background:var(--card2,#131E45)}' +
      '.tf-item input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:var(--azul,#2E6BFF);cursor:pointer;flex:0 0 auto}' +
      '.tf-item input[type=checkbox]:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.tf-corpo{flex:1 1 auto;min-width:0}' +
      '.tf-titulo{color:var(--texto,#F1F5FF);font-size:14px;line-height:1.35;word-wrap:break-word;overflow-wrap:break-word}' +
      '.tf-nota{color:var(--texto2,#9AAAD0);font-size:12px;margin-top:2px;word-wrap:break-word;overflow-wrap:break-word}' +
      '.tf-item-feito{opacity:.6}' +
      '.tf-item-feito .tf-titulo{text-decoration:line-through;color:var(--texto2,#9AAAD0)}' +
      '.tf-badge{flex:0 0 auto;font-size:11px;line-height:1;padding:5px 9px;border-radius:999px;white-space:nowrap;margin-top:3px;font-weight:600;letter-spacing:.02em}' +
      '.tf-badge-hoje{color:var(--amarelo,#F5B301);background:rgba(245,179,1,.12);border:1px solid rgba(245,179,1,.35)}' +
      '.tf-badge-atrasada{color:var(--vermelho-claro,#FF4767);background:rgba(225,29,60,.12);border:1px solid rgba(225,29,60,.38)}' +
      '.tf-badge-futura{color:var(--texto2,#9AAAD0);background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);font-weight:500}' +
      '.tf-excluir{flex:0 0 auto;background:none;border:none;color:var(--cinza,#5C6B95);font-size:18px;line-height:1;cursor:pointer;padding:2px 7px;border-radius:10px;transition:color .18s ease,background-color .18s ease}' +
      '.tf-excluir:hover{color:var(--vermelho-claro,#FF4767);background:rgba(225,29,60,.12)}' +
      '.tf-excluir:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.tf-vazio{color:var(--texto2,#9AAAD0);text-align:center;padding:28px 12px;font-size:14px}' +
      '.tf-sec-concluidas{margin-top:16px;border-top:1px solid var(--borda,#1E2B5A);padding-top:8px}' +
      '.tf-toggle-concluidas{background:none;border:none;color:var(--texto2,#9AAAD0);font-size:13px;cursor:pointer;padding:6px 2px;display:flex;align-items:center;gap:6px;border-radius:10px;transition:color .18s ease}' +
      '.tf-toggle-concluidas:hover{color:var(--texto,#F1F5FF)}' +
      '.tf-toggle-concluidas:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.tf-seta{display:inline-block;font-size:10px;color:var(--azul-claro,#6098FF)}' +
      '@media (min-width:640px){.tf-form input[type=text]{flex-basis:260px}}';
    document.head.appendChild(style);
  }

  /* ---------- persistência ---------- */

  function salvar() {
    PANEL.api('/api/crm/store', {
      method: 'POST',
      body: JSON.stringify({ col: 'tarefas', doc: doc })
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('save');
    }).catch(function () {
      alert('Não foi possível salvar as tarefas. Os dados serão recarregados.');
      carregar(true);
    });
  }

  /* ---------- ações ---------- */

  function aoAdicionar() {
    var inpTitulo = container.querySelector('.tf-inp-titulo');
    var inpData = container.querySelector('.tf-inp-data');
    if (!inpTitulo) return;
    var titulo = (inpTitulo.value || '').replace(/^\s+|\s+$/g, '');
    if (!titulo) { inpTitulo.focus(); return; }
    var quando = inpData && inpData.value ? inpData.value : null;
    doc.tarefas.push({
      id: novoId(),
      titulo: titulo,
      quando: quando,
      feito: false,
      nota: '',
      criadoEm: new Date().toISOString(),
      concluidaEm: null
    });
    render();
    var novoInp = container.querySelector('.tf-inp-titulo');
    if (novoInp) novoInp.focus();
    salvar();
  }

  function aoToggle(id) {
    var t = achar(id);
    if (!t) return;
    t.feito = !t.feito;
    t.concluidaEm = t.feito ? new Date().toISOString() : null;
    if (t.feito) mostrarConcluidas = true;
    render();
    salvar();
  }

  function aoExcluir(id) {
    var t = achar(id);
    if (!t) return;
    if (!confirm('Excluir a tarefa "' + t.titulo + '"?')) return;
    var novas = [];
    for (var i = 0; i < doc.tarefas.length; i++) {
      if (doc.tarefas[i].id !== id) novas.push(doc.tarefas[i]);
    }
    doc.tarefas = novas;
    render();
    salvar();
  }

  /* ---------- render ---------- */

  function ordPendentes(a, b) {
    if (a.quando && b.quando) {
      if (a.quando < b.quando) return -1;
      if (a.quando > b.quando) return 1;
    } else if (a.quando && !b.quando) {
      return -1;
    } else if (!a.quando && b.quando) {
      return 1;
    }
    var ca = a.criadoEm || '';
    var cb = b.criadoEm || '';
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return 0;
  }

  function ordConcluidas(a, b) {
    var ca = a.concluidaEm || '';
    var cb = b.concluidaEm || '';
    if (ca > cb) return -1;
    if (ca < cb) return 1;
    return 0;
  }

  function htmlBadge(t, hoje) {
    if (!t.quando) return '';
    var cls, txt;
    if (t.quando === hoje) {
      cls = 'tf-badge-hoje';
      txt = 'hoje';
    } else if (t.quando < hoje) {
      cls = 'tf-badge-atrasada';
      txt = 'atrasada · ' + fmtDdMm(t.quando);
    } else {
      cls = 'tf-badge-futura';
      txt = fmtDdMm(t.quando);
    }
    return '<span class="tf-badge ' + cls + '">' + esc(txt) + '</span>';
  }

  function htmlItem(t, hoje) {
    return '<li class="tf-item' + (t.feito ? ' tf-item-feito' : '') + '">' +
      '<input type="checkbox" data-acao="toggle" data-id="' + esc(t.id) + '"' + (t.feito ? ' checked' : '') + ' aria-label="Marcar como ' + (t.feito ? 'pendente' : 'concluída') + '">' +
      '<div class="tf-corpo">' +
      '<div class="tf-titulo">' + esc(t.titulo) + '</div>' +
      (t.nota ? '<div class="tf-nota">' + esc(t.nota) + '</div>' : '') +
      '</div>' +
      htmlBadge(t, hoje) +
      '<button type="button" class="tf-excluir" data-acao="excluir" data-id="' + esc(t.id) + '" aria-label="Excluir tarefa" title="Excluir">&times;</button>' +
      '</li>';
  }

  function plural(n, sing, plu) {
    return n + ' ' + (n === 1 ? sing : plu);
  }

  function render() {
    if (!container) return;
    var hoje = hojeStr();
    var lista = doc.tarefas || [];
    var pendentes = [];
    var concluidas = [];
    var atrasadas = 0;
    var i;
    for (i = 0; i < lista.length; i++) {
      if (lista[i].feito) {
        concluidas.push(lista[i]);
      } else {
        pendentes.push(lista[i]);
        if (lista[i].quando && lista[i].quando < hoje) atrasadas++;
      }
    }
    pendentes.sort(ordPendentes);
    concluidas.sort(ordConcluidas);

    var html = '<div class="card">' +
      '<form class="tf-form">' +
      '<input type="text" class="tf-inp-titulo" maxlength="200" placeholder="Nova tarefa..." aria-label="Título da tarefa">' +
      '<input type="date" class="tf-inp-data" aria-label="Data (opcional)">' +
      '<button type="submit" class="btn btn-acento">Adicionar</button>' +
      '</form>' +
      '<p class="tf-contador">' +
      plural(pendentes.length, 'pendente', 'pendentes') +
      ' · <span class="' + (atrasadas > 0 ? 'tf-atrasadas-on' : '') + '">' +
      plural(atrasadas, 'atrasada', 'atrasadas') +
      '</span></p>';

    if (lista.length === 0) {
      html += '<div class="tf-vazio">Nenhuma tarefa por aqui. Adicione a primeira no campo acima.</div>';
    } else {
      html += '<ul class="tf-lista">';
      for (i = 0; i < pendentes.length; i++) html += htmlItem(pendentes[i], hoje);
      html += '</ul>';
      if (pendentes.length === 0) {
        html += '<div class="tf-vazio">Tudo em dia! Nenhuma tarefa pendente.</div>';
      }
      if (concluidas.length > 0) {
        html += '<div class="tf-sec-concluidas">' +
          '<button type="button" class="tf-toggle-concluidas" data-acao="toggle-concluidas">' +
          '<span class="tf-seta">' + (mostrarConcluidas ? '▼' : '▶') + '</span>' +
          'Concluídas (' + concluidas.length + ')' +
          '</button>';
        if (mostrarConcluidas) {
          html += '<ul class="tf-lista">';
          for (i = 0; i < concluidas.length; i++) html += htmlItem(concluidas[i], hoje);
          html += '</ul>';
        }
        html += '</div>';
      }
    }
    html += '</div>';

    container.innerHTML = html;
    ligarEventos();
  }

  function ligarEventos() {
    var form = container.querySelector('.tf-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        aoAdicionar();
      });
    }
    var i;
    var checks = container.querySelectorAll('input[data-acao="toggle"]');
    for (i = 0; i < checks.length; i++) {
      checks[i].addEventListener('change', function () {
        aoToggle(this.getAttribute('data-id'));
      });
    }
    var botoesExcluir = container.querySelectorAll('button[data-acao="excluir"]');
    for (i = 0; i < botoesExcluir.length; i++) {
      botoesExcluir[i].addEventListener('click', function () {
        aoExcluir(this.getAttribute('data-id'));
      });
    }
    var toggleConc = container.querySelector('button[data-acao="toggle-concluidas"]');
    if (toggleConc) {
      toggleConc.addEventListener('click', function () {
        mostrarConcluidas = !mostrarConcluidas;
        render();
      });
    }
  }

  /* ---------- carga ---------- */

  function carregar(forcar) {
    container = PANEL.el('tarefasConteudo');
    if (!container) return;
    injetarCss();
    if (doc && !forcar) {
      render();
      return;
    }
    if (carregando) return;
    carregando = true;
    container.innerHTML = PANEL.skeleton([56, 32, 64, 64, 64]);
    PANEL.api('/api/crm/store?col=tarefas').then(function (resp) {
      carregando = false;
      doc = (resp && resp.doc) ? resp.doc : { tarefas: [] };
      if (!doc.tarefas) doc.tarefas = [];
      render();
    }).catch(function () {
      carregando = false;
      PANEL.renderErro(container, function () { carregar(true); });
    });
  }

  PANEL.registrar('tarefas', { carregar: carregar });
})();
