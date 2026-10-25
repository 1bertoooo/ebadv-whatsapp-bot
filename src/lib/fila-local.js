/**
 * Fila local em disco (SEG-M12-006).
 *
 * Por que existe: o WhatsApp entrega a mensagem uma vez so e o app responde
 * quando quer. Se o app cair, demorar ou o processo reiniciar (o bot sai a
 * cada queda de conexao, de proposito), a mensagem recebida nao pode ficar
 * so na memoria. Cada item e um arquivo JSON: escrito inteiro num arquivo
 * temporario e renomeado, entao nunca fica meio escrito.
 *
 * Dado pessoal: o corpo da mensagem vai para o disco enquanto o app nao
 * confirma. Por isso a fila tem validade (o item vencido e apagado), teto de
 * itens e de bytes (o mais antigo sai primeiro), pasta 0700 e arquivos 0600,
 * e o item some no instante em que o app confirma.
 */
import nodeFs from 'node:fs';
import path from 'node:path';

const EXTENSAO = '.json';

function nomeSeguro(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'sem-id';
}

export class FilaEmDisco {
  constructor({ dir, maxItens = 500, maxBytes = 64 * 1024 * 1024, validadeMs = 24 * 3600_000, agora = () => Date.now(), fs = nodeFs } = {}) {
    if (!dir) throw new Error('FilaEmDisco precisa de dir');
    this.dir = dir;
    this.maxItens = maxItens;
    this.maxBytes = maxBytes;
    this.validadeMs = validadeMs;
    this.agora = agora;
    this.fs = fs;
    this.indice = new Map(); // id -> { arquivo, criadoEm, seq, tentativas, proximaEm, bytes }
    this.bytes = 0;
    this.seq = 0;
  }

  /** Cria a pasta e carrega o que ficou de antes do ultimo reinicio. */
  iniciar() {
    this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.fs.chmodSync(this.dir, 0o700);
    } catch {
      // sem permissao para mudar o modo: segue com o que ha
    }
    let corrompidos = 0;
    const lidos = [];
    for (const nome of this.fs.readdirSync(this.dir)) {
      const arquivo = path.join(this.dir, nome);
      if (nome.endsWith('.tmp')) {
        this.apagarArquivo(arquivo);
        continue;
      }
      if (!nome.endsWith(EXTENSAO)) continue;
      try {
        const texto = this.fs.readFileSync(arquivo, 'utf8');
        const item = JSON.parse(texto);
        if (!item || typeof item.id !== 'string') throw new Error('sem id');
        lidos.push({ nome, arquivo, item, bytes: Buffer.byteLength(texto) });
      } catch {
        corrompidos++;
        this.apagarArquivo(arquivo);
      }
    }
    lidos.sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
    for (const l of lidos) {
      this.seq += 1;
      this.indice.set(l.item.id, {
        arquivo: l.arquivo,
        criadoEm: l.item.criadoEm,
        seq: this.seq,
        tentativas: l.item.tentativas || 0,
        proximaEm: l.item.proximaEm || 0,
        bytes: l.bytes,
      });
      this.bytes += l.bytes;
    }
    return { itens: this.indice.size, corrompidos };
  }

  apagarArquivo(arquivo) {
    try {
      this.fs.unlinkSync(arquivo);
    } catch {
      // ja nao existe
    }
  }

  gravar(arquivo, item) {
    const texto = JSON.stringify(item);
    const tmp = `${arquivo}.tmp`;
    this.fs.writeFileSync(tmp, texto, { mode: 0o600 });
    this.fs.renameSync(tmp, arquivo);
    return Buffer.byteLength(texto);
  }

  /**
   * Poe um item na fila. Devolve { adicionado, duplicado, grandeDemais,
   * descartados }: `descartados` sao os ids que sairam para dar lugar (teto).
   */
  adicionar(id, dados) {
    if (this.indice.has(id)) return { adicionado: false, duplicado: true, descartados: [] };
    const criadoEm = this.agora();
    const item = { id, criadoEm, tentativas: 0, proximaEm: 0, dados };
    const tamanhoEstimado = Buffer.byteLength(JSON.stringify(item));
    if (tamanhoEstimado > this.maxBytes) {
      return { adicionado: false, duplicado: false, grandeDemais: true, descartados: [] };
    }

    const descartados = [];
    while (this.indice.size > 0 && (this.indice.size >= this.maxItens || this.bytes + tamanhoEstimado > this.maxBytes)) {
      const maisAntigo = this.maisAntigo();
      this.remover(maisAntigo);
      descartados.push(maisAntigo);
    }

    this.seq += 1;
    const nome = `${String(criadoEm).padStart(14, '0')}-${String(this.seq).padStart(6, '0')}-${nomeSeguro(id)}${EXTENSAO}`;
    const arquivo = path.join(this.dir, nome);
    const bytes = this.gravar(arquivo, item);
    this.indice.set(id, { arquivo, criadoEm, seq: this.seq, tentativas: 0, proximaEm: 0, bytes });
    this.bytes += bytes;
    return { adicionado: true, duplicado: false, descartados };
  }

  maisAntigo() {
    let escolhido = null;
    let menor = null;
    for (const [id, meta] of this.indice) {
      if (menor === null || meta.seq < menor) {
        menor = meta.seq;
        escolhido = id;
      }
    }
    return escolhido;
  }

  tem(id) {
    return this.indice.has(id);
  }

  /** O item completo (com os dados) lido do disco, ou null. */
  obter(id) {
    const meta = this.indice.get(id);
    if (!meta) return null;
    try {
      return JSON.parse(this.fs.readFileSync(meta.arquivo, 'utf8'));
    } catch {
      this.remover(id);
      return null;
    }
  }

  /** Troca os dados do item (por exemplo, para guardar que o envio ja foi feito). */
  atualizarDados(id, dados) {
    const item = this.obter(id);
    if (!item) return false;
    item.dados = dados;
    this.regravar(id, item);
    return true;
  }

  /** Conta uma falha e marca quando o item volta a ser tentado. */
  registrarFalha(id, esperaMs) {
    const item = this.obter(id);
    if (!item) return null;
    item.tentativas = (item.tentativas || 0) + 1;
    item.proximaEm = this.agora() + esperaMs;
    this.regravar(id, item);
    return { tentativas: item.tentativas, proximaEm: item.proximaEm };
  }

  regravar(id, item) {
    const meta = this.indice.get(id);
    if (!meta) return;
    const bytes = this.gravar(meta.arquivo, item);
    this.bytes += bytes - meta.bytes;
    meta.bytes = bytes;
    meta.tentativas = item.tentativas || 0;
    meta.proximaEm = item.proximaEm || 0;
  }

  tentativas(id) {
    return this.indice.get(id)?.tentativas ?? 0;
  }

  /** Ids prontos para tentar agora, do mais antigo para o mais novo. */
  prontos(agoraMs = this.agora(), limite = Infinity) {
    return [...this.indice.entries()]
      .filter(([, m]) => m.proximaEm <= agoraMs)
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, limite)
      .map(([id]) => id);
  }

  remover(id) {
    const meta = this.indice.get(id);
    if (!meta) return false;
    this.apagarArquivo(meta.arquivo);
    this.bytes -= meta.bytes;
    this.indice.delete(id);
    return true;
  }

  /** Apaga o que passou da validade e devolve os ids. */
  expirar(agoraMs = this.agora()) {
    const vencidos = [];
    for (const [id, meta] of this.indice) {
      if (agoraMs - meta.criadoEm > this.validadeMs) vencidos.push(id);
    }
    for (const id of vencidos) this.remover(id);
    return vencidos;
  }

  resumo() {
    return { itens: this.indice.size, bytes: this.bytes };
  }
}
