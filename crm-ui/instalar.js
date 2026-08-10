/* Módulo do painel: "instalar no celular".
   Não é uma aba — injeta um botão no cabeçalho que abre um modal com um QR code
   apontando para o painel, mais as instruções de "adicionar à tela inicial".
   O QR é gerado aqui mesmo: codificador QR Modelo 2 completo (modo byte, nível M,
   Reed-Solomon sobre GF(256), máscaras com penalidade, BCH de formato e versão).
   Contrato: IIFE pura, ES5, sem libs externas. Depende de window.PANEL. */
(function () {
  var ENDERECO = 'https://www.nicolastasso.site/painel';

  var cssInjetado = false;
  var iniciado = false;
  var fundo = null;          /* overlay do modal */
  var aberto = false;
  var tmrCopiado = null;
  var overflowAntes = '';

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

  /* ==================================================================== */
  /* PARTE 1 — CODIFICADOR DE QR CODE (Modelo 2, modo byte, nível M)      */
  /* ==================================================================== */

  /* Nível M, versões 1 a 10.
     ec = codewords de correção por bloco.
     b  = grupos [quantidade de blocos, codewords de dados por bloco]. */
  var TABELA_M = [
    null,
    { ec: 10, b: [[1, 16]] },                 /* v1  — 26 codewords no total */
    { ec: 16, b: [[1, 28]] },                 /* v2  — 44 */
    { ec: 26, b: [[1, 44]] },                 /* v3  — 70 */
    { ec: 18, b: [[2, 32]] },                 /* v4  — 100 */
    { ec: 24, b: [[2, 43]] },                 /* v5  — 134 */
    { ec: 16, b: [[4, 27]] },                 /* v6  — 172 */
    { ec: 18, b: [[4, 31]] },                 /* v7  — 196 */
    { ec: 22, b: [[2, 38], [2, 39]] },        /* v8  — 242 */
    { ec: 22, b: [[3, 36], [2, 37]] },        /* v9  — 292 */
    { ec: 26, b: [[4, 43], [1, 44]] }         /* v10 — 346 */
  ];

  /* centros dos padrões de alinhamento por versão */
  var ALINHAMENTO = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  var VERSAO_MAX = 10;

  /* ---- GF(256), polinômio primitivo 0x11D ---- */

  var GF_EXP = null, GF_LOG = null;

  function gfTabelas() {
    if (GF_EXP) return;
    GF_EXP = new Array(512);
    GF_LOG = new Array(256);
    var x = 1, i;
    for (i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = x << 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    GF_LOG[0] = 0;
  }

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    gfTabelas();
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /* polinômio gerador de grau n: (x - a^0)(x - a^1)...(x - a^(n-1)) */
  function gfGerador(grau) {
    gfTabelas();
    var poli = [1], i, j, novo;
    for (i = 0; i < grau; i++) {
      novo = new Array(poli.length + 1);
      for (j = 0; j < novo.length; j++) novo[j] = 0;
      for (j = 0; j < poli.length; j++) {
        novo[j] ^= poli[j];
        novo[j + 1] ^= gfMul(poli[j], GF_EXP[i]);
      }
      poli = novo;
    }
    return poli;
  }

  /* resto da divisão polinomial — são os codewords de correção */
  function rsResto(dados, grau) {
    var gen = gfGerador(grau);
    var resto = new Array(grau), i, j, fator;
    for (i = 0; i < grau; i++) resto[i] = 0;
    for (i = 0; i < dados.length; i++) {
      fator = (dados[i] ^ resto[0]) & 0xFF;
      for (j = 0; j < grau - 1; j++) resto[j] = resto[j + 1];
      resto[grau - 1] = 0;
      if (fator !== 0) {
        for (j = 0; j < grau; j++) resto[j] ^= gfMul(gen[j + 1], fator);
      }
    }
    return resto;
  }

  /* ---- bits de dados ---- */

  function utf8Bytes(s) {
    var out = [], i, c, c2, cp;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6));
        out.push(0x80 | (c & 63));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          cp = ((c - 0xD800) << 10) + (c2 - 0xDC00) + 0x10000;
          out.push(0xF0 | (cp >> 18));
          out.push(0x80 | ((cp >> 12) & 63));
          out.push(0x80 | ((cp >> 6) & 63));
          out.push(0x80 | (cp & 63));
          i++;
        } else {
          out.push(0xEF); out.push(0xBF); out.push(0xBD);
        }
      } else {
        out.push(0xE0 | (c >> 12));
        out.push(0x80 | ((c >> 6) & 63));
        out.push(0x80 | (c & 63));
      }
    }
    return out;
  }

  function capacidadeDados(versao) {
    var info = TABELA_M[versao], n = 0, g;
    for (g = 0; g < info.b.length; g++) n += info.b[g][0] * info.b[g][1];
    return n;
  }

  /* modo byte: contador de 8 bits nas versões 1–9, 16 bits a partir da 10 */
  function bitsContador(versao) { return versao <= 9 ? 8 : 16; }

  function escolherVersao(nbytes) {
    var v, precisa;
    for (v = 1; v <= VERSAO_MAX; v++) {
      precisa = 4 + bitsContador(v) + 8 * nbytes;
      if (precisa <= capacidadeDados(v) * 8) return v;
    }
    throw new Error('texto longo demais para o QR');
  }

  function montarCodewords(bytes, versao) {
    var cap = capacidadeDados(versao);
    var bits = [], i, j, b;

    function push(valor, n) {
      for (var k = n - 1; k >= 0; k--) bits.push((valor >> k) & 1);
    }

    push(4, 4);                                  /* indicador de modo: 0100 */
    push(bytes.length, bitsContador(versao));    /* contador de caracteres */
    for (i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var limite = cap * 8;
    for (i = 0; i < 4 && bits.length < limite; i++) bits.push(0);  /* terminador */
    while (bits.length % 8 !== 0) bits.push(0);                    /* fecha o byte */

    var cw = [];
    for (i = 0; i < bits.length; i += 8) {
      b = 0;
      for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      cw.push(b);
    }
    var alterna = [0xEC, 0x11], k = 0;
    while (cw.length < cap) { cw.push(alterna[k & 1]); k++; }
    return cw;
  }

  function tamanhosBlocos(versao) {
    var info = TABELA_M[versao], lista = [], g, i;
    for (g = 0; g < info.b.length; g++) {
      for (i = 0; i < info.b[g][0]; i++) lista.push(info.b[g][1]);
    }
    return lista;
  }

  /* divide em blocos, calcula a correção de cada um e intercala:
     primeiro os dados (coluna a coluna entre os blocos), depois a correção */
  function intercalar(cw, versao) {
    var info = TABELA_M[versao];
    var tam = tamanhosBlocos(versao);
    var dados = [], ecc = [], pos = 0, i, j, bloco, maxD = 0;

    for (i = 0; i < tam.length; i++) {
      bloco = cw.slice(pos, pos + tam[i]);
      pos += tam[i];
      dados.push(bloco);
      ecc.push(rsResto(bloco, info.ec));
      if (tam[i] > maxD) maxD = tam[i];
    }

    var out = [];
    for (i = 0; i < maxD; i++) {
      for (j = 0; j < dados.length; j++) {
        if (i < dados[j].length) out.push(dados[j][i]);
      }
    }
    for (i = 0; i < info.ec; i++) {
      for (j = 0; j < ecc.length; j++) out.push(ecc[j][i]);
    }
    return out;
  }

  /* ---- matriz ---- */

  function novaMatriz(n, valor) {
    var m = [], i, j, linha;
    for (i = 0; i < n; i++) {
      linha = [];
      for (j = 0; j < n; j++) linha.push(valor);
      m.push(linha);
    }
    return m;
  }

  /* padrões de busca, separadores, tempo, alinhamento, módulo escuro e reservas.
     'fun' marca todo módulo de função (não recebe dados nem máscara). */
  function desenharFuncoes(mod, fun, versao) {
    var n = mod.length, i, j, cx, cy, dx, dy, d, al;

    function set(x, y, escuro) {
      if (x < 0 || y < 0 || x >= n || y >= n) return;
      mod[y][x] = !!escuro;
      fun[y][x] = true;
    }

    /* busca 7x7 + separador de 1 módulo em volta */
    function finder(px, py) {
      var ax, ay, dd;
      for (ay = -4; ay <= 4; ay++) {
        for (ax = -4; ax <= 4; ax++) {
          dd = Math.max(Math.abs(ax), Math.abs(ay));
          set(px + ax, py + ay, dd !== 2 && dd !== 4);
        }
      }
    }

    /* padrões de tempo na linha e na coluna 6 */
    for (i = 0; i < n; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    finder(3, 3);
    finder(n - 4, 3);
    finder(3, n - 4);

    /* alinhamento — pula os três cantos ocupados pelos padrões de busca */
    al = ALINHAMENTO[versao];
    for (i = 0; i < al.length; i++) {
      for (j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) ||
            (i === 0 && j === al.length - 1) ||
            (i === al.length - 1 && j === 0)) continue;
        cx = al[j]; cy = al[i];
        for (dy = -2; dy <= 2; dy++) {
          for (dx = -2; dx <= 2; dx++) {
            set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    /* reserva da informação de formato.
       O índice 6 é pulado: (col 8, lin 6) e (col 6, lin 8) pertencem aos padrões
       de tempo e devem continuar escuros — a informação de formato não passa por ali. */
    for (i = 0; i <= 8; i++) {
      if (i === 6) continue;
      set(8, i, false); set(i, 8, false);
    }
    for (i = 0; i < 8; i++) { set(n - 1 - i, 8, false); set(8, n - 1 - i, false); }

    /* módulo escuro fixo */
    set(8, 4 * versao + 9, true);

    /* reserva da informação de versão */
    if (versao >= 7) {
      for (i = 0; i < 18; i++) {
        set(n - 11 + (i % 3), Math.floor(i / 3), false);
        set(Math.floor(i / 3), n - 11 + (i % 3), false);
      }
    }
  }

  /* informação de formato: 5 bits (nível + máscara) + BCH(15,5), XOR 0x5412 */
  function gravarFormato(mod, fun, mascara) {
    var n = mod.length, i;
    var dados = (0 << 3) | mascara;   /* nível M = 00 */
    var resto = dados;
    for (i = 0; i < 10; i++) resto = (resto << 1) ^ (((resto >>> 9) & 1) * 0x537);
    var bits = ((dados << 10) | resto) ^ 0x5412;

    function bit(idx) { return ((bits >>> idx) & 1) !== 0; }
    function set(x, y, v) { mod[y][x] = v; fun[y][x] = true; }

    /* primeira cópia — canto superior esquerdo */
    for (i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (i = 9; i < 15; i++) set(14 - i, 8, bit(i));

    /* segunda cópia — dividida entre os outros dois cantos */
    for (i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
    for (i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
    set(8, n - 8, true);
  }

  /* informação de versão: 6 bits + BCH(18,6), só a partir da versão 7 */
  function gravarVersao(mod, fun, versao) {
    if (versao < 7) return;
    var n = mod.length, i, v, a, b;
    var resto = versao;
    for (i = 0; i < 12; i++) resto = (resto << 1) ^ (((resto >>> 11) & 1) * 0x1F25);
    var bits = (versao << 12) | resto;
    for (i = 0; i < 18; i++) {
      v = ((bits >>> i) & 1) !== 0;
      a = n - 11 + (i % 3);
      b = Math.floor(i / 3);
      mod[b][a] = v; fun[b][a] = true;
      mod[a][b] = v; fun[a][b] = true;
    }
  }

  /* zigue-zague: pares de colunas da direita para a esquerda, pulando a coluna 6 */
  function colocarDados(mod, fun, cw) {
    var n = mod.length, i = 0, direita, vert, j, x, y, sobe;
    for (direita = n - 1; direita >= 1; direita -= 2) {
      if (direita === 6) direita = 5;
      for (vert = 0; vert < n; vert++) {
        for (j = 0; j < 2; j++) {
          x = direita - j;
          sobe = ((direita + 1) & 2) === 0;
          y = sobe ? n - 1 - vert : vert;
          if (!fun[y][x] && i < cw.length * 8) {
            mod[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  function testeMascara(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
    return false;
  }

  function aplicarMascara(mod, fun, m) {
    var n = mod.length, x, y;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        if (!fun[y][x] && testeMascara(m, x, y)) mod[y][x] = !mod[y][x];
      }
    }
  }

  /* --- penalidades --- */

  /* histórico das últimas 7 sequências, usado para achar o padrão 1:1:3:1:1 */
  function histAdd(n, run, hist) {
    if (hist[0] === 0) run += n;   /* borda clara virtual antes da primeira sequência */
    for (var i = hist.length - 1; i > 0; i--) hist[i] = hist[i - 1];
    hist[0] = run;
  }

  function histConta(hist) {
    var k = hist[1];
    var nucleo = k > 0 && hist[2] === k && hist[3] === k * 3 && hist[4] === k && hist[5] === k;
    return (nucleo && hist[0] >= k * 4 && hist[6] >= k ? 1 : 0) +
           (nucleo && hist[6] >= k * 4 && hist[0] >= k ? 1 : 0);
  }

  function histFim(n, cor, run, hist) {
    if (cor) { histAdd(n, run, hist); run = 0; }
    run += n;                      /* borda clara virtual depois da última sequência */
    histAdd(n, run, hist);
    return histConta(hist);
  }

  function penalidade(mod) {
    var n = mod.length, res = 0, x, y, cor, run, hist, escuros = 0, c, total, k;

    /* N1 (sequências) + N3 (padrão 1:1:3:1:1) — por linha */
    for (y = 0; y < n; y++) {
      cor = false; run = 0; hist = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < n; x++) {
        if (mod[y][x] === cor) {
          run++;
          if (run === 5) res += 3;
          else if (run > 5) res++;
        } else {
          histAdd(n, run, hist);
          if (!cor) res += histConta(hist) * 40;
          cor = mod[y][x];
          run = 1;
        }
      }
      res += histFim(n, cor, run, hist) * 40;
    }

    /* o mesmo por coluna */
    for (x = 0; x < n; x++) {
      cor = false; run = 0; hist = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < n; y++) {
        if (mod[y][x] === cor) {
          run++;
          if (run === 5) res += 3;
          else if (run > 5) res++;
        } else {
          histAdd(n, run, hist);
          if (!cor) res += histConta(hist) * 40;
          cor = mod[y][x];
          run = 1;
        }
      }
      res += histFim(n, cor, run, hist) * 40;
    }

    /* N2 — blocos 2x2 da mesma cor */
    for (y = 0; y < n - 1; y++) {
      for (x = 0; x < n - 1; x++) {
        c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) res += 3;
      }
    }

    /* N4 — desequilíbrio entre claros e escuros, a cada 5% de desvio */
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (mod[y][x]) escuros++;
    total = n * n;
    k = Math.floor((Math.abs(escuros * 20 - total * 10) + total - 1) / total) - 1;
    res += k * 10;

    return res;
  }

  function copiarMatriz(m) {
    var out = [], i;
    for (i = 0; i < m.length; i++) out.push(m[i].slice(0));
    return out;
  }

  /* devolve uma matriz de booleanos — true = módulo escuro */
  function qrMatriz(texto) {
    var bytes = utf8Bytes(texto);
    var versao = escolherVersao(bytes.length);
    var cw = intercalar(montarCodewords(bytes, versao), versao);
    var n = versao * 4 + 17;
    var mod = novaMatriz(n, false);
    var fun = novaMatriz(n, false);

    desenharFuncoes(mod, fun, versao);
    gravarVersao(mod, fun, versao);
    gravarFormato(mod, fun, 0);
    colocarDados(mod, fun, cw);

    var melhor = null, melhorNota = -1, m, tent, nota;
    for (m = 0; m < 8; m++) {
      tent = copiarMatriz(mod);
      aplicarMascara(tent, fun, m);
      gravarFormato(tent, fun, m);
      nota = penalidade(tent);
      if (melhorNota < 0 || nota < melhorNota) { melhorNota = nota; melhor = tent; }
    }
    return melhor;
  }

  /* ==================================================================== */
  /* PARTE 2 — DESENHO                                                    */
  /* ==================================================================== */

  function qrSvg(matriz, tamanhoPx) {
    var n = matriz.length, margem = 4, lado = n + margem * 2;
    var d = '', x, y;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        if (matriz[y][x]) d += 'M' + (x + margem) + ' ' + (y + margem) + 'h1v1h-1z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + tamanhoPx + '" height="' + tamanhoPx + '" ' +
      'viewBox="0 0 ' + lado + ' ' + lado + '" shape-rendering="crispEdges" role="img" ' +
      'aria-label="QR code do endereço do painel">' +
      '<rect width="' + lado + '" height="' + lado + '" fill="#FFFFFF"/>' +
      '<path d="' + d + '" fill="#060B1F"/>' +
      '</svg>';
  }

  /* ==================================================================== */
  /* PARTE 3 — INTERFACE                                                  */
  /* ==================================================================== */

  function injetarCss() {
    if (cssInjetado) return;
    cssInjetado = true;
    var style = document.createElement('style');
    style.setAttribute('data-mod', 'instalar');
    style.textContent =
      /* botão no cabeçalho */
      '.in-btn{display:inline-flex;align-items:center;justify-content:center;width:38px;height:34px;padding:0;flex:0 0 auto;cursor:pointer;background:var(--card2,#131E45);border:1px solid var(--borda,#1E2B5A);border-radius:10px;color:var(--texto2,#9AAAD0);transition:border-color .18s ease,color .18s ease,box-shadow .18s ease}' +
      '.in-btn:hover,.in-btn:focus-visible{border-color:var(--azul,#2E6BFF);color:var(--branco,#FFF);box-shadow:0 0 14px rgba(46,107,255,.20)}' +
      '.in-btn svg{width:17px;height:17px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
      /* fundo escurecido */
      '.in-fundo{position:fixed;top:0;right:0;bottom:0;left:0;z-index:220;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(3,6,20,.72);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);overflow-y:auto}' +
      '.in-fundo[hidden]{display:none}' +
      /* cartão */
      '.in-modal{position:relative;width:100%;max-width:420px;padding:22px 20px 16px;background:var(--card,#0E1738);border:1px solid var(--borda,#1E2B5A);border-radius:18px;box-shadow:var(--sombra,0 10px 30px rgba(0,0,0,.45));color:var(--texto,#F1F5FF);overflow:hidden;animation:in-entra .18s ease-out}' +
      '.in-modal::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--grad,linear-gradient(135deg,#2E6BFF 0%,#7C3AED 45%,#E11D3C 100%))}' +
      '@keyframes in-entra{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}' +
      '@media (prefers-reduced-motion:reduce){.in-modal{animation:none}}' +
      '.in-x{position:absolute;top:13px;right:13px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;font-size:17px;line-height:1;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:9px;color:var(--texto2,#9AAAD0);transition:border-color .18s ease,color .18s ease}' +
      '.in-x:hover{border-color:var(--azul,#2E6BFF);color:var(--branco,#FFF)}' +
      '.in-titulo{font-size:17px;font-weight:800;letter-spacing:.01em;padding-right:36px}' +
      '.in-sub{margin-top:4px;font-size:12.5px;line-height:1.45;color:var(--texto2,#9AAAD0)}' +
      /* quadro do QR */
      '.in-qr{margin:15px auto 0;width:-webkit-fit-content;width:fit-content;padding:12px;background:var(--branco,#FFF);border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,.35);line-height:0}' +
      '.in-qr svg{display:block;width:240px;height:240px;max-width:100%}' +
      /* endereço + copiar */
      '.in-link{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:13px}' +
      '.in-url{font-size:11.5px;color:var(--texto2,#9AAAD0);word-break:break-all;-webkit-user-select:all;user-select:all;min-width:0}' +
      '.in-copiar{flex:0 0 auto;cursor:pointer;padding:6px 12px;font-size:12px;font-weight:700;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:999px;color:var(--texto,#F1F5FF);transition:border-color .18s ease,color .18s ease,box-shadow .18s ease}' +
      '.in-copiar:hover{border-color:var(--azul,#2E6BFF);box-shadow:0 0 14px rgba(46,107,255,.20)}' +
      '.in-copiar.in-ok{border-color:rgba(34,197,94,.55);color:var(--verde,#22C55E);box-shadow:0 0 14px rgba(34,197,94,.18)}' +
      /* instruções */
      '.in-guias{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}' +
      '.in-guia{background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:12px;padding:11px 12px;min-width:0}' +
      '.in-guia-t{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--texto2,#9AAAD0);margin-bottom:6px}' +
      '.in-guia ol{margin:0;padding-left:16px}' +
      '.in-guia li{font-size:12px;line-height:1.5;color:var(--texto,#F1F5FF);word-wrap:break-word;overflow-wrap:break-word}' +
      /* rodapé e erro */
      '.in-aviso{margin-top:14px;padding-top:11px;border-top:1px solid var(--borda,#1E2B5A);font-size:11.5px;line-height:1.45;color:var(--cinza,#5C6B95);text-align:center}' +
      '.in-falha{margin:15px 0 0;padding:14px;text-align:center;background:var(--bg2,#0A1230);border:1px solid var(--borda,#1E2B5A);border-radius:12px}' +
      '.in-falha-nota{font-size:12px;color:var(--texto2,#9AAAD0);margin-bottom:9px}' +
      '.in-falha a{display:inline-block;font-size:15px;font-weight:700;color:var(--azul-claro,#6098FF);text-decoration:none;word-break:break-all}' +
      '.in-falha a:hover{text-decoration:underline;color:var(--branco,#FFF)}' +
      /* no celular o próprio navegador instala pelo menu */
      '@media (max-width:640px){.in-btn{display:none}.in-guias{grid-template-columns:1fr}.in-qr svg{width:200px;height:200px}}';
    document.head.appendChild(style);
  }

  function iconeCelular() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/>' +
      '<path d="M10.5 18.6h3"/>' +
      '</svg>';
  }

  function htmlQr() {
    try {
      return '<div class="in-qr">' + qrSvg(qrMatriz(ENDERECO), 240) + '</div>';
    } catch (e) {
      return '<div class="in-falha">' +
        '<div class="in-falha-nota">Não foi possível gerar o QR code aqui. Digite o endereço no navegador do celular:</div>' +
        '<a href="' + esc(ENDERECO) + '" target="_blank" rel="noopener">' + esc(ENDERECO) + '</a>' +
        '</div>';
    }
  }

  function htmlModal() {
    return '<div class="in-modal" role="dialog" aria-modal="true" aria-label="Instalar no celular">' +
      '<button type="button" class="in-x" aria-label="Fechar">&times;</button>' +
      '<div class="in-titulo">Instalar no celular</div>' +
      '<div class="in-sub">Aponte a câmera do celular para o QR code e adicione o painel à tela inicial.</div>' +
      htmlQr() +
      '<div class="in-link">' +
        '<span class="in-url">' + esc(ENDERECO) + '</span>' +
        '<button type="button" class="in-copiar">Copiar link</button>' +
      '</div>' +
      '<div class="in-guias">' +
        '<div class="in-guia">' +
          '<div class="in-guia-t">Android (Chrome)</div>' +
          '<ol><li>Escaneie o QR</li><li>Toque no menu ⋮</li><li>&ldquo;Adicionar à tela inicial&rdquo;</li></ol>' +
        '</div>' +
        '<div class="in-guia">' +
          '<div class="in-guia-t">iPhone (Safari)</div>' +
          '<ol><li>Escaneie o QR</li><li>Toque no botão Compartilhar</li><li>&ldquo;Adicionar à Tela de Início&rdquo;</li></ol>' +
        '</div>' +
      '</div>' +
      '<div class="in-aviso">Você vai precisar da chave de acesso no celular na primeira vez.</div>' +
      '</div>';
  }

  function marcarCopiado(botao) {
    botao.textContent = 'Copiado!';
    botao.className = 'in-copiar in-ok';
    if (tmrCopiado) clearTimeout(tmrCopiado);
    tmrCopiado = setTimeout(function () {
      tmrCopiado = null;
      botao.textContent = 'Copiar link';
      botao.className = 'in-copiar';
    }, 2000);
  }

  function copiarAntigo(texto) {
    var area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    var ok = false;
    try {
      area.select();
      area.setSelectionRange(0, texto.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    try { document.body.removeChild(area); } catch (e2) {}
    return ok;
  }

  function copiarLink(botao) {
    var pronto = function () { marcarCopiado(botao); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ENDERECO).then(pronto, function () {
          if (copiarAntigo(ENDERECO)) pronto();
        });
        return;
      }
    } catch (e) {}
    if (copiarAntigo(ENDERECO)) pronto();
  }

  function aoTeclar(ev) {
    if (aberto && (ev.keyCode === 27 || ev.key === 'Escape')) fechar();
  }

  function abrir() {
    injetarCss();
    if (!fundo) {
      fundo = document.createElement('div');
      fundo.className = 'in-fundo';
      fundo.setAttribute('hidden', 'hidden');
      document.body.appendChild(fundo);
      fundo.addEventListener('click', function (ev) {
        if (ev.target === fundo) fechar();   /* clique fora do cartão */
      });
      document.addEventListener('keydown', aoTeclar);
    }
    fundo.innerHTML = htmlModal();
    fundo.removeAttribute('hidden');
    aberto = true;

    try {
      overflowAntes = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    } catch (e) {}

    var x = fundo.querySelector('.in-x');
    if (x) {
      x.addEventListener('click', fechar);
      try { x.focus(); } catch (e2) {}
    }
    var cop = fundo.querySelector('.in-copiar');
    if (cop) {
      cop.addEventListener('click', function () { copiarLink(this); });
    }
  }

  function fechar() {
    if (!fundo || !aberto) return;
    aberto = false;
    if (tmrCopiado) { clearTimeout(tmrCopiado); tmrCopiado = null; }
    fundo.setAttribute('hidden', 'hidden');
    fundo.innerHTML = '';
    try { document.body.style.overflow = overflowAntes; } catch (e) {}
  }

  function montarBotao() {
    try {
      var acoes = document.querySelector('.h-acoes');
      if (!acoes) return false;
      if (acoes.querySelector('.in-btn')) return false;

      var botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'in-btn';
      botao.title = 'Instalar no celular';
      botao.setAttribute('aria-label', 'Instalar no celular');
      botao.innerHTML = iconeCelular();
      botao.addEventListener('click', function () {
        try { abrir(); } catch (e) {}
      });

      if (acoes.firstChild) acoes.insertBefore(botao, acoes.firstChild);
      else acoes.appendChild(botao);
      return true;
    } catch (e) {
      return false;
    }
  }

  function iniciar() {
    if (iniciado) return;
    injetarCss();            /* antes de montar, para o botão nunca aparecer sem estilo */
    if (!montarBotao()) return;
    iniciado = true;
  }

  /* ---------- auto-início (não é uma aba: não registra no PANEL) ---------- */

  try {
    if (window.PANEL) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          try { iniciar(); } catch (e) {}
        });
      } else {
        iniciar();
      }
    }
  } catch (e) {}
})();
