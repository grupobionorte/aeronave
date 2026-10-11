// Servidor sem dependências externas: Node >= 22.5 (node:sqlite embutido).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'aeronave.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL, salt TEXT NOT NULL, cota_pct REAL NOT NULL DEFAULT 50
);
CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expira INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS aeronave (
  id INTEGER PRIMARY KEY CHECK (id = 1), matricula TEXT, modelo TEXT, horas_iniciais REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS voos (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES usuarios(id),
  origem TEXT, destino TEXT, hobbs_ini REAL NOT NULL, hobbs_fim REAL NOT NULL, horas REAL NOT NULL,
  pousos INTEGER NOT NULL DEFAULT 1, combustivel_litros REAL, obs TEXT,
  criado_por INTEGER, criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS despesas (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, categoria TEXT NOT NULL, descricao TEXT,
  valor REAL NOT NULL, pago_por INTEGER NOT NULL REFERENCES usuarios(id),
  rateio TEXT NOT NULL DEFAULT 'horas', criado_por INTEGER, criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reservas (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id),
  inicio TEXT NOT NULL, fim TEXT NOT NULL, obs TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS manutencao_itens (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, intervalo_horas REAL, intervalo_meses INTEGER,
  ultima_horas REAL, ultima_data TEXT, alerta_horas REAL NOT NULL DEFAULT 10,
  alerta_dias INTEGER NOT NULL DEFAULT 30, obs TEXT
);
CREATE TABLE IF NOT EXISTS manutencao_eventos (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES manutencao_itens(id) ON DELETE CASCADE,
  data TEXT NOT NULL, horas REAL, custo REAL, oficina TEXT, descricao TEXT
);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ---------- utilidades ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const str = (v, max = 200) => (v == null || v === '' ? null : String(v).trim().slice(0, max));
const num = (v, nome, { req = false, min = 0 } = {}) => {
  if (v == null || v === '') { if (req) throw bad(`${nome} é obrigatório`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw bad(`${nome} inválido`);
  return n;
};
const data = (v, nome) => { if (!RE_DATA.test(v || '') || isNaN(Date.parse(v))) throw bad(`${nome} inválida`); return v; };
const dtime = (v, nome) => { if (!RE_DT.test(v || '') || isNaN(Date.parse(v))) throw bad(`${nome} inválida`); return v; };
const hoje = () => new Date().toISOString().slice(0, 10);
const agoraLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const addMeses = (d, n) => {
  const dt = new Date(d + 'T00:00:00Z');
  const dia = dt.getUTCDate();
  dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() + n);
  const ult = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(dia, ult));
  return dt.toISOString().slice(0, 10);
};
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const r2 = (n) => Math.round(n * 100) / 100;

function hashSenha(senha, salt) { return crypto.scryptSync(senha, salt, 64).toString('hex'); }
function checkSenha(senha, u) {
  const a = Buffer.from(hashSenha(senha, u.salt), 'hex'), b = Buffer.from(u.senha_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function criarUsuario({ nome, email, senha, cota_pct }) {
  nome = str(nome, 80); email = str(email, 120)?.toLowerCase();
  if (!nome || !email || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Nome e e-mail válidos são obrigatórios');
  if (!senha || String(senha).length < 8) throw bad('A senha precisa ter ao menos 8 caracteres');
  if (get('SELECT 1 FROM usuarios WHERE email = ?', email)) throw bad('E-mail já cadastrado');
  const salt = crypto.randomBytes(16).toString('hex');
  const cota = num(cota_pct ?? 50, 'Cota', { min: 0 });
  if (cota > 100) throw bad('Cota inválida');
  return Number(run('INSERT INTO usuarios (nome,email,senha_hash,salt,cota_pct) VALUES (?,?,?,?,?)',
    nome, email, hashSenha(String(senha), salt), salt, cota).lastInsertRowid);
}

const tentativas = new Map(); // limitador simples de login por IP
function limitaLogin(ip) {
  const agora = Date.now();
  const t = (tentativas.get(ip) || []).filter((x) => agora - x < 15 * 60000);
  if (t.length >= 10) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  t.push(agora); tentativas.set(ip, t);
}

// ---------- CRUD genérico ----------
function conflitoReserva(b, ignoreId = 0) {
  return get('SELECT r.*, u.nome FROM reservas r JOIN usuarios u ON u.id = r.user_id WHERE r.id != ? AND r.inicio < ? AND r.fim > ?',
    ignoreId, b.fim, b.inicio);
}
const checkUser = (id, nome) => { if (!get('SELECT 1 FROM usuarios WHERE id = ?', id)) throw bad(`${nome} inválido`); return id; };

const tabelas = {
  voos: {
    order: 'data DESC, hobbs_fim DESC',
    campos: (b, u) => {
      const ini = num(b.hobbs_ini, 'Horímetro inicial', { req: true });
      const fim = num(b.hobbs_fim, 'Horímetro final', { req: true });
      if (fim <= ini) throw bad('Horímetro final deve ser maior que o inicial');
      if (fim - ini > 24) throw bad('Voo com mais de 24h: confira os horímetros');
      return {
        data: data(b.data, 'Data'), user_id: checkUser(Number(b.user_id), 'Piloto'),
        origem: str(b.origem, 10)?.toUpperCase() ?? null, destino: str(b.destino, 10)?.toUpperCase() ?? null,
        hobbs_ini: ini, hobbs_fim: fim, horas: r2(fim - ini),
        pousos: num(b.pousos ?? 1, 'Pousos', { req: true }), combustivel_litros: num(b.combustivel_litros, 'Combustível'),
        obs: str(b.obs, 500), criado_por: u.id,
      };
    },
  },
  despesas: {
    order: 'data DESC, id DESC',
    campos: (b, u) => {
      if (!['horas', 'cota', 'igual'].includes(b.rateio)) throw bad('Critério de rateio inválido');
      const valor = num(b.valor, 'Valor', { req: true });
      if (valor <= 0) throw bad('Valor deve ser maior que zero');
      const categoria = str(b.categoria, 40);
      if (!categoria) throw bad('Categoria é obrigatória');
      return {
        data: data(b.data, 'Data'), categoria, descricao: str(b.descricao, 300), valor,
        pago_por: checkUser(Number(b.pago_por), 'Pagador'), rateio: b.rateio, criado_por: u.id,
      };
    },
  },
  reservas: {
    order: 'inicio DESC',
    campos: (b) => {
      const campos = { user_id: checkUser(Number(b.user_id), 'Sócio'), inicio: dtime(b.inicio, 'Início'), fim: dtime(b.fim, 'Fim'), obs: str(b.obs, 300) };
      if (campos.fim <= campos.inicio) throw bad('O fim deve ser depois do início');
      return campos;
    },
    validar: (c, id) => {
      const x = conflitoReserva(c, id);
      if (x) throw new HttpError(409, `Conflito com reserva de ${x.nome} (${x.inicio.replace('T', ' ')} a ${x.fim.replace('T', ' ')})`);
    },
  },
  manutencao: {
    tabela: 'manutencao_itens', order: 'nome',
    campos: (b) => {
      const ih = num(b.intervalo_horas, 'Intervalo (horas)'), im = num(b.intervalo_meses, 'Intervalo (meses)');
      if (!ih && !im) throw bad('Informe intervalo em horas e/ou meses');
      const uh = num(b.ultima_horas, 'Horímetro da última execução'), ud = b.ultima_data ? data(b.ultima_data, 'Data da última execução') : null;
      if (ih && uh == null) throw bad('Informe o horímetro da última execução');
      if (im && !ud) throw bad('Informe a data da última execução');
      const nome = str(b.nome, 80);
      if (!nome) throw bad('Nome é obrigatório');
      return {
        nome, intervalo_horas: ih || null, intervalo_meses: im ? Math.round(im) : null, ultima_horas: uh, ultima_data: ud,
        alerta_horas: num(b.alerta_horas ?? 10, 'Alerta (horas)'), alerta_dias: Math.round(num(b.alerta_dias ?? 30, 'Alerta (dias)')),
        obs: str(b.obs, 500),
      };
    },
  },
};

function crud(nome, metodo, id, body, user) {
  const t = tabelas[nome], tb = t.tabela || nome;
  if (metodo === 'GET' && !id) return all(`SELECT * FROM ${tb} ORDER BY ${t.order}`);
  if (metodo === 'DELETE') {
    if (!get(`SELECT 1 FROM ${tb} WHERE id = ?`, id)) throw new HttpError(404, 'Não encontrado');
    run(`DELETE FROM ${tb} WHERE id = ?`, id); return { ok: true };
  }
  if (metodo === 'POST' || metodo === 'PUT') {
    const c = t.campos(body, user);
    if (metodo === 'PUT' && !get(`SELECT 1 FROM ${tb} WHERE id = ?`, id)) throw new HttpError(404, 'Não encontrado');
    t.validar?.(c, id || 0);
    const cols = Object.keys(c);
    if (metodo === 'POST') {
      const r = run(`INSERT INTO ${tb} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(c));
      return { id: Number(r.lastInsertRowid) };
    }
    delete c.criado_por;
    const cs = Object.keys(c);
    run(`UPDATE ${tb} SET ${cs.map((k) => k + ' = ?').join(',')} WHERE id = ?`, ...Object.values(c), id);
    return { id };
  }
  throw new HttpError(405, 'Método não permitido');
}

// ---------- regras de negócio ----------
const horasTotais = () => {
  const a = get('SELECT horas_iniciais FROM aeronave WHERE id = 1');
  const m = get('SELECT MAX(hobbs_fim) AS m FROM voos').m;
  return Math.max(a?.horas_iniciais || 0, m || 0);
};

function statusItem(it, horas) {
  let restH = null, restD = null, venc = [];
  if (it.intervalo_horas) { restH = r2(it.ultima_horas + it.intervalo_horas - horas); venc.push({ restante: restH, alerta: it.alerta_horas }); }
  if (it.intervalo_meses) {
    const prox = addMeses(it.ultima_data, it.intervalo_meses);
    restD = diasEntre(hoje(), prox); it.proxima_data = prox;
    venc.push({ restante: restD, alerta: it.alerta_dias });
  }
  let status = 'ok';
  if (venc.some((v) => v.restante < 0)) status = 'vencido';
  else if (venc.some((v) => v.restante <= v.alerta)) status = 'atencao';
  if (it.intervalo_horas) it.proxima_horas = r2(it.ultima_horas + it.intervalo_horas);
  return { ...it, restante_horas: restH, restante_dias: restD, status };
}
const itensComStatus = () => {
  const h = horasTotais();
  const ordem = { vencido: 0, atencao: 1, ok: 2 };
  return all('SELECT * FROM manutencao_itens').map((i) => statusItem(i, h)).sort((a, b) => ordem[a.status] - ordem[b.status] || a.nome.localeCompare(b.nome));
};

function rateio(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw bad('Mês inválido');
  const us = all('SELECT id, nome, cota_pct FROM usuarios ORDER BY id');
  const horas = Object.fromEntries(us.map((u) => [u.id, 0]));
  for (const v of all("SELECT user_id, SUM(horas) h FROM voos WHERE substr(data,1,7) = ? GROUP BY user_id", mes)) horas[v.user_id] = v.h;
  const totH = Object.values(horas).reduce((a, b) => a + b, 0);
  const totCota = us.reduce((a, u) => a + u.cota_pct, 0) || 1;
  const res = Object.fromEntries(us.map((u) => [u.id, { id: u.id, nome: u.nome, horas: r2(horas[u.id]), pago: 0, devido: 0 }]));
  const desp = all("SELECT * FROM despesas WHERE substr(data,1,7) = ?", mes);
  for (const d of desp) {
    res[d.pago_por].pago += d.valor;
    let modo = d.rateio;
    if (modo === 'horas' && totH === 0) modo = 'cota'; // sem voos no mês, cai para a cota
    for (const u of us) {
      const frac = modo === 'horas' ? horas[u.id] / totH : modo === 'cota' ? u.cota_pct / totCota : 1 / us.length;
      res[u.id].devido += d.valor * frac;
    }
  }
  const socios = Object.values(res).map((s) => ({ ...s, pago: r2(s.pago), devido: r2(s.devido), saldo: r2(s.pago - s.devido) }));
  const total = r2(desp.reduce((a, d) => a + d.valor, 0));
  return { mes, total, horas_total: r2(totH), custo_hora: totH ? r2(total / totH) : null, socios };
}

function dashboard() {
  const mes = hoje().slice(0, 7);
  return {
    aeronave: get('SELECT * FROM aeronave WHERE id = 1'), horas_total: horasTotais(),
    itens: itensComStatus(),
    reservas: all('SELECT r.*, u.nome FROM reservas r JOIN usuarios u ON u.id = r.user_id WHERE r.fim >= ? ORDER BY r.inicio LIMIT 5', agoraLocal()),
    voos: all('SELECT v.*, u.nome FROM voos v JOIN usuarios u ON u.id = v.user_id ORDER BY v.data DESC, v.hobbs_fim DESC LIMIT 5'),
    rateio: rateio(mes),
  };
}

function realizarManutencao(id, b) {
  const it = get('SELECT * FROM manutencao_itens WHERE id = ?', id);
  if (!it) throw new HttpError(404, 'Item não encontrado');
  const d = data(b.data, 'Data'), h = num(b.horas, 'Horímetro', { req: true }), custo = num(b.custo, 'Custo');
  return tx(() => {
    run('INSERT INTO manutencao_eventos (item_id,data,horas,custo,oficina,descricao) VALUES (?,?,?,?,?,?)', id, d, h, custo, str(b.oficina, 100), str(b.descricao, 500));
    run('UPDATE manutencao_itens SET ultima_horas = ?, ultima_data = ? WHERE id = ?', h, d, id);
    if (custo > 0 && b.pago_por) {
      if (!['horas', 'cota', 'igual'].includes(b.rateio)) throw bad('Critério de rateio inválido');
      run('INSERT INTO despesas (data,categoria,descricao,valor,pago_por,rateio,criado_por) VALUES (?,?,?,?,?,?,?)',
        d, 'Manutenção', `${it.nome}${b.oficina ? ' - ' + str(b.oficina, 100) : ''}`, custo, checkUser(Number(b.pago_por), 'Pagador'), b.rateio, b.__user);
    }
    return { ok: true };
  });
}

// ---------- HTTP ----------
const sessaoDe = (req) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  return get('SELECT u.id, u.nome, u.email, u.cota_pct FROM sessoes s JOIN usuarios u ON u.id = s.user_id WHERE s.token = ? AND s.expira > ?', m[1], Date.now()) || null;
};
const cookie = (req, valor, maxAge) => {
  const seguro = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
  return `sid=${valor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${seguro ? '; Secure' : ''}`;
};
const lerBody = (req) => new Promise((res, rej) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) { rej(new HttpError(413, 'Corpo muito grande')); req.destroy(); } });
  req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(bad('JSON inválido')); } });
  req.on('error', rej);
});
const enviar = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};

async function api(req, res, url) {
  const partes = url.pathname.split('/').filter(Boolean).slice(1); // remove "api"
  const [rec, idStr, acao] = partes;
  const id = idStr ? Number(idStr) : 0;
  const m = req.method;
  const semUsuarios = get('SELECT COUNT(*) c FROM usuarios').c === 0;
  if (m !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) throw bad('Content-Type deve ser application/json');
  const body = m === 'GET' || m === 'DELETE' ? {} : await lerBody(req);

  if (rec === 'setup' && m === 'POST') {
    if (!semUsuarios) throw new HttpError(403, 'Sistema já configurado');
    tx(() => {
      criarUsuario(body);
      run('INSERT OR REPLACE INTO aeronave (id,matricula,modelo,horas_iniciais) VALUES (1,?,?,?)',
        str(body.matricula, 10)?.toUpperCase(), str(body.modelo, 60), num(body.horas_iniciais ?? 0, 'Horas iniciais'));
    });
    return enviar(res, 201, { ok: true });
  }
  if (rec === 'login' && m === 'POST') {
    limitaLogin(req.socket.remoteAddress || '');
    const u = get('SELECT * FROM usuarios WHERE email = ?', String(body.email || '').toLowerCase());
    if (!u || !checkSenha(String(body.senha || ''), u)) throw new HttpError(401, 'E-mail ou senha incorretos');
    const token = crypto.randomBytes(32).toString('hex');
    run('DELETE FROM sessoes WHERE expira < ?', Date.now());
    run('INSERT INTO sessoes (token,user_id,expira) VALUES (?,?,?)', token, u.id, Date.now() + 30 * 86400000);
    return enviar(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, token, 30 * 86400) });
  }
  if (rec === 'me' && m === 'GET') return enviar(res, 200, { setup: semUsuarios, user: sessaoDe(req) });

  const user = sessaoDe(req);
  if (!user) throw new HttpError(401, 'Não autenticado');

  if (rec === 'logout' && m === 'POST') {
    const t = /sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (t) run('DELETE FROM sessoes WHERE token = ?', t);
    return enviar(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }
  if (rec === 'dashboard' && m === 'GET') return enviar(res, 200, dashboard());
  if (rec === 'rateio' && m === 'GET') return enviar(res, 200, rateio(url.searchParams.get('mes') || hoje().slice(0, 7)));
  if (rec === 'aeronave') {
    if (m === 'GET') return enviar(res, 200, get('SELECT * FROM aeronave WHERE id = 1') || {});
    if (m === 'PUT') {
      run('INSERT OR REPLACE INTO aeronave (id,matricula,modelo,horas_iniciais) VALUES (1,?,?,?)',
        str(body.matricula, 10)?.toUpperCase(), str(body.modelo, 60), num(body.horas_iniciais ?? 0, 'Horas iniciais'));
      return enviar(res, 200, { ok: true });
    }
  }
  if (rec === 'usuarios') {
    if (m === 'GET') return enviar(res, 200, all('SELECT id, nome, email, cota_pct FROM usuarios ORDER BY id'));
    if (m === 'POST') return enviar(res, 201, { id: criarUsuario(body) });
    if (m === 'PUT' && id) {
      const nome = str(body.nome, 80), cota = num(body.cota_pct, 'Cota', { req: true });
      if (!nome || cota > 100) throw bad('Dados inválidos');
      run('UPDATE usuarios SET nome = ?, cota_pct = ? WHERE id = ?', nome, cota, id);
      if (body.senha) {
        if (id !== user.id) throw new HttpError(403, 'Só é possível alterar a própria senha');
        if (String(body.senha).length < 8) throw bad('A senha precisa ter ao menos 8 caracteres');
        const salt = crypto.randomBytes(16).toString('hex');
        run('UPDATE usuarios SET senha_hash = ?, salt = ? WHERE id = ?', hashSenha(String(body.senha), salt), salt, id);
      }
      return enviar(res, 200, { ok: true });
    }
  }
  if (rec === 'manutencao' && acao === 'realizar' && m === 'POST') return enviar(res, 200, realizarManutencao(id, { ...body, __user: user.id }));
  if (rec === 'manutencao' && acao === 'historico' && m === 'GET')
    return enviar(res, 200, all('SELECT * FROM manutencao_eventos WHERE item_id = ? ORDER BY data DESC, id DESC', id));
  if (tabelas[rec]) return enviar(res, m === 'POST' ? 201 : 200, crud(rec, m, id, body, user));
  throw new HttpError(404, 'Rota não encontrada');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return enviar(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const arq = path.join(PUBLIC, rel);
    if (!arq.startsWith(PUBLIC + path.sep) || !fs.existsSync(arq) || !fs.statSync(arq).isFile()) throw new HttpError(404, 'Não encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    fs.createReadStream(arq).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) enviar(res, e.status || 500, { erro: e instanceof HttpError ? e.message : 'Erro interno' });
  }
}).listen(PORT, () => console.log(`Aeronave rodando em http://localhost:${PORT}`));
