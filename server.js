const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const { Sequelize, DataTypes, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const moment = require('moment');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

// ==================== CONFIGURAÇÃO INICIAL ====================
const app = express();
const PORT = process.env.PORT || 3000;

// 🔧 NECESSÁRIO PARA PROXY (RAILWAY, HEROKU, ETC.) – FAZ O EXPRESS CONFIAR NO HEADER X-Forwarded-Proto
app.set('trust proxy', 1);

// Middlewares básicos
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cors());

// ==================== CONFIGURAÇÃO DE SESSÃO (CORRIGIDA PARA PRODUÇÃO) ====================
app.use(session({
    secret: process.env.SESSION_SECRET || 'sistema-gestao-secret-mysql',
    resave: false,
    saveUninitialized: false,
    proxy: true, // IMPORTANTE: permite que o Express use o header X-Forwarded-Proto
    cookie: {
        secure: process.env.NODE_ENV === 'production' ? true : false,
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Configuração do EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== MULTER (UPLOAD) ====================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'image/jpeg',
            'image/png',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não suportado'));
        }
    }
});

// ==================== CONEXÃO COM MYSQL ====================
const sequelize = new Sequelize(
    process.env.DB_NAME || 'sistema_gestao_reclamacoes',
    process.env.DB_USER || 'root',
    process.env.DB_PASSWORD || '',
    {
        host: process.env.DB_HOST || 'localhost',
        dialect: 'mysql',
        logging: false,
        pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
    }
);

// ==================== MODELOS ====================

// Usuario
const Usuario = sequelize.define('Usuario', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nome: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(255), unique: true, allowNull: false },
    senha: { type: DataTypes.STRING(255), allowNull: false },
    tipo: { type: DataTypes.ENUM('admin', 'gerente', 'atendente', 'tecnico'), defaultValue: 'atendente' },
    ativo: { type: DataTypes.BOOLEAN, defaultValue: true }
}, { tableName: 'usuarios', timestamps: true });

// Solicitacao (sem os campos JSON de histórico e anexos)
const Solicitacao = sequelize.define('Solicitacao', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    codigo: { type: DataTypes.STRING(50), unique: true },
    cliente_nome: { type: DataTypes.STRING(255), allowNull: false },
    cliente_email: { type: DataTypes.STRING(255), allowNull: false, validate: { isEmail: true } },
    cliente_telefone: { type: DataTypes.STRING(20) },
    titulo: { type: DataTypes.STRING(255), allowNull: false },
    descricao: { type: DataTypes.TEXT, allowNull: false },
    tipo: { type: DataTypes.ENUM('reclamacao', 'sugestao', 'elogio', 'duvida'), allowNull: false },
    categoria: { type: DataTypes.ENUM('faturacao', 'servico', 'tecnico', 'outro'), defaultValue: 'outro' },
    prioridade: { type: DataTypes.ENUM('baixa', 'media', 'alta', 'urgente'), defaultValue: 'media' },
    status: { type: DataTypes.ENUM('pendente', 'em_analise', 'em_andamento', 'resolvido', 'cancelado'), defaultValue: 'pendente' },
    usuario_responsavel: { type: DataTypes.STRING(255) },
    data_abertura: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    data_limite: { type: DataTypes.DATE },
    data_conclusao: { type: DataTypes.DATE },
    avaliacao_cliente: { type: DataTypes.INTEGER, validate: { min: 1, max: 5 } },
    feedback_cliente: { type: DataTypes.TEXT },
    tags: { type: DataTypes.JSON }
}, {
    tableName: 'solicitacoes',
    timestamps: true,
    hooks: {
        beforeCreate: async (solicitacao) => {
            if (!solicitacao.codigo) {
                const ano = moment().format('YYYY');
                let codigo;
                let exists;
                do {
                    const random = Math.floor(1000 + Math.random() * 9000);
                    codigo = `SOL-${ano}-${random}`;
                    exists = await Solicitacao.findOne({ where: { codigo } });
                } while (exists);
                solicitacao.codigo = codigo;
            }
        }
    }
});

// Tabela de Histórico de Atualizações
const HistoricoSolicitacao = sequelize.define('HistoricoSolicitacao', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    solicitacao_id: { type: DataTypes.INTEGER, allowNull: false },
    data: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    autor: { type: DataTypes.STRING(255), allowNull: false },
    mensagem: { type: DataTypes.TEXT, allowNull: false }
}, {
    tableName: 'historico_solicitacoes',
    timestamps: false
});

// Tabela de Anexos
const AnexoSolicitacao = sequelize.define('AnexoSolicitacao', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    solicitacao_id: { type: DataTypes.INTEGER, allowNull: false },
    nome: { type: DataTypes.STRING(255), allowNull: false },
    caminho: { type: DataTypes.STRING(500), allowNull: false },
    tipo: { type: DataTypes.STRING(100), allowNull: false },
    tamanho: { type: DataTypes.INTEGER, allowNull: false },
    data: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    tableName: 'anexos_solicitacoes',
    timestamps: false
});

// Associações
Solicitacao.hasMany(HistoricoSolicitacao, { foreignKey: 'solicitacao_id', as: 'historicoItems' });
HistoricoSolicitacao.belongsTo(Solicitacao, { foreignKey: 'solicitacao_id' });
Solicitacao.hasMany(AnexoSolicitacao, { foreignKey: 'solicitacao_id', as: 'anexosItems' });
AnexoSolicitacao.belongsTo(Solicitacao, { foreignKey: 'solicitacao_id' });

// Modelo de Atendimento (mantido)
const Atendimento = sequelize.define('Atendimento', {
    idAtendimento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    Cliente: { type: DataTypes.STRING(255), allowNull: false },
    Reposnavel: { type: DataTypes.STRING(255), allowNull: false },
    DataAtendimento: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
    Hora: { type: DataTypes.TIME, defaultValue: () => moment().format('HH:mm:ss') },
    Observacao: { type: DataTypes.TEXT }
}, { tableName: 'atendimento', timestamps: true });

// ==================== SOCKET.IO ====================
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
app.set('io', io);

// ==================== MIDDLEWARE DE AUTENTICAÇÃO ====================
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            res.status(401).json({ error: 'Não autorizado', redirect: '/login' });
        } else {
            res.redirect('/login');
        }
    }
};

// ==================== ROTAS PÚBLICAS ====================
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const usuario = await Usuario.findOne({ where: { email } });
        if (usuario && bcrypt.compareSync(senha, usuario.senha)) {
            req.session.user = {
                id: usuario.id,
                nome: usuario.nome,
                email: usuario.email,
                tipo: usuario.tipo
            };
            req.session.save((err) => {
                if (err) return res.status(500).json({ tipo: "Falha", error: "Erro na sessão" });
                if (req.xhr || req.headers['content-type'] === 'application/json') {
                    return res.json({ tipo: "sucesso", redirect: '/dashboard', user: req.session.user });
                }
                res.redirect('/dashboard');
            });
        } else {
            if (req.xhr || req.headers['content-type'] === 'application/json') {
                return res.status(401).json({ tipo: "Falha", error: "Email ou senha inválidos" });
            }
            res.render('login', { error: 'Email ou senha inválidos' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ tipo: "Falha", error: "Erro interno" });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// Rota pública para envio de solicitação (landing page)
app.post('/solicitacoes/publica', async (req, res) => {
    try {
        const { cliente_nome, cliente_email, cliente_telefone, titulo, descricao, categoria, tipo = 'reclamacao' } = req.body;
        if (!cliente_nome || !cliente_email || !titulo || !descricao) {
            return res.status(400).json({ success: false, error: 'Nome, e-mail, título e descrição são obrigatórios.' });
        }
        const emailRegex = /^\S+@\S+\.\S+$/;
        if (!emailRegex.test(cliente_email)) {
            return res.status(400).json({ success: false, error: 'E-mail inválido.' });
        }

        const novaSolicitacao = await Solicitacao.create({
            cliente_nome,
            cliente_email,
            cliente_telefone: cliente_telefone || '',
            titulo,
            descricao,
            tipo,
            categoria: categoria || 'outro'
        });

        // Registrar histórico inicial
        await HistoricoSolicitacao.create({
            solicitacao_id: novaSolicitacao.id,
            autor: 'Cliente',
            mensagem: 'Solicitação criada via site público',
            data: new Date()
        });

        const io = req.app.get('io');
        io.emit('nova_solicitacao', {
            id: novaSolicitacao.id,
            codigo: novaSolicitacao.codigo,
            cliente_nome: novaSolicitacao.cliente_nome,
            titulo: novaSolicitacao.titulo,
            tipo: novaSolicitacao.tipo,
            created_at: new Date()
        });

        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.json({ success: true, message: 'Solicitação enviada com sucesso!', id: novaSolicitacao.id, codigo: novaSolicitacao.codigo });
        }
        res.redirect('/');
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Erro interno ao criar solicitação.' });
    }
});

// Rota pública para registro de novos usuários
app.post('/registro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if (!nome || !email || !senha) {
            return res.status(400).json({ success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
        }
        const existingUser = await Usuario.findOne({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'E-mail já registrado.' });
        }
        const hashedPassword = bcrypt.hashSync(senha, 10);
        await Usuario.create({
            nome,
            email,
            senha: hashedPassword,
            tipo: 'atendente',
            ativo: true
        });
        res.status(201).json({ success: true, message: 'Usuário criado com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Erro interno ao criar usuário.' });
    }
});

// ==================== ROTAS PROTEGIDAS ====================
app.get('/', (req, res) => {
    if (req.session.user) res.redirect('/dashboard');
    else res.redirect('/login');
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const totalSolicitacoes = await Solicitacao.count();
        const pendentes = await Solicitacao.count({ where: { status: 'pendente' } });
        const emAndamento = await Solicitacao.count({ where: { status: 'em_andamento' } });
        const resolvidas = await Solicitacao.count({ where: { status: 'resolvido' } });
        const solicitacoesRecentes = await Solicitacao.findAll({ limit: 10, order: [['createdAt', 'DESC']] });
        res.render('dashboard', {
            user: req.session.user,
            stats: { total: totalSolicitacoes, pendentes, emAndamento, resolvidas },
            solicitacoesRecentes: solicitacoesRecentes.map(s => s.toJSON())
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar dashboard' });
    }
});

app.get('/solicitacoes', requireAuth, async (req, res) => {
    try {
        const { status, tipo, prioridade, page = 1 } = req.query;
        const limit = 10;
        const offset = (page - 1) * limit;
        let where = {};
        if (status && status !== 'todos') where.status = status;
        if (tipo && tipo !== 'todos') where.tipo = tipo;
        if (prioridade && prioridade !== 'todos') where.prioridade = prioridade;
        const { count, rows } = await Solicitacao.findAndCountAll({ where, limit, offset, order: [['createdAt', 'DESC']] });
        res.render('solicitacoes', {
            user: req.session.user,
            solicitacoes: rows,
            currentPage: parseInt(page),
            totalPages: Math.ceil(count / limit),
            filters: { status, tipo, prioridade },
            totalCount: count
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar solicitações' });
    }
});

app.post('/solicitacoes/nova', requireAuth, async (req, res) => {
    try {
        const { cliente_nome, cliente_email, cliente_telefone, titulo, descricao, categoria, tipo } = req.body;
        if (!cliente_nome || !cliente_email || !titulo || !descricao) {
            return res.status(400).json({ success: false, error: 'Todos os campos obrigatórios devem ser preenchidos' });
        }
        const novaSolicitacao = await Solicitacao.create({
            cliente_nome,
            cliente_email,
            cliente_telefone: cliente_telefone || '',
            titulo,
            descricao,
            tipo: tipo || 'reclamacao',
            categoria: categoria || 'outro'
        });

        // Registrar histórico
        await HistoricoSolicitacao.create({
            solicitacao_id: novaSolicitacao.id,
            autor: req.session.user?.nome || 'Sistema',
            mensagem: 'Solicitação criada',
            data: new Date()
        });

        const io = req.app.get('io');
        io.emit('nova_solicitacao', {
            id: novaSolicitacao.id,
            codigo: novaSolicitacao.codigo,
            cliente_nome: novaSolicitacao.cliente_nome,
            titulo: novaSolicitacao.titulo,
            tipo: novaSolicitacao.tipo,
            created_at: new Date()
        });

        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.json({ success: true, message: 'Solicitação criada com sucesso!', id: novaSolicitacao.id, codigo: novaSolicitacao.codigo });
        }
        res.redirect('/solicitacoes');
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Erro ao criar solicitação: ' + error.message });
    }
});

app.get('/solicitacoes/:id', requireAuth, async (req, res) => {
    try {
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).render('error', { error: 'Solicitação não encontrada' });
        res.render('detalhes-solicitacao', { user: req.session.user, solicitacao: solicitacao.toJSON() });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar solicitação' });
    }
});

// ==================== ROTAS DE AÇÕES (COM HISTÓRICO E ANEXOS NAS TABELAS PRÓPRIAS) ====================

// Atualizar status
app.put('/solicitacoes/:id/status', requireAuth, async (req, res) => {
    try {
        const { status } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        const statusAnterior = solicitacao.status;
        solicitacao.status = status;
        solicitacao.data_conclusao = status === 'resolvido' ? new Date() : null;
        await solicitacao.save();

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: req.session.user.nome,
            mensagem: `Status alterado de ${statusAnterior} para ${status}`,
            data: new Date()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Erro em /status:', error);
        res.status(500).json({ error: 'Erro ao atualizar status', details: error.message });
    }
});

// Atribuir responsável
app.post('/solicitacoes/:id/responsavel', requireAuth, async (req, res) => {
    try {
        const { responsavel } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        const responsavelAnterior = solicitacao.usuario_responsavel;
        solicitacao.usuario_responsavel = responsavel;
        await solicitacao.save();

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: req.session.user.nome,
            mensagem: `Responsável alterado de ${responsavelAnterior || 'ninguém'} para ${responsavel}`,
            data: new Date()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Erro em /responsavel:', error);
        res.status(500).json({ error: 'Erro ao atualizar responsável', details: error.message });
    }
});

// Adicionar nota
app.post('/solicitacoes/:id/nota', requireAuth, async (req, res) => {
    try {
        const { nota, autor } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: autor || req.session.user.nome,
            mensagem: `Nota adicionada: ${nota}`,
            data: new Date()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Erro em /nota:', error);
        res.status(500).json({ error: 'Erro ao adicionar nota', details: error.message });
    }
});

// Upload de anexo
app.post('/solicitacoes/:id/anexos', requireAuth, upload.single('anexo'), async (req, res) => {
    try {
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

        const anexo = await AnexoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            nome: req.file.originalname,
            caminho: `/uploads/${req.file.filename}`,
            tipo: req.file.mimetype,
            tamanho: req.file.size,
            data: new Date()
        });

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: req.session.user.nome,
            mensagem: `Anexo adicionado: ${req.file.originalname}`,
            data: new Date()
        });

        res.json({ success: true, anexo: { id: anexo.id, nome: anexo.nome, caminho: anexo.caminho, tipo: anexo.tipo, tamanho: anexo.tamanho, data: anexo.data } });
    } catch (error) {
        console.error('Erro em /anexos:', error);
        res.status(500).json({ error: 'Erro ao adicionar anexo', details: error.message });
    }
});

// Rota para servir arquivos de upload
app.get('/uploads/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'uploads', req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'Arquivo não encontrado' });
    }
});

// Agendamento de atendimento
app.post('/solicitacoes/agendamento', requireAuth, async (req, res) => {
    try {
        const { responsavel } = req.body;
        const solicitacao = await Solicitacao.findByPk(responsavel.Cliente);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        await Atendimento.create({
            Cliente: responsavel.Cliente,
            Reposnavel: responsavel.Responsavel,
            DataAtendimento: responsavel.data,
            Hora: responsavel.Hora,
            Observacao: responsavel.Observacao
        });

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: req.session.user.nome,
            mensagem: `Atendimento presencial agendado para ${responsavel.data} às ${responsavel.Hora}`,
            data: new Date()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Erro em /agendamento:', error);
        res.status(500).json({ error: 'Erro ao agendar atendimento', details: error.message });
    }
});

// Histórico (API) - retorna dados da tabela `historico_solicitacoes`
app.get('/solicitacoes/:id/historico', requireAuth, async (req, res) => {
    try {
        const historico = await HistoricoSolicitacao.findAll({
            where: { solicitacao_id: req.params.id },
            order: [['data', 'ASC']]
        });
        res.json(historico.map(h => ({ data: h.data, autor: h.autor, mensagem: h.mensagem })));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
});

// Anexos (API) - retorna dados da tabela `anexos_solicitacoes`
app.get('/solicitacoes/:id/anexos', requireAuth, async (req, res) => {
    try {
        const anexos = await AnexoSolicitacao.findAll({
            where: { solicitacao_id: req.params.id },
            order: [['data', 'DESC']]
        });
        res.json(anexos.map(a => ({ nome: a.nome, caminho: a.caminho, tipo: a.tipo, tamanho: a.tamanho, data: a.data })));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar anexos' });
    }
});

// Notificar cliente
app.post('/solicitacoes/:id/notificar', requireAuth, async (req, res) => {
    try {
        const { metodo } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: req.session.user.nome,
            mensagem: `Notificação enviada ao cliente via ${metodo}`,
            data: new Date()
        });

        res.json({ success: true, message: `Notificação enviada com sucesso via ${metodo}` });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar notificação' });
    }
});

// Editar solicitação
app.put('/solicitacoes/:id/editar', requireAuth, async (req, res) => {
    try {
        const { cliente_nome, cliente_email, cliente_telefone, titulo, categoria, prioridade, status, descricao } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });
        solicitacao.cliente_nome = cliente_nome;
        solicitacao.cliente_email = cliente_email;
        solicitacao.cliente_telefone = cliente_telefone;
        solicitacao.titulo = titulo;
        solicitacao.categoria = categoria;
        solicitacao.prioridade = prioridade;
        solicitacao.status = status;
        solicitacao.descricao = descricao;
        await solicitacao.save();

        await HistoricoSolicitacao.create({
            solicitacao_id: solicitacao.id,
            autor: req.session.user.nome,
            mensagem: `Solicitação atualizada por ${req.session.user.nome}`,
            data: new Date()
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar solicitação' });
    }
});

// Excluir solicitação (remove também histórico e anexos relacionados)
app.delete('/solicitacoes/:id/excluir', requireAuth, async (req, res) => {
    try {
        const id = req.params.id;
        await HistoricoSolicitacao.destroy({ where: { solicitacao_id: id } });
        await AnexoSolicitacao.destroy({ where: { solicitacao_id: id } });
        await Solicitacao.destroy({ where: { id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir solicitação' });
    }
});

// API para estatísticas (gráficos)
app.get('/api/estatisticas', requireAuth, async (req, res) => {
    try {
        const todas = await Solicitacao.findAll();
        const stats = {
            pendente: todas.filter(s => s.status === 'pendente').length,
            em_andamento: todas.filter(s => s.status === 'em_andamento').length,
            resolvido: todas.filter(s => s.status === 'resolvido').length,
            cancelado: todas.filter(s => s.status === 'cancelado').length,
            baixa: todas.filter(s => s.prioridade === 'baixa').length,
            media: todas.filter(s => s.prioridade === 'media').length,
            alta: todas.filter(s => s.prioridade === 'alta').length,
            urgente: todas.filter(s => s.prioridade === 'urgente').length,
            faturacao: todas.filter(s => s.categoria === 'faturacao').length,
            servico: todas.filter(s => s.categoria === 'servico').length,
            tecnico: todas.filter(s => s.categoria === 'tecnico').length,
            outro: todas.filter(s => s.categoria === 'outro').length,
            meses: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
            quantidades: new Array(12).fill(0)
        };
        todas.forEach(s => {
            const mes = new Date(s.data_abertura).getMonth();
            stats.quantidades[mes]++;
        });
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar estatísticas' });
    }
});

// Health check
app.get('/health', async (req, res) => {
    let dbStatus = 'disconnected';
    try {
        await sequelize.authenticate();
        dbStatus = 'connected';
    } catch (e) {}
    res.json({
        status: 'ok',
        database: dbStatus,
        mysql_configured: !!(process.env.DB_HOST || process.env.DATABASE_URL),
        timestamp: new Date().toISOString()
    });
});

// ==================== INICIALIZAÇÃO DO SERVIDOR ====================
async function startServer() {
    try {
        await sequelize.authenticate();
        console.log('✅ Conectado ao MySQL');
        await sequelize.sync({ alter: false });
        console.log('✅ Tabelas sincronizadas');

        const adminExists = await Usuario.findOne({ where: { email: 'admin@ncontas.com' } });
        if (!adminExists) {
            const hashedPassword = bcrypt.hashSync('admin123', 10);
            await Usuario.create({
                nome: 'Administrador Ncontas',
                email: 'admin@ncontas.com',
                senha: hashedPassword,
                tipo: 'admin',
                ativo: true
            });
            console.log('✅ Usuário admin criado: admin@ncontas.com / admin123');
        }

        server.listen(PORT, () => {
            console.log(`🚀 Servidor rodando na porta ${PORT}`);
            console.log(`📊 Acesse: http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ Erro ao iniciar:', error);
        process.exit(1);
    }
}

startServer();
