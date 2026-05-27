const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const { Sequelize, DataTypes, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const moment = require('moment');
const cors = require('cors');
const multer = require('multer');

// ==================== CONFIGURAÇÃO INICIAL ====================
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares básicos
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cors());

// Sessão (compatível com produção)
app.use(session({
    secret: process.env.SESSION_SECRET || 'sistema-gestao-secret-mysql',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Configuração do EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== CONFIGURAÇÃO DO MULTER (UPLOAD) ====================
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
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

// Modelo Usuario (completo)
const Usuario = sequelize.define('Usuario', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nome: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(255), unique: true, allowNull: false },
    senha: { type: DataTypes.STRING(255), allowNull: false },
    tipo: { type: DataTypes.ENUM('admin', 'gerente', 'atendente', 'tecnico'), defaultValue: 'atendente' },
    ativo: { type: DataTypes.BOOLEAN, defaultValue: true }
}, { tableName: 'usuarios', timestamps: true });

// Modelo Solicitacao (completo, com campo codigo e historico)
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
    anexos: { type: DataTypes.JSON, defaultValue: [] },
    historico: { type: DataTypes.JSON, defaultValue: [] },
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

// Modelo Atendimento (mantido igual)
const Atendimento = sequelize.define('Atendimento', {
    idAtendimento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    Cliente: { type: DataTypes.STRING(255), allowNull: false },
    Reposnavel: { type: DataTypes.STRING(255), allowNull: false },
    DataAtendimento: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
    Hora: { type: DataTypes.TIME, defaultValue: () => moment().format('HH:mm:ss') },
    Observacao: { type: DataTypes.TEXT }
}, { tableName: 'atendimento', timestamps: true });

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

// ==================== ROTAS DE AUTENTICAÇÃO ====================
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
                if (err) {
                    return res.status(500).json({ tipo: "Falha", error: "Erro na sessão" });
                }
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
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.status(500).json({ tipo: "Falha", error: "Erro interno" });
        }
        res.render('login', { error: 'Erro ao fazer login' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ==================== ROTAS PRINCIPAIS ====================
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

        const solicitacoesRecentes = await Solicitacao.findAll({
            limit: 5,
            order: [['createdAt', 'DESC']]
        });

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

// ==================== ROTAS DE SOLICITAÇÕES ====================
app.get('/solicitacoes', requireAuth, async (req, res) => {
    try {
        const { status, tipo, prioridade, page = 1 } = req.query;
        const limit = 10;
        const offset = (page - 1) * limit;
        let where = {};
        if (status && status !== 'todos') where.status = status;
        if (tipo && tipo !== 'todos') where.tipo = tipo;
        if (prioridade && prioridade !== 'todos') where.prioridade = prioridade;

        const { count, rows } = await Solicitacao.findAndCountAll({
            where,
            limit,
            offset,
            order: [['createdAt', 'DESC']]
        });
        const totalPages = Math.ceil(count / limit);

        res.render('solicitacoes', {
            user: req.session.user,
            solicitacoes: rows,
            currentPage: parseInt(page),
            totalPages,
            filters: { status, tipo, prioridade },
            totalCount: count
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar solicitações' });
    }
});

app.get('/solicitacoes/nova', requireAuth, (req, res) => {
    res.render('nova-solicitacao', { user: req.session.user, error: null });
});

app.post('/solicitacoes/nova', requireAuth, async (req, res) => {
    try {
        const { cliente_nome, cliente_email, cliente_telefone, titulo, descricao, categoria } = req.body;
        if (!cliente_nome || !cliente_email || !titulo || !descricao) {
            return res.status(400).json({ success: false, error: 'Todos os campos obrigatórios devem ser preenchidos' });
        }

        const novaSolicitacao = await Solicitacao.create({
            cliente_nome,
            cliente_email,
            cliente_telefone: cliente_telefone || '',
            titulo,
            descricao,
            tipo: 'reclamacao',
            categoria: categoria || 'outro',
            historico: [{
                data: new Date(),
                autor: req.session.user?.nome || 'Sistema',
                mensagem: 'Solicitação criada'
            }]
        });

        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.json({ success: true, message: 'Solicitação criada com sucesso!', id: novaSolicitacao.id, codigo: novaSolicitacao.codigo });
        }
        res.redirect('/solicitacoes');
    } catch (error) {
        console.error(error);
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.status(500).json({ success: false, error: 'Erro ao criar solicitação: ' + error.message });
        }
        res.render('nova-solicitacao', { user: req.session.user, error: 'Erro ao criar solicitação' });
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

// Atualizar status (PUT)
app.put('/solicitacoes/:id/status', requireAuth, async (req, res) => {
    try {
        const { status } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        const statusAnterior = solicitacao.status;
        solicitacao.status = status;
        solicitacao.data_conclusao = status === 'resolvido' ? new Date() : null;

        const historico = solicitacao.historico || [];
        historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Status alterado de ${statusAnterior} para ${status}`
        });
        solicitacao.historico = historico;
        await solicitacao.save();

        res.json({ success: true, solicitacao: solicitacao.toJSON() });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar status' });
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
        const historico = solicitacao.historico || [];
        historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Responsável alterado de ${responsavelAnterior || 'ninguém'} para ${responsavel}`
        });
        solicitacao.historico = historico;
        await solicitacao.save();

        res.json({ success: true, solicitacao: solicitacao.toJSON() });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar responsável' });
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

        res.json({ success: true, solicitacao: solicitacao.toJSON() });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao agendar atendimento' });
    }
});

// Histórico
app.get('/solicitacoes/:id/historico', requireAuth, async (req, res) => {
    try {
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        res.json(solicitacao?.historico || []);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
});

// Anexos (listar)
app.get('/solicitacoes/:id/anexos', requireAuth, async (req, res) => {
    try {
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        res.json(solicitacao?.anexos || []);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar anexos' });
    }
});

// Adicionar nota (no histórico)
app.post('/solicitacoes/:id/nota', requireAuth, async (req, res) => {
    try {
        const { nota, autor } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        const historico = solicitacao.historico || [];
        historico.push({ data: new Date(), autor: autor || req.session.user.nome, mensagem: `Nota adicionada: ${nota}` });
        solicitacao.historico = historico;
        await solicitacao.save();

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar nota' });
    }
});

// Upload de anexo
app.post('/solicitacoes/:id/anexos', requireAuth, upload.single('anexo'), async (req, res) => {
    try {
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        if (!solicitacao) return res.status(404).json({ error: 'Solicitação não encontrada' });

        const anexoItem = {
            nome: req.file.originalname,
            caminho: `anexo_${Date.now()}_${req.file.originalname}`,
            tipo: req.file.mimetype,
            tamanho: req.file.size,
            data: new Date()
        };
        const anexos = solicitacao.anexos || [];
        anexos.push(anexoItem);
        solicitacao.anexos = anexos;

        const historico = solicitacao.historico || [];
        historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Anexo adicionado: ${req.file.originalname}`
        });
        solicitacao.historico = historico;
        await solicitacao.save();

        res.json({ success: true, anexo: anexoItem });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar anexo' });
    }
});

// Rota pública para criação de conta (registro)
app.post('/registro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if (!nome || !email || !senha) {
            return res.status(400).json({ success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
        }
        // Verificar se e-mail já existe
        const existingUser = await Usuario.findOne({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'E-mail já registrado.' });
        }
        const hashedPassword = bcrypt.hashSync(senha, 10);
        // Criar usuário com tipo 'atendente' ou um novo tipo 'cliente' – aqui usaremos 'atendente'
        const newUser = await Usuario.create({
            nome,
            email,
            senha: hashedPassword,
            tipo: 'atendente',   // Ou adicione 'cliente' ao enum se desejar
            ativo: true
        });
        res.status(201).json({ success: true, message: 'Usuário criado com sucesso.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Erro interno ao criar usuário.' });
    }
});

// Notificar cliente (simulação)
app.post('/solicitacoes/:id/notificar', requireAuth, async (req, res) => {
    try {
        const { metodo } = req.body;
        const solicitacao = await Solicitacao.findByPk(req.params.id);
        const historico = solicitacao.historico || [];
        historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Notificação enviada ao cliente via ${metodo}`
        });
        solicitacao.historico = historico;
        await solicitacao.save();

        res.json({ success: true, message: `Notificação enviada com sucesso via ${metodo}` });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar notificação' });
    }
});

// Editar solicitação (completo)
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

        const historico = solicitacao.historico || [];
        historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Solicitação atualizada por ${req.session.user.nome}`
        });
        solicitacao.historico = historico;
        await solicitacao.save();

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar solicitação' });
    }
});

// Excluir solicitação
app.delete('/solicitacoes/:id/excluir', requireAuth, async (req, res) => {
    try {
        await Solicitacao.destroy({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir solicitação' });
    }
});

// ==================== API ROUTES (ESTATÍSTICAS, RELATÓRIOS, USUÁRIOS) ====================
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

app.get('/api/relatorio', requireAuth, async (req, res) => {
    try {
        let where = {};
        if (req.query.inicio) where.data_abertura = { [Op.gte]: new Date(req.query.inicio) };
        if (req.query.fim) where.data_abertura = { ...where.data_abertura, [Op.lte]: new Date(req.query.fim) };
        if (req.query.status && req.query.status !== 'all') where.status = req.query.status;

        const solicitacoes = await Solicitacao.findAll({ where, order: [['data_abertura', 'DESC']] });
        res.json(solicitacoes);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
});

// CRUD de usuários via API
app.get('/api/usuarios', requireAuth, async (req, res) => {
    try {
        const usuarios = await Usuario.findAll({ attributes: { exclude: ['senha'] } });
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuários' });
    }
});

app.get('/api/usuarios/:id', requireAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findByPk(req.params.id, { attributes: { exclude: ['senha'] } });
        res.json(usuario);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuário' });
    }
});

app.post('/api/usuarios', requireAuth, async (req, res) => {
    try {
        const { nome, email, senha, tipo } = req.body;
        const hashedPassword = bcrypt.hashSync(senha, 10);
        const usuario = await Usuario.create({ nome, email, senha: hashedPassword, tipo, ativo: true });
        const { senha: _, ...usuarioSemSenha } = usuario.toJSON();
        res.json({ success: true, usuario: usuarioSemSenha });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar usuário' });
    }
});

app.put('/api/usuarios/:id', requireAuth, async (req, res) => {
    try {
        const { nome, email, tipo, ativo, senha } = req.body;
        const updateData = { nome, email, tipo, ativo };
        if (senha && senha.trim()) updateData.senha = bcrypt.hashSync(senha, 10);

        const usuario = await Usuario.findByPk(req.params.id);
        if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado' });
        await usuario.update(updateData);
        const { senha: _, ...usuarioSemSenha } = usuario.toJSON();
        res.json({ success: true, usuario: usuarioSemSenha });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
});

app.delete('/api/usuarios/:id', requireAuth, async (req, res) => {
    try {
        await Usuario.destroy({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir usuário' });
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

        // Criar admin padrão se não existir
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

        app.listen(PORT, () => {
            console.log(`🚀 Servidor rodando na porta ${PORT}`);
            console.log(`📊 Acesse: http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ Erro ao iniciar:', error);
        process.exit(1);
    }
}

startServer();

// ==================== EXPORTAÇÃO PARA VERCEL (OPCIONAL) ====================
// Caso queira usar como serverless, descomente o bloco abaixo e comente o startServer()
/*
let serverReady = false;
module.exports = async (req, res) => {
    if (!serverReady) {
        await sequelize.authenticate();
        await sequelize.sync({ alter: false });
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
        }
        serverReady = true;
    }
    return app(req, res);
};
*/