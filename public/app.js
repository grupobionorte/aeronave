const $app = document.getElementById('app');
const state = { user: null, usuarios: [], aeronave: {} };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (n) => (n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hh = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
const dbr = (d) => (d ? d.split('-').reverse().join('/') : '—');
const dtbr = (d) => (d ? dbr(d.slice(0, 10)) + ' ' + d.slice(11) : '—');
const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

async function api(method, url, body) {
  const r = await fetch('/api/' + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && state.user) { state.user = null; render(); }
    throw new Error(j.erro || 'Erro ' + r.status);
  }
  return j;
}
const userOpts = () => state.usuarios.map((u) => ({ v: u.id, t: u.nome }));
const nomeUser = (id) => state.usuarios.find((u) => u.id === id)?.nome || '?';

// Formulário genérico em <dialog>. campos: {n, l, t, opts, req, step, full}
function form(titulo, campos, valores, onSubmit, extra = '') {
  const dlg = document.createElement('dialog');
  const input = (c) => {
    const v = valores[c.n] ?? '';
    const base = `name="${c.n}" ${c.req ? 'required' : ''}`;
    if (c.t === 'select') return `<select ${base}>${c.opts.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    if (c.t === 'textarea') return `<textarea ${base} rows="2">${esc(v)}</textarea>`;
    return `<input ${base} type="${c.t || 'text'}" ${c.step ? `step="${c.step}"` : ''} value="${esc(v)}">`;
  };
  dlg.innerHTML = `<form method="dialog"><h2>${esc(titulo)}</h2>${extra}
    ${campos.map((c) => `<label>${esc(c.l)}${c.req ? ' *' : ''}${input(c)}</label>`).join('')}
    <div class="erro"></div>
    <div class="row between"><button type="button" data-x>Cancelar</button><button class="pri" type="submit">Salvar</button></div></form>`;
  document.body.append(dlg);
  dlg.querySelector('[data-x]').onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(e.target));
    try { await onSubmit(dados); dlg.close(); render(); } catch (err) { dlg.querySelector('.erro').textContent = err.message; }
  };
  dlg.showModal();
}
const confirmar = (msg) => window.confirm(msg);
const acao = async (fn) => { try { await fn(); render(); } catch (e) { alert(e.message); } };

// ---------- backup ----------
async function restaurarArquivo(arq, depois) {
  if (!arq) return;
  try {
    const txt = await arq.text();
    JSON.parse(txt);
    if (state.user && !confirmar('Isso SUBSTITUI todos os dados atuais pelos do arquivo e exige novo login. Continuar?')) return;
    const r = await fetch('/api/restaurar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: txt });
    const j = await r.json();
    if (!r.ok) throw new Error(j.erro || 'Erro ' + r.status);
    state.user = null;
    alert('Backup restaurado. Entre com o e-mail e a senha que existiam no backup.');
    depois();
  } catch (e) { alert('Não foi possível restaurar: ' + e.message); }
}

// ---------- autenticação ----------
function telaAuth(setup) {
  $app.innerHTML = `<div class="login card"><h2>${setup ? 'Configuração inicial' : 'Entrar'}</h2>
  <form>
    ${setup ? `<p class="mut">Cadastre a aeronave e o primeiro sócio. O segundo sócio é adicionado depois, em Configurações.</p>
      <div class="two"><label>Matrícula<input name="matricula" placeholder="PT-XXX" required></label><label>Modelo<input name="modelo" required></label></div>
      <label>Horímetro atual da aeronave (h)<input name="horas_iniciais" type="number" step="0.1" min="0" value="0" required></label>
      <label>Seu nome<input name="nome" required></label>` : ''}
    <label>E-mail<input name="email" type="email" required autocomplete="username"></label>
    <label>Senha${setup ? ' (mín. 8 caracteres)' : ''}<input name="senha" type="password" required minlength="${setup ? 8 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
    <div class="erro"></div><button class="pri" style="width:100%">${setup ? 'Criar' : 'Entrar'}</button>
  </form>${setup ? `<hr><label>Já tem um backup? Restaurar a partir do arquivo<input type="file" id="rest" accept=".json,application/json"></label>` : ''}</div>`;
  if (setup) document.getElementById('rest').onchange = (e) => restaurarArquivo(e.target.files[0], () => boot());
  $app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      if (setup) await api('POST', 'setup', { ...d, cota_pct: 50 });
      await api('POST', 'login', { email: d.email, senha: d.senha });
      await boot();
    } catch (err) { $app.querySelector('.erro').textContent = err.message; }
  };
}

// ---------- views ----------
const tagStatus = { ok: 'Em dia', atencao: 'Atenção', vencido: 'Vencido' };

async function vPainel() {
  const d = await api('GET', 'dashboard');
  const a = d.aeronave || {};
  const alertas = d.itens.filter((i) => i.status !== 'ok');
  const rest = (i) => [i.restante_horas != null ? `${hh(i.restante_horas)} h` : null, i.restante_dias != null ? `${i.restante_dias} dias` : null].filter(Boolean).join(' / ');
  return `<div class="grid">
    <div class="card"><div class="mut">${esc(a.matricula)} · ${esc(a.modelo)}</div><div class="big">${hh(d.horas_total)} h</div><div class="mut">horímetro atual</div></div>
    <div class="card"><div class="mut">Rateio de ${d.rateio.mes}</div><div class="big">${brl(d.rateio.total)}</div>
      <div class="mut">${hh(d.rateio.horas_total)} h voadas${d.rateio.custo_hora ? ' · ' + brl(d.rateio.custo_hora) + '/h' : ''}</div></div>
  </div>
  <div class="card"><h3>Manutenção que requer atenção</h3>
    ${alertas.length ? `<table>${alertas.map((i) => `<tr><td>${esc(i.nome)}</td><td class="n">${rest(i)}</td><td class="n"><span class="tag ${i.status}">${tagStatus[i.status]}</span></td></tr>`).join('')}</table>`
      : '<p class="mut">Nenhum item vencido ou próximo do vencimento.</p>'}
    ${d.itens.length ? '' : '<p class="mut">Nenhum item cadastrado ainda. Cadastre em Manutenção.</p>'}</div>
  <div class="grid">
    <div class="card"><h3>Próximas reservas</h3>${d.reservas.length ? `<table>${d.reservas.map((r) => `<tr><td>${esc(r.nome)}</td><td class="n">${dtbr(r.inicio)} → ${dtbr(r.fim)}</td></tr>`).join('')}</table>` : '<p class="mut">Sem reservas futuras.</p>'}</div>
    <div class="card"><h3>Últimos voos</h3>${d.voos.length ? `<table>${d.voos.map((v) => `<tr><td>${dbr(v.data)}</td><td>${esc(v.nome)}</td><td class="n">${hh(v.horas)} h</td></tr>`).join('')}</table>` : '<p class="mut">Nenhum voo registrado.</p>'}</div>
  </div>`;
}

const camposVoo = () => [
  { n: 'data', l: 'Data', t: 'date', req: 1 }, { n: 'user_id', l: 'Piloto', t: 'select', opts: userOpts() },
  { n: 'origem', l: 'Origem (ICAO)' }, { n: 'destino', l: 'Destino (ICAO)' },
  { n: 'hobbs_ini', l: 'Horímetro inicial', t: 'number', step: '0.1', req: 1 }, { n: 'hobbs_fim', l: 'Horímetro final', t: 'number', step: '0.1', req: 1 },
  { n: 'pousos', l: 'Pousos', t: 'number', req: 1 }, { n: 'combustivel_litros', l: 'Combustível abastecido (L)', t: 'number', step: '0.1' },
  { n: 'obs', l: 'Observações / discrepâncias', t: 'textarea' },
];
async function vVoos() {
  const voos = await api('GET', 'voos');
  window.novoVoo = () => form('Novo voo', camposVoo(), { data: hoje(), user_id: state.user.id, pousos: 1, hobbs_ini: voos[0]?.hobbs_fim ?? state.aeronave.horas_iniciais ?? '' }, (d) => api('POST', 'voos', d));
  window.editVoo = (id) => form('Editar voo', camposVoo(), voos.find((v) => v.id === id), (d) => api('PUT', 'voos/' + id, d));
  window.delVoo = (id) => confirmar('Excluir este voo?') && acao(() => api('DELETE', 'voos/' + id));
  return `<div class="row between"><h2>Diário de voo</h2><button class="pri" onclick="novoVoo()">+ Novo voo</button></div>
  <div class="card scroll"><table><tr><th>Data</th><th>Piloto</th><th>Rota</th><th class="n">Horímetro</th><th class="n">Horas</th><th class="n">Pousos</th><th></th></tr>
  ${voos.map((v) => `<tr><td>${dbr(v.data)}</td><td>${esc(nomeUser(v.user_id))}</td><td>${esc(v.origem || '')}${v.destino ? ' → ' + esc(v.destino) : ''}${v.obs ? `<div class="mut">${esc(v.obs)}</div>` : ''}</td>
    <td class="n">${hh(v.hobbs_ini)} → ${hh(v.hobbs_fim)}</td><td class="n">${hh(v.horas)}</td><td class="n">${v.pousos}</td>
    <td class="n"><button class="sm" onclick="editVoo(${v.id})">Editar</button> <button class="sm del" onclick="delVoo(${v.id})">×</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Nenhum voo registrado.</td></tr>'}</table></div>`;
}

const camposReserva = () => [
  { n: 'user_id', l: 'Sócio', t: 'select', opts: userOpts() }, { n: 'inicio', l: 'Início', t: 'datetime-local', req: 1 },
  { n: 'fim', l: 'Fim', t: 'datetime-local', req: 1 }, { n: 'obs', l: 'Observações (destino, etc.)', t: 'textarea' },
];
async function vReservas() {
  const rs = (await api('GET', 'reservas')).reverse();
  const agora = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  window.novaRes = () => form('Nova reserva', camposReserva(), { user_id: state.user.id, inicio: agora.slice(0, 11) + '08:00', fim: agora.slice(0, 11) + '12:00' }, (d) => api('POST', 'reservas', d));
  window.editRes = (id) => form('Editar reserva', camposReserva(), rs.find((r) => r.id === id), (d) => api('PUT', 'reservas/' + id, d));
  window.delRes = (id) => confirmar('Cancelar esta reserva?') && acao(() => api('DELETE', 'reservas/' + id));
  const fut = rs.filter((r) => r.fim >= agora), pas = rs.filter((r) => r.fim < agora).reverse().slice(0, 15);
  const tabela = (l) => `<table>${l.map((r) => `<tr><td>${esc(nomeUser(r.user_id))}</td><td>${dtbr(r.inicio)} → ${dtbr(r.fim)}${r.obs ? `<div class="mut">${esc(r.obs)}</div>` : ''}</td>
    <td class="n"><button class="sm" onclick="editRes(${r.id})">Editar</button> <button class="sm del" onclick="delRes(${r.id})">×</button></td></tr>`).join('') || '<tr><td class="mut">Nenhuma.</td></tr>'}</table>`;
  return `<div class="row between"><h2>Reservas</h2><button class="pri" onclick="novaRes()">+ Nova reserva</button></div>
  <div class="card"><h3>Próximas</h3>${tabela(fut)}</div><div class="card"><h3>Anteriores</h3>${tabela(pas)}</div>`;
}

const camposItem = () => [
  { n: 'nome', l: 'Item (ex.: Inspeção 100h, Anual, Troca de óleo)', req: 1 },
  { n: 'intervalo_horas', l: 'Intervalo em horas (opcional)', t: 'number', step: '0.1' }, { n: 'intervalo_meses', l: 'Intervalo em meses (opcional)', t: 'number' },
  { n: 'ultima_horas', l: 'Horímetro da última execução', t: 'number', step: '0.1' }, { n: 'ultima_data', l: 'Data da última execução', t: 'date' },
  { n: 'alerta_horas', l: 'Avisar quando faltar (horas)', t: 'number', step: '0.1' }, { n: 'alerta_dias', l: 'Avisar quando faltar (dias)', t: 'number' },
  { n: 'obs', l: 'Observações (referência do manual, AD, etc.)', t: 'textarea' },
];
const ratOpts = [{ v: 'horas', t: 'Proporcional às horas voadas no mês' }, { v: 'cota', t: 'Pela cota de cada sócio' }, { v: 'igual', t: 'Igualmente' }];
async function vManutencao() {
  const d = await api('GET', 'dashboard');
  const itens = d.itens;
  window.novoItem = () => form('Novo item de manutenção', camposItem(), { alerta_horas: 10, alerta_dias: 30, ultima_horas: d.horas_total, ultima_data: hoje() }, (x) => api('POST', 'manutencao', x));
  window.editItem = (id) => form('Editar item', camposItem(), itens.find((i) => i.id === id), (x) => api('PUT', 'manutencao/' + id, x));
  window.delItem = (id) => confirmar('Excluir este item e seu histórico?') && acao(() => api('DELETE', 'manutencao/' + id));
  window.realizar = (id) => form('Registrar execução', [
    { n: 'data', l: 'Data', t: 'date', req: 1 }, { n: 'horas', l: 'Horímetro na execução', t: 'number', step: '0.1', req: 1 },
    { n: 'oficina', l: 'Oficina / mecânico' }, { n: 'descricao', l: 'Descrição do serviço', t: 'textarea' },
    { n: 'custo', l: 'Custo (R$) — gera despesa no rateio', t: 'number', step: '0.01' },
    { n: 'pago_por', l: 'Quem pagou', t: 'select', opts: userOpts() }, { n: 'rateio', l: 'Rateio do custo', t: 'select', opts: ratOpts },
  ], { data: hoje(), horas: d.horas_total, pago_por: state.user.id, rateio: 'cota' }, (x) => api('POST', `manutencao/${id}/realizar`, x));
  window.hist = async (id) => {
    const ev = await api('GET', `manutencao/${id}/historico`);
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<h2>Histórico</h2>${ev.length ? `<table>${ev.map((e) => `<tr><td>${dbr(e.data)}</td><td>${hh(e.horas)} h<div class="mut">${esc(e.oficina || '')} ${esc(e.descricao || '')}</div></td><td class="n">${e.custo ? brl(e.custo) : ''}</td></tr>`).join('')}</table>` : '<p class="mut">Sem execuções registradas.</p>'}<button>Fechar</button>`;
    dlg.querySelector('button').onclick = () => dlg.close(); dlg.onclose = () => dlg.remove();
    document.body.append(dlg); dlg.showModal();
  };
  const prox = (i) => [i.proxima_horas != null ? `${hh(i.proxima_horas)} h (faltam ${hh(i.restante_horas)})` : null,
    i.proxima_data ? `${dbr(i.proxima_data)} (${i.restante_dias >= 0 ? 'faltam ' + i.restante_dias + ' dias' : 'venceu há ' + -i.restante_dias + ' dias'})` : null].filter(Boolean).join('<br>');
  return `<div class="row between"><h2>Manutenção</h2><button class="pri" onclick="novoItem()">+ Novo item</button></div>
  <p class="mut">Horímetro atual: <b>${hh(d.horas_total)} h</b>. Este controle é um auxílio e não substitui as cadernetas oficiais nem a programação do fabricante/ANAC.</p>
  <div class="card scroll"><table><tr><th>Item</th><th>Última</th><th>Próxima</th><th>Status</th><th></th></tr>
  ${itens.map((i) => `<tr><td>${esc(i.nome)}${i.obs ? `<div class="mut">${esc(i.obs)}</div>` : ''}</td>
    <td>${i.ultima_horas != null ? hh(i.ultima_horas) + ' h' : ''}<div class="mut">${dbr(i.ultima_data)}</div></td><td>${prox(i)}</td>
    <td><span class="tag ${i.status}">${tagStatus[i.status]}</span></td>
    <td class="n"><button class="sm pri" onclick="realizar(${i.id})">Realizada</button> <button class="sm" onclick="hist(${i.id})">Histórico</button>
    <button class="sm" onclick="editItem(${i.id})">Editar</button> <button class="sm del" onclick="delItem(${i.id})">×</button></td></tr>`).join('') || '<tr><td colspan="5" class="mut">Nenhum item cadastrado.</td></tr>'}</table></div>`;
}

const camposDesp = () => [
  { n: 'data', l: 'Data', t: 'date', req: 1 },
  { n: 'categoria', l: 'Categoria', t: 'select', opts: ['Combustível', 'Manutenção', 'Hangar', 'Seguro', 'Taxas/Tarifas', 'Peças', 'Outros'].map((c) => ({ v: c, t: c })) },
  { n: 'descricao', l: 'Descrição' }, { n: 'valor', l: 'Valor (R$)', t: 'number', step: '0.01', req: 1 },
  { n: 'pago_por', l: 'Quem pagou', t: 'select', opts: userOpts() }, { n: 'rateio', l: 'Rateio', t: 'select', opts: ratOpts },
];
let mesSel = hoje().slice(0, 7);
async function vFinanceiro() {
  const [desp, r] = await Promise.all([api('GET', 'despesas'), api('GET', 'rateio?mes=' + mesSel)]);
  window.setMes = (m) => { if (m) { mesSel = m; render(); } };
  window.novaDesp = () => form('Nova despesa', camposDesp(), { data: hoje(), pago_por: state.user.id, rateio: 'horas' }, (d) => api('POST', 'despesas', d));
  window.editDesp = (id) => form('Editar despesa', camposDesp(), desp.find((x) => x.id === id), (d) => api('PUT', 'despesas/' + id, d));
  window.delDesp = (id) => confirmar('Excluir esta despesa?') && acao(() => api('DELETE', 'despesas/' + id));
  const lista = desp.filter((d) => d.data.startsWith(mesSel));
  const acerto = (() => {
    const dev = r.socios.filter((s) => s.saldo < -0.005), rec = r.socios.filter((s) => s.saldo > 0.005);
    return dev.map((d) => `<div><b>${esc(d.nome)}</b> deve ${brl(-d.saldo)}${rec.length ? ' a ' + rec.map((x) => esc(x.nome)).join(', ') : ''}</div>`).join('') || '<div class="mut">Contas equilibradas neste mês.</div>';
  })();
  return `<div class="row between"><h2>Financeiro</h2><div class="row"><input type="month" value="${mesSel}" style="width:auto" onchange="setMes(this.value)"><button class="pri" onclick="novaDesp()">+ Despesa</button></div></div>
  <div class="card"><h3>Acerto de ${mesSel}</h3>
  <div class="scroll"><table><tr><th>Sócio</th><th class="n">Horas</th><th class="n">Pagou</th><th class="n">Deve (rateio)</th><th class="n">Saldo</th></tr>
  ${r.socios.map((s) => `<tr><td>${esc(s.nome)}</td><td class="n">${hh(s.horas)}</td><td class="n">${brl(s.pago)}</td><td class="n">${brl(s.devido)}</td><td class="n ${s.saldo >= 0 ? 'pos' : 'neg'}">${brl(s.saldo)}</td></tr>`).join('')}</table></div>
  <p>${acerto}</p><div class="mut">Total do mês: ${brl(r.total)}${r.custo_hora ? ` · custo médio ${brl(r.custo_hora)}/h` : ''}. Saldo positivo = a receber.</div></div>
  <div class="card scroll"><h3>Despesas do mês</h3><table><tr><th>Data</th><th>Descrição</th><th>Pagou</th><th>Rateio</th><th class="n">Valor</th><th></th></tr>
  ${lista.map((d) => `<tr><td>${dbr(d.data)}</td><td>${esc(d.categoria)}<div class="mut">${esc(d.descricao || '')}</div></td><td>${esc(nomeUser(d.pago_por))}</td><td>${{ horas: 'Horas', cota: 'Cota', igual: 'Igual' }[d.rateio]}</td>
    <td class="n">${brl(d.valor)}</td><td class="n"><button class="sm" onclick="editDesp(${d.id})">Editar</button> <button class="sm del" onclick="delDesp(${d.id})">×</button></td></tr>`).join('') || '<tr><td colspan="6" class="mut">Nenhuma despesa neste mês.</td></tr>'}</table></div>`;
}

async function vConfig() {
  const us = await api('GET', 'usuarios');
  window.editAero = () => form('Aeronave', [{ n: 'matricula', l: 'Matrícula' }, { n: 'modelo', l: 'Modelo' }, { n: 'horas_iniciais', l: 'Horímetro inicial (h)', t: 'number', step: '0.1' }], state.aeronave, (d) => api('PUT', 'aeronave', d));
  window.novoSocio = () => form('Novo sócio', [{ n: 'nome', l: 'Nome', req: 1 }, { n: 'email', l: 'E-mail', t: 'email', req: 1 }, { n: 'senha', l: 'Senha inicial (mín. 8)', t: 'password', req: 1 }, { n: 'cota_pct', l: 'Cota (%)', t: 'number', step: '0.01' }], { cota_pct: 50 }, (d) => api('POST', 'usuarios', d));
  window.editSocio = (id) => form('Editar sócio', [{ n: 'nome', l: 'Nome', req: 1 }, { n: 'cota_pct', l: 'Cota (%)', t: 'number', step: '0.01', req: 1 }, ...(id === state.user.id ? [{ n: 'senha', l: 'Nova senha (deixe vazio para manter)', t: 'password' }] : [])], us.find((u) => u.id === id), (d) => api('PUT', 'usuarios/' + id, d));
  window.restaurar = (input) => restaurarArquivo(input.files[0], () => boot());
  const soma = us.reduce((a, u) => a + u.cota_pct, 0);
  return `<h2>Configurações</h2>
  <div class="card"><div class="row between"><h3>Aeronave</h3><button class="sm" onclick="editAero()">Editar</button></div>
    <div>${esc(state.aeronave.matricula)} · ${esc(state.aeronave.modelo)}</div><div class="mut">Horímetro inicial: ${hh(state.aeronave.horas_iniciais)} h</div></div>
  <div class="card"><div class="row between"><h3>Sócios</h3><button class="sm" onclick="novoSocio()">+ Adicionar</button></div>
  <table>${us.map((u) => `<tr><td>${esc(u.nome)}<div class="mut">${esc(u.email)}</div></td><td class="n">${u.cota_pct}%</td><td class="n"><button class="sm" onclick="editSocio(${u.id})">Editar</button></td></tr>`).join('')}</table>
  ${Math.abs(soma - 100) > 0.01 ? `<p class="neg">As cotas somam ${soma}%, deveriam somar 100%.</p>` : ''}</div>
  <div class="card"><h3>Backup</h3>
    <p class="mut">Baixe uma cópia dos dados com frequência (após cada voo ou despesa). O arquivo contém os dados dos sócios e as senhas criptografadas: guarde-o em local privado.</p>
    <div class="row"><a class="btn pri" href="/api/backup" download>Baixar backup</a></div>
    <label style="margin-top:12px">Restaurar a partir de um arquivo (substitui tudo)<input type="file" accept=".json,application/json" onchange="restaurar(this)"></label></div>`;
}

const rotas = { painel: ['Painel', vPainel], voos: ['Voos', vVoos], reservas: ['Reservas', vReservas], manutencao: ['Manutenção', vManutencao], financeiro: ['Financeiro', vFinanceiro], config: ['Config.', vConfig] };

async function render() {
  if (!state.user) return;
  const k = location.hash.slice(1) in rotas ? location.hash.slice(1) : 'painel';
  $app.innerHTML = `<header><div class="bar"><h1>✈ ${esc(state.aeronave.matricula || 'Aeronave')}</h1><span class="mut">${esc(state.user.nome)}</span><button class="sm" id="sair">Sair</button></div>
    <nav>${Object.entries(rotas).map(([id, [t]]) => `<a href="#${id}" class="${id === k ? 'on' : ''}">${t}</a>`).join('')}</nav></header><main>Carregando…</main>`;
  document.getElementById('sair').onclick = async () => { await api('POST', 'logout', {}); state.user = null; boot(); };
  try {
    [state.usuarios, state.aeronave] = await Promise.all([api('GET', 'usuarios'), api('GET', 'aeronave')]);
    const html = await rotas[k][1]();
    if (location.hash.slice(1) === k || (!location.hash && k === 'painel')) document.querySelector('main').innerHTML = html;
  } catch (e) { document.querySelector('main').innerHTML = `<p class="neg">${esc(e.message)}</p>`; }
}

async function boot() {
  const me = await api('GET', 'me');
  state.user = me.user;
  if (!me.user) return telaAuth(me.setup);
  render();
}
window.addEventListener('hashchange', render);
boot();
