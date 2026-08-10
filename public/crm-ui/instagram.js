/* ============================================================
   Aba "Instagram" — perfil, KPIs e posts (crm-ui/instagram.js)
   Contrato: IIFE, ES5 puro, sem libs. Usa window.PANEL
   (api / el / skeleton / renderErro / registrar).

   Fonte de dados: GET /api/crm/instagram  (?forcar=1 ignora cache)

   Formato esperado — estado CONECTADO:
   { ok:true, precisaPermissao:false,
     perfil:  { usuario, nome, biografia, foto, seguidores, posts },
     metricas:{ mediaCurtidas, mediaComentarios, mediaAlcance },
     posts:[ { id, tipo, miniatura, permalink, legenda,
               curtidas, comentarios, alcance, publicadoEm } ] }

   Formato esperado — estado SEM PERMISSÃO (token ainda sem os escopos
   instagram_basic / instagram_manage_insights):
   { ok:true, precisaPermissao:true, perfil:{...}, mensagem:"(#10) ..." }

   O módulo é tolerante: também aceita os nomes crus da Graph API
   (username, profile_picture_url, followers_count, media_count,
   media_type, media_product_type, thumbnail_url, media_url,
   like_count, comments_count, reach, timestamp) e detecta sozinho o
   erro de permissão (code 10). Assim, quando o token ganhar os escopos,
   a aba passa a mostrar os posts sem nenhuma alteração aqui.
   ============================================================ */
(function () {
  var container = null;
  var dados = null;        // resposta já normalizada
  var carregando = false;
  var ordem = 'recentes';  // recentes | curtidas | comentarios | alcance
  var cssOk = false;

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

  /* só deixa passar http(s) — evita javascript: vindo de dado externo */
  function urlSegura(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(/^\s+|\s+$/g, '');
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return '';
  }

  /* primeiro campo preenchido dentre vários nomes possíveis */
  function pega(obj) {
    if (!obj) return null;
    for (var i = 1; i < arguments.length; i++) {
      var v = obj[arguments[i]];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }

  function fmtInt(n) {
    if (n === null || n === undefined) return '—';
    n = Math.round(n);
    try { return n.toLocaleString('pt-BR'); } catch (e) { return String(n); }
  }

  function fmtMedia(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 100) return fmtInt(n);
    var s = (Math.round(n * 10) / 10).toFixed(1);
    return s.replace('.', ',');
  }

  function paraMs(t) {
    if (t === null || t === undefined || t === '') return null;
    if (typeof t === 'number') return t < 1e11 ? t * 1000 : t;
    var p = Date.parse(String(t));
    return isNaN(p) ? null : p;
  }

  function fmtDataCurta(ms) {
    if (ms === null || ms === undefined) return '';
    var d = new Date(ms);
    var dia = ('0' + d.getDate()).slice(-2);
    var mes = ('0' + (d.getMonth() + 1)).slice(-2);
    var ano = String(d.getFullYear());
    var agora = new Date();
    if (ano === String(agora.getFullYear())) return dia + '/' + mes;
    return dia + '/' + mes + '/' + ano.slice(-2);
  }

  function plural(n, sing, plu) {
    return fmtInt(n) + ' ' + (n === 1 ? sing : plu);
  }

  function usuarioLimpo(u) {
    return String(u || '').replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
  }

  function cortar(s, max) {
    s = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  /* ---------------- CSS (injetado uma única vez) ---------------- */

  function injetarCss() {
    if (cssOk) return;
    cssOk = true;
    var st = document.createElement('style');
    st.setAttribute('data-mod', 'instagram');
    st.textContent = '' +
      /* cabeçalho do perfil */
      '.ig-topo{display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
      '.ig-avatar{width:64px;height:64px;flex:0 0 auto;border-radius:50%;overflow:hidden;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);display:flex;align-items:center;justify-content:center}' +
      '.ig-avatar img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.ig-avatar-letra{color:var(--texto2,#9AAAD0);font-size:24px;font-weight:700;line-height:1}' +
      '.ig-idt{flex:1 1 160px;min-width:0}' +
      '.ig-nome{font-size:16px;font-weight:700;color:var(--texto,#F1F5FF);line-height:1.25;word-wrap:break-word;overflow-wrap:break-word}' +
      '.ig-user{display:inline-block;margin-top:2px;font-size:13px;color:var(--azul-claro,#6098FF);text-decoration:none;word-break:break-all;transition:color .18s ease}' +
      '.ig-user:hover{text-decoration:underline}' +
      '.ig-bio{font-size:12.5px;color:var(--texto2,#9AAAD0);line-height:1.45;margin-top:5px;word-wrap:break-word;overflow-wrap:break-word}' +
      '.ig-acoes{flex:0 0 auto;margin-left:auto;display:flex;gap:8px}' +
      '.ig-acoes .btn{border-radius:10px;transition:filter .18s ease,border-color .18s ease}' +
      /* KPIs */
      '.ig-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:14px}' +
      '.ig-kpi{background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:14px;padding:12px 13px;min-width:0;transition:border-color .18s ease,background-color .18s ease}' +
      '.ig-kpi:hover{border-color:var(--borda2,#2B3C74);background:var(--card2,#131E45)}' +
      '.ig-kpi-rot{font-size:11px;color:var(--texto2,#9AAAD0);text-transform:uppercase;letter-spacing:.08em;line-height:1.3}' +
      '.ig-kpi-val{font-size:24px;font-weight:800;color:var(--branco,#FFFFFF);margin-top:4px;line-height:1.15;word-break:break-word}' +
      /* ordenação */
      '.ig-barra{display:flex;gap:6px;overflow-x:auto;margin:18px 0 10px;padding-bottom:3px;-webkit-overflow-scrolling:touch;scrollbar-width:none}' +
      '.ig-barra::-webkit-scrollbar{display:none}' +
      '.ig-ord{background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);color:var(--texto2,#9AAAD0);border-radius:999px;padding:7px 14px;font-size:12.5px;line-height:1;white-space:nowrap;cursor:pointer;transition:color .18s ease,border-color .18s ease,background-color .18s ease}' +
      '.ig-ord:hover{color:var(--texto,#F1F5FF);border-color:var(--borda2,#2B3C74);background:var(--card2,#131E45)}' +
      '.ig-ord:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.ig-ord-on{background:rgba(46,107,255,.16);border-color:var(--azul,#2E6BFF);color:var(--texto,#F1F5FF);font-weight:600}' +
      '.ig-ord-on:hover{background:rgba(46,107,255,.22);border-color:var(--azul,#2E6BFF)}' +
      /* grade de posts */
      '.ig-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}' +
      '.ig-post{display:block;background:var(--card,#0E1738);border:1px solid var(--borda,#1E2B5A);border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;transition:border-color .18s ease,transform .18s ease,box-shadow .18s ease}' +
      '.ig-post:hover{border-color:var(--borda2,#2B3C74);transform:translateY(-2px);box-shadow:var(--sombra,0 10px 30px rgba(0,0,0,.45))}' +
      '.ig-post:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.ig-thumb{position:relative;height:150px;background:var(--bg2,#0A1230);overflow:hidden}' +
      '.ig-thumb img{width:100%;height:150px;object-fit:cover;display:block}' +
      '.ig-sem-img{height:150px;display:flex;align-items:center;justify-content:center;color:var(--cinza,#5C6B95);font-size:12px;text-align:center;padding:0 10px}' +
      '.ig-tipo{position:absolute;top:8px;right:8px;background:rgba(6,11,31,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid var(--borda2,#2B3C74);color:var(--texto,#F1F5FF);font-size:10px;font-weight:700;letter-spacing:.06em;padding:4px 8px;border-radius:999px;line-height:1.2}' +
      '.ig-legenda{font-size:12.5px;color:var(--texto,#F1F5FF);line-height:1.4;padding:10px 11px 0;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:44px;word-wrap:break-word;overflow-wrap:break-word}' +
      '.ig-legenda-vazia{color:var(--cinza,#5C6B95);font-style:italic}' +
      '.ig-rodape{display:flex;align-items:center;flex-wrap:wrap;gap:4px 7px;padding:9px 11px 11px;font-size:12px;color:var(--texto2,#9AAAD0)}' +
      '.ig-sep{color:var(--borda2,#2B3C74)}' +
      '.ig-data{margin-left:auto;font-size:11px;color:var(--cinza,#5C6B95)}' +
      /* aviso de permissão */
      '.ig-aviso{background:rgba(46,107,255,.08);border:1px solid rgba(46,107,255,.4);border-radius:16px;padding:16px}' +
      '.ig-aviso-tit{font-size:14.5px;font-weight:700;color:var(--texto,#F1F5FF);margin:0 0 6px}' +
      '.ig-aviso-txt{font-size:13px;color:var(--texto2,#9AAAD0);line-height:1.5;margin:0}' +
      '.ig-aviso-txt b{color:var(--texto,#F1F5FF);font-weight:600}' +
      '.ig-mini{display:flex;align-items:center;gap:10px;background:var(--card,#0E1738);border:1px solid var(--borda,#1E2B5A);border-radius:14px;padding:11px;margin:12px 0}' +
      '.ig-mini .ig-avatar{width:48px;height:48px}' +
      '.ig-mini-nome{font-size:13.5px;font-weight:600;color:var(--texto,#F1F5FF);line-height:1.3;word-break:break-all}' +
      '.ig-mini-sub{font-size:12px;color:var(--texto2,#9AAAD0);margin-top:2px}' +
      '.ig-passos{margin:12px 0 0;padding-left:20px;color:var(--texto2,#9AAAD0);font-size:13px;line-height:1.55}' +
      '.ig-passos li{margin-bottom:8px}' +
      '.ig-passos b{color:var(--texto,#F1F5FF);font-weight:600}' +
      '.ig-cod{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--texto,#F1F5FF);background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:8px;padding:2px 6px;word-break:break-all}' +
      '.ig-rodape-aviso{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px}' +
      '.ig-rodape-aviso .btn{border-radius:10px;transition:filter .18s ease,border-color .18s ease}' +
      '.ig-det{margin-top:12px;font-size:12px;color:var(--texto2,#9AAAD0)}' +
      '.ig-det summary{cursor:pointer;color:var(--texto2,#9AAAD0);outline:none;transition:color .18s ease}' +
      '.ig-det summary:hover{color:var(--texto,#F1F5FF)}' +
      '.ig-det summary:focus-visible{outline:2px solid var(--azul-claro,#6098FF);outline-offset:2px}' +
      '.ig-det p{margin:7px 0 0;line-height:1.5;word-break:break-word}' +
      '.ig-vazio{color:var(--texto2,#9AAAD0);text-align:center;padding:28px 12px;font-size:14px;line-height:1.5}' +
      '.ig-erro-txt{color:var(--vermelho-claro,#FF4767);font-size:13px;margin:0 0 10px;line-height:1.5}' +
      '.ig-espaco{margin-top:12px}' +
      '@media (min-width:560px){.ig-kpis{grid-template-columns:repeat(3,1fr)}.ig-kpi-val{font-size:28px}}' +
      '@media (min-width:900px){.ig-kpis{grid-template-columns:repeat(5,1fr)}}';
    document.head.appendChild(st);
  }

  /* ---------------- normalização da resposta ---------------- */

  function rotuloTipo(p) {
    var prod = String(pega(p, 'media_product_type', 'mediaProductType') || '').toUpperCase();
    if (prod === 'REELS') return 'REELS';
    var t = String(pega(p, 'tipo', 'media_type', 'mediaType', 'tipoMidia') || '').toUpperCase();
    if (t === 'REELS' || t === 'REEL') return 'REELS';
    if (t === 'VIDEO' || t === 'VÍDEO') return 'VÍDEO';
    if (t === 'CAROUSEL_ALBUM' || t === 'CAROUSEL' || t === 'CARROSSEL' || t === 'ALBUM') return 'CARROSSEL';
    if (t === 'IMAGE' || t === 'PHOTO' || t === 'FOTO') return 'FOTO';
    return 'POST';
  }

  function normPost(p, i) {
    if (!p || typeof p !== 'object') return null;
    return {
      id: String(pega(p, 'id', 'ig_id', 'idPost') || ('post-' + i)),
      tipo: rotuloTipo(p),
      miniatura: urlSegura(pega(p, 'thumb', 'miniatura', 'thumbnail', 'thumbnail_url', 'thumbnailUrl', 'imagem', 'imagemUrl', 'media_url', 'mediaUrl')),
      permalink: urlSegura(pega(p, 'permalink', 'link', 'urlPost')),
      legenda: String(pega(p, 'legenda', 'caption', 'texto', 'descricao') || ''),
      curtidas: num(pega(p, 'curtidas', 'like_count', 'likeCount', 'likes')),
      comentarios: num(pega(p, 'comentarios', 'comments_count', 'commentsCount', 'comments')),
      alcance: num(pega(p, 'alcance', 'reach', 'impressoes_unicas')),
      quando: paraMs(pega(p, 'publicadoEm', 'timestamp', 'data', 'criadoEm', 'published_at')),
      pos: i
    };
  }

  function normPerfil(pf) {
    if (!pf || typeof pf !== 'object') return null;
    return {
      usuario: usuarioLimpo(pega(pf, 'usuario', 'username', 'user')),
      nome: String(pega(pf, 'nome', 'name', 'full_name', 'nomeExibicao') || ''),
      bio: String(pega(pf, 'biografia', 'bio', 'biography', 'descricao') || ''),
      foto: urlSegura(pega(pf, 'foto', 'fotoUrl', 'profile_picture_url', 'profilePictureUrl', 'avatar', 'imagem')),
      seguidores: num(pega(pf, 'seguidores', 'followers_count', 'followersCount', 'followers')),
      posts: num(pega(pf, 'posts', 'totalPosts', 'media_count', 'mediaCount', 'qtdPosts'))
    };
  }

  function faltaPermissao(r) {
    if (!r) return false;
    if (r.precisaPermissao === true || r.precisa_permissao === true) return true;
    if (r.permissao === false || r.conectado === false) return true;
    var err = r.erro || r.error || {};
    if (typeof err === 'string') err = { message: err };
    var cod = pega(r, 'codigo', 'code');
    if (cod === null) cod = pega(err, 'code', 'codigo');
    if (cod !== null && String(cod) === '10') return true;
    var msg = String(pega(r, 'mensagem', 'message') || pega(err, 'message', 'mensagem') || '');
    if (/permission for this action|does not have permission|sem permiss/i.test(msg)) return true;
    return false;
  }

  function mensagemTecnica(r) {
    if (!r) return '';
    var err = r.erro || r.error;
    if (typeof err === 'string' && err) return err;
    var m = pega(r, 'mensagem', 'message', 'detalhe');
    if (!m && err) m = pega(err, 'message', 'mensagem', 'detalhe');
    return m ? String(m) : '';
  }

  function media(lista, campo) {
    var soma = 0, qtd = 0;
    for (var i = 0; i < lista.length; i++) {
      var v = lista[i][campo];
      if (v !== null && v !== undefined) { soma += v; qtd++; }
    }
    return qtd ? (soma / qtd) : null;
  }

  function normalizar(r) {
    r = r || {};
    var out = {};
    out.perfil = normPerfil(r.perfil || r.conta || r.profile || r.usuario || null);
    out.precisaPermissao = faltaPermissao(r);
    out.mensagem = mensagemTecnica(r);
    out.atualizadoEm = paraMs(pega(r, 'atualizadoEm', 'updated_at', 'geradoEm'));

    var brutos = r.posts || r.midias || r.media || r.data || [];
    if (brutos && !Array.isArray(brutos) && Array.isArray(brutos.data)) brutos = brutos.data;
    if (!Array.isArray(brutos)) brutos = [];
    var lista = [];
    for (var i = 0; i < brutos.length; i++) {
      var p = normPost(brutos[i], i);
      if (p) lista.push(p);
    }
    out.posts = lista;

    var m = r.metricas || r.kpis || r.metrics || {};
    out.mediaCurtidas = num(pega(m, 'mediaCurtidas', 'media_curtidas', 'avgLikes'));
    out.mediaComentarios = num(pega(m, 'mediaComentarios', 'media_comentarios', 'avgComments'));
    out.mediaAlcance = num(pega(m, 'mediaAlcance', 'media_alcance', 'avgReach', 'alcanceMedio'));
    if (out.mediaCurtidas === null) out.mediaCurtidas = media(lista, 'curtidas');
    if (out.mediaComentarios === null) out.mediaComentarios = media(lista, 'comentarios');
    if (out.mediaAlcance === null) out.mediaAlcance = media(lista, 'alcance');

    out.temAlcance = false;
    for (var j = 0; j < lista.length; j++) {
      if (lista[j].alcance !== null) { out.temAlcance = true; break; }
    }
    return out;
  }

  /* ---------------- ordenação (em memória) ---------------- */

  var ORDENS = [
    { id: 'recentes', rot: 'Mais recentes' },
    { id: 'curtidas', rot: 'Mais curtidas' },
    { id: 'comentarios', rot: 'Mais comentários' },
    { id: 'alcance', rot: 'Maior alcance' }
  ];

  function cmpDesc(campo) {
    return function (a, b) {
      var va = a[campo], vb = b[campo];
      if (va === null && vb === null) return a.pos - b.pos;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (vb !== va) return vb - va;
      return a.pos - b.pos;
    };
  }

  function postsOrdenados() {
    var lista = dados.posts.slice(0);
    if (ordem === 'curtidas') lista.sort(cmpDesc('curtidas'));
    else if (ordem === 'comentarios') lista.sort(cmpDesc('comentarios'));
    else if (ordem === 'alcance') lista.sort(cmpDesc('alcance'));
    else lista.sort(cmpDesc('quando'));
    return lista;
  }

  /* ---------------- render: pedaços ---------------- */

  function htmlAvatar(perfil, classe) {
    var letra = (perfil && (perfil.usuario || perfil.nome) || '@').charAt(0).toUpperCase();
    var inner;
    if (perfil && perfil.foto) {
      inner = '<img src="' + esc(perfil.foto) + '" alt="Foto do perfil" loading="lazy" referrerpolicy="no-referrer" ' +
        'data-fallback="avatar" data-letra="' + esc(letra) + '">';
    } else {
      inner = '<span class="ig-avatar-letra">' + esc(letra) + '</span>';
    }
    return '<div class="ig-avatar' + (classe ? ' ' + classe : '') + '">' + inner + '</div>';
  }

  function htmlKpi(rotulo, valor) {
    return '<div class="ig-kpi">' +
      '<div class="ig-kpi-rot">' + esc(rotulo) + '</div>' +
      '<div class="ig-kpi-val">' + esc(valor) + '</div>' +
      '</div>';
  }

  function htmlBotaoAtualizar(rotulo) {
    return '<button type="button" class="btn btn-acento ig-btn-atualizar">' + esc(rotulo) + '</button>';
  }

  /* ---------------- render: sem permissão ---------------- */

  function renderSemPermissao() {
    var perfil = dados.perfil;
    var conta = perfil && perfil.usuario ? '@' + perfil.usuario : 'a conta do Instagram';
    var html = '<div class="card">' +
      '<div class="ig-aviso">' +
      '<p class="ig-aviso-tit">Quase lá: falta liberar o acesso aos posts</p>' +
      '<p class="ig-aviso-txt">O painel já enxerga o perfil de <b>' + esc(conta) + '</b>, ' +
      'mas ainda não tem autorização para ler as publicações e as métricas. ' +
      'É um ajuste de permissão de alguns minutos — assim que for feito, ' +
      'os posts aparecem aqui sozinhos, sem precisar mexer em mais nada.</p>';

    if (perfil) {
      html += '<div class="ig-mini">' +
        htmlAvatar(perfil, '') +
        '<div class="ig-idt">' +
        '<div class="ig-mini-nome">' + esc(perfil.nome || (perfil.usuario ? '@' + perfil.usuario : 'Conta do Instagram')) + '</div>' +
        '<div class="ig-mini-sub">' +
        (perfil.usuario ? '@' + esc(perfil.usuario) : '') +
        (perfil.usuario && perfil.seguidores !== null ? ' <span class="ig-sep">·</span> ' : '') +
        (perfil.seguidores !== null ? esc(plural(perfil.seguidores, 'seguidor', 'seguidores')) : '') +
        '</div>' +
        '</div>' +
        '</div>';
    }

    html += '<ol class="ig-passos">' +
      '<li>No <b>Business Manager</b>, abra <b>Usuários do sistema</b>, selecione <b>robowhatsap</b> e clique em <b>Atribuir ativos</b> → <b>Contas do Instagram</b>. Marque ' + esc(conta) + ' e ative <b>Controle total</b>.</li>' +
      '<li>Gere um <b>novo token</b> do app <b>integração claude</b> marcando as permissões <span class="ig-cod">instagram_basic</span> e <span class="ig-cod">instagram_manage_insights</span>.</li>' +
      '<li>Envie o token para o <b>Claude</b> atualizar a integração. Depois é só clicar em “Verificar de novo”.</li>' +
      '</ol>';

    html += '<div class="ig-rodape-aviso">' +
      '<button type="button" class="btn btn-acento ig-btn-verificar">Verificar de novo</button>' +
      '<span class="ig-aviso-txt">Nada quebra enquanto isso: o restante do painel segue normal.</span>' +
      '</div>';

    if (dados.mensagem) {
      html += '<details class="ig-det"><summary>Detalhe técnico</summary>' +
        '<p><span class="ig-cod">' + esc(cortar(dados.mensagem, 240)) + '</span></p></details>';
    }

    html += '</div></div>';
    container.innerHTML = html;
    ligarEventos();
  }

  /* ---------------- render: conectado ---------------- */

  function htmlPost(p) {
    var abre, fecha;
    if (p.permalink) {
      abre = '<a class="ig-post" href="' + esc(p.permalink) + '" target="_blank" rel="noopener noreferrer">';
      fecha = '</a>';
    } else {
      abre = '<div class="ig-post">';
      fecha = '</div>';
    }

    var thumb = p.miniatura
      ? '<img src="' + esc(p.miniatura) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="thumb">'
      : '<div class="ig-sem-img">sem prévia</div>';

    var legenda = p.legenda
      ? '<div class="ig-legenda">' + esc(cortar(p.legenda, 180)) + '</div>'
      : '<div class="ig-legenda ig-legenda-vazia">sem legenda</div>';

    var rodape = '<span>❤️ ' + esc(fmtInt(p.curtidas)) + '</span>' +
      '<span class="ig-sep">·</span>' +
      '<span>💬 ' + esc(fmtInt(p.comentarios)) + '</span>';
    if (p.alcance !== null) {
      rodape += '<span class="ig-sep">·</span><span>👁 ' + esc(fmtInt(p.alcance)) + '</span>';
    }
    if (p.quando !== null) {
      rodape += '<span class="ig-data">' + esc(fmtDataCurta(p.quando)) + '</span>';
    }

    return abre +
      '<div class="ig-thumb">' + thumb +
      '<span class="ig-tipo">' + esc(p.tipo) + '</span></div>' +
      legenda +
      '<div class="ig-rodape">' + rodape + '</div>' +
      fecha;
  }

  function htmlGrade() {
    if (!dados.posts.length) {
      return '<div class="ig-vazio">Nenhuma publicação por aqui ainda.<br>' +
        'Quando o perfil postar, os posts aparecem nesta grade automaticamente.</div>';
    }
    var lista = postsOrdenados();
    var html = '<div class="ig-grade">';
    for (var i = 0; i < lista.length; i++) html += htmlPost(lista[i]);
    html += '</div>';
    return html;
  }

  function htmlBarraOrdem() {
    if (dados.posts.length < 2) return '';
    var html = '<div class="ig-barra" role="group" aria-label="Ordenar publicações">';
    for (var i = 0; i < ORDENS.length; i++) {
      var o = ORDENS[i];
      if (o.id === 'alcance' && !dados.temAlcance) continue;
      html += '<button type="button" class="ig-ord' + (ordem === o.id ? ' ig-ord-on' : '') + '" ' +
        'data-ordem="' + esc(o.id) + '"' + (ordem === o.id ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        esc(o.rot) + '</button>';
    }
    html += '</div>';
    return html;
  }

  function renderConectado() {
    var perfil = dados.perfil || { usuario: '', nome: '', bio: '', foto: '', seguidores: null, posts: null };
    var titulo = perfil.nome || (perfil.usuario ? '@' + perfil.usuario : 'Perfil do Instagram');
    var totalPosts = perfil.posts !== null ? perfil.posts : dados.posts.length;

    var html = '<div class="card">' +
      '<div class="ig-topo">' +
      htmlAvatar(perfil, '') +
      '<div class="ig-idt">' +
      '<div class="ig-nome">' + esc(titulo) + '</div>' +
      (perfil.usuario
        ? '<a class="ig-user" href="https://www.instagram.com/' + esc(perfil.usuario) + '/" target="_blank" rel="noopener noreferrer">@' + esc(perfil.usuario) + '</a>'
        : '') +
      (perfil.bio ? '<div class="ig-bio">' + esc(cortar(perfil.bio, 160)) + '</div>' : '') +
      '</div>' +
      '<div class="ig-acoes">' + htmlBotaoAtualizar('Atualizar') + '</div>' +
      '</div>' +
      '<div class="ig-kpis">' +
      htmlKpi('Seguidores', fmtInt(perfil.seguidores)) +
      htmlKpi('Posts', fmtInt(totalPosts)) +
      htmlKpi('Média de curtidas', fmtMedia(dados.mediaCurtidas)) +
      htmlKpi('Média de comentários', fmtMedia(dados.mediaComentarios)) +
      (dados.mediaAlcance !== null ? htmlKpi('Alcance médio', fmtMedia(dados.mediaAlcance)) : '') +
      '</div>' +
      '</div>' +
      htmlBarraOrdem() +
      '<div class="ig-grade-wrap' + (dados.posts.length < 2 ? ' ig-espaco' : '') + '">' + htmlGrade() + '</div>';

    container.innerHTML = html;
    ligarEventos();
  }

  function renderErroAmigavel(msg) {
    container.innerHTML = '<div class="card">' +
      '<p class="ig-erro-txt">Não foi possível carregar os dados do Instagram agora.</p>' +
      (msg ? '<p class="ig-aviso-txt"><span class="ig-cod">' + esc(cortar(msg, 240)) + '</span></p>' : '') +
      '<div class="ig-rodape-aviso">' + htmlBotaoAtualizar('Tentar de novo') + '</div>' +
      '</div>';
    ligarEventos();
  }

  function render() {
    if (!container || !dados) return;
    if (dados.precisaPermissao) renderSemPermissao();
    else renderConectado();
  }

  /* ---------------- eventos ---------------- */

  function ligarImagens(raiz) {
    var imgs = raiz.querySelectorAll('img[data-fallback]');
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        function falhou() {
          var pai = img.parentNode;
          if (!pai) return;
          var tipo = img.getAttribute('data-fallback');
          var d = document.createElement('div');
          if (tipo === 'avatar') {
            d.className = 'ig-avatar-letra';
            d.textContent = img.getAttribute('data-letra') || '@';
          } else {
            d.className = 'ig-sem-img';
            d.textContent = 'prévia indisponível';
          }
          pai.replaceChild(d, img);
        }
        img.addEventListener('error', falhou);
        if (img.complete && img.naturalWidth === 0) falhou();
      })(imgs[i]);
    }
  }

  function ligarOrdem() {
    var botoes = container.querySelectorAll('.ig-ord');
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].addEventListener('click', function () {
        var nova = this.getAttribute('data-ordem');
        if (!nova || nova === ordem) return;
        ordem = nova;
        var todos = container.querySelectorAll('.ig-ord');
        for (var j = 0; j < todos.length; j++) {
          var ativo = todos[j].getAttribute('data-ordem') === ordem;
          if (ativo) todos[j].className = 'ig-ord ig-ord-on';
          else todos[j].className = 'ig-ord';
          todos[j].setAttribute('aria-pressed', ativo ? 'true' : 'false');
        }
        var wrap = container.querySelector('.ig-grade-wrap');
        if (!wrap) return;
        wrap.innerHTML = htmlGrade();
        ligarImagens(wrap);
      });
    }
  }

  function ligarEventos() {
    var i;
    var recarregar = container.querySelectorAll('.ig-btn-atualizar, .ig-btn-verificar');
    for (i = 0; i < recarregar.length; i++) {
      recarregar[i].addEventListener('click', function () {
        if (carregando) return;
        this.disabled = true;
        this.textContent = (this.className.indexOf('ig-btn-verificar') >= 0) ? 'Verificando…' : 'Atualizando…';
        carregar(true);
      });
    }
    ligarOrdem();
    ligarImagens(container);
  }

  /* ---------------- carga ---------------- */

  function carregar(forcar) {
    container = PANEL.el('instagramConteudo');
    if (!container) return;
    injetarCss();
    if (dados && !forcar) {
      render();
      return;
    }
    if (carregando) return;
    carregando = true;
    container.innerHTML = PANEL.skeleton([120, 92, 220, 220]);
    PANEL.api('/api/crm/instagram' + (forcar ? '?forcar=1' : '')).then(function (resp) {
      carregando = false;
      if (!resp || typeof resp !== 'object') {
        dados = null;
        renderErroAmigavel('');
        return;
      }
      dados = normalizar(resp);
      if (!dados.precisaPermissao && !dados.perfil && !dados.posts.length && resp.ok === false) {
        dados = null;
        renderErroAmigavel(mensagemTecnica(resp));
        return;
      }
      render();
    }).catch(function () {
      carregando = false;
      if (dados) {
        render();
        return;
      }
      PANEL.renderErro(container, function () { carregar(true); });
    });
  }

  PANEL.registrar('instagram', { carregar: carregar });
})();
