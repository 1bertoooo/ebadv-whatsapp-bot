/**
 * Ritmos e caches pequenos (SEG-M12-014, SEG-M12-016).
 */

/**
 * Ritmo de envio da fila de saida: intervalo aleatorio entre mensagens e teto
 * por minuto e por hora. O numero e um so para todos os escritorios, e um
 * bloqueio dele derruba a captura de todos, entao lembrete em enxurrada nao
 * sai de uma vez. Resposta a quem acabou de escrever NAO passa por aqui.
 */
export class LimitadorDeEnvio {
  constructor({ porMinuto = 10, porHora = 100, intervaloMinMs = 2000, intervaloMaxMs = 5000, aleatorio = Math.random } = {}) {
    this.porMinuto = porMinuto;
    this.porHora = porHora;
    this.intervaloMinMs = intervaloMinMs;
    this.intervaloMaxMs = intervaloMaxMs;
    this.aleatorio = aleatorio;
    this.envios = [];
    this.liberadoEm = 0;
  }

  /** Quantos ms faltam para poder enviar (0 quando ja pode). */
  espera(agora) {
    this.envios = this.envios.filter((t) => agora - t < 3600_000);
    let ate = this.liberadoEm;
    if (this.envios.length >= this.porHora) {
      ate = Math.max(ate, this.envios[this.envios.length - this.porHora] + 3600_000);
    }
    const naUltimaMinuto = this.envios.filter((t) => agora - t < 60_000);
    if (naUltimaMinuto.length >= this.porMinuto) {
      ate = Math.max(ate, naUltimaMinuto[naUltimaMinuto.length - this.porMinuto] + 60_000);
    }
    return Math.max(0, ate - agora);
  }

  registrar(agora) {
    this.envios.push(agora);
    const sorteio = this.intervaloMinMs + this.aleatorio() * (this.intervaloMaxMs - this.intervaloMinMs);
    this.liberadoEm = agora + Math.round(sorteio);
  }
}

/**
 * Mapa com validade e teto. Serve para o `getMessage` do Baileys (as
 * mensagens que o bot enviou, para poder reenviar quando alguem nao decifra)
 * e para o cache de metadados de grupo (`cachedGroupMetadata`).
 */
export class ArmazemCurto {
  constructor({ max = 200, validadeMs = 3600_000, agora = () => Date.now() } = {}) {
    this.max = max;
    this.validadeMs = validadeMs;
    this.agora = agora;
    this.mapa = new Map();
  }

  set(chave, valor) {
    this.mapa.delete(chave);
    this.mapa.set(chave, { valor, em: this.agora() });
    while (this.mapa.size > this.max) {
      const primeira = this.mapa.keys().next().value;
      this.mapa.delete(primeira);
    }
  }

  get(chave) {
    const e = this.mapa.get(chave);
    if (!e) return undefined;
    if (this.agora() - e.em > this.validadeMs) {
      this.mapa.delete(chave);
      return undefined;
    }
    return e.valor;
  }

  delete(chave) {
    return this.mapa.delete(chave);
  }

  get tamanho() {
    return this.mapa.size;
  }
}

/**
 * Intervalo da proxima volta da fila de pedidos. Rapido por um tempo depois
 * de aparecer pedido (alguem esta esperando a tela de cadastro), e no ritmo
 * lento o resto do tempo. Antes era uma volta a cada 3 s, dia e noite: perto
 * de um milhao de chamadas por mes para ouvir "nada".
 */
export function proximoIntervaloDePedidos({ agora, rapidoAte = 0, baseMs, rapidoMs }) {
  return agora < rapidoAte ? rapidoMs : baseMs;
}

export function estenderModoRapido({ agora, rapidoAte = 0, duracaoMs }) {
  return Math.max(rapidoAte, agora + duracaoMs);
}

/** AAAA-MM-DD no fuso de Sao Paulo (a contagem "de hoje" zerava as 21h de Brasilia). */
export function diaEmSaoPaulo(data = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(data);
}
