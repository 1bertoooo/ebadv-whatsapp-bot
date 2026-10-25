/**
 * Pequenos arquivos de estado do bot (pasta `estado/`): grupos da casa ja
 * descobertos, historico de quedas, grupos ja apresentados. Escritos inteiros
 * num temporario e renomeados, com modo 0600 (so o dono do processo le).
 */
import nodeFs from 'node:fs';
import path from 'node:path';

export function lerJson(arquivo, padrao, fs = nodeFs) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return padrao;
  }
}

export function gravarJson(arquivo, valor, fs = nodeFs) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(valor), { mode: 0o600 });
  fs.renameSync(tmp, arquivo);
}

/**
 * Deixa a pasta da sessao (e o que ha dentro) so com o dono. O Baileys grava
 * a sessao com o modo padrao; com a pasta em 0700 ninguem mais entra nela, e
 * os arquivos que ja existiam em 0644 passam a 0600.
 */
export function restringirPermissoes(dir, fs = nodeFs) {
  let ajustados = 0;
  try {
    fs.chmodSync(dir, 0o700);
    ajustados++;
  } catch {
    return ajustados;
  }
  let nomes = [];
  try {
    nomes = fs.readdirSync(dir);
  } catch {
    return ajustados;
  }
  for (const nome of nomes) {
    try {
      fs.chmodSync(path.join(dir, nome), 0o600);
      ajustados++;
    } catch {
      // arquivo que sumiu no meio do caminho
    }
  }
  return ajustados;
}
