/**
 * Versao instalada de um pacote (SEG-M12-015, SEG-M12-003).
 *
 * O heartbeat levava a palavra fixa "baileys" no campo de versao, justamente o
 * dado que o painel precisa para saber se o VPS roda uma versao com a falha
 * conhecida. Aqui a versao e lida do package.json do pacote instalado.
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param nome     nome do pacote
 * @param resolver funcao que devolve o endereco (file://) do ponto de entrada,
 *                 normalmente `(n) => import.meta.resolve(n)`
 */
export function versaoDoPacote(nome, { resolver, fs = nodeFs } = {}) {
  try {
    const entrada = resolver(nome);
    if (typeof entrada !== 'string') return 'desconhecida';
    let dir = path.dirname(fileURLToPath(entrada));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === nome && typeof pkg.version === 'string') return pkg.version;
      } catch {
        // sem package.json nesta pasta: sobe uma
      }
      const acima = path.dirname(dir);
      if (acima === dir) break;
      dir = acima;
    }
  } catch {
    // resolucao nao suportada nesta versao do Node
  }
  return 'desconhecida';
}
