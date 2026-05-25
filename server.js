const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');

const app     = express();
const DB_FILE = path.join(__dirname, 'users.json');

// ── JSON 파일 DB ──
function readDB() {
  if (!fs.existsSync(DB_FILE)) return { users: [], nextId: 1 };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const db = {
  findOne: (pred)   => readDB().users.find(pred) || null,
  findAll: (pred)   => { const d = readDB(); return pred ? d.users.filter(pred) : d.users; },
  insert: (user) => {
    const d = readDB();
    user.id = d.nextId++;
    user.created_at = new Date().toISOString();
    d.users.push(user);
    writeDB(d);
    return user;
  },
  update: (id, patch) => {
    const d = readDB();
    const i = d.users.findIndex(u => u.id === id);
    if (i === -1) return false;
    d.users[i] = { ...d.users[i], ...patch };
    writeDB(d);
    return true;
  },
  delete: (id) => {
    const d = readDB();
    const before = d.users.length;
    d.users = d.users.filter(u => u.id !== id);
    if (d.users.length !== before) { writeDB(d); return true; }
    return false;
  }
};

// ── 최초 실행 시 admin 계정 생성 ──
if (!db.findOne(u => u.username === 'admin')) {
  db.insert({
    username: 'admin',
    password: bcrypt.hashSync('admin1234', 10),
    name: '관리자',
    role: 'admin',
    status: 'approved'
  });
  console.log('✅ 관리자 계정 생성됨  |  ID: admin  /  PW: admin1234');
}

// ── 미들웨어 ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'budget-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth 미들웨어 ──
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireApproved(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.findOne(u => u.id === req.session.userId);
  if (!user) { req.session.destroy(); return res.redirect('/login'); }
  if (user.status === 'pending')  return res.redirect('/pending');
  if (user.status === 'rejected') return res.redirect('/rejected');
  if (user.role === 'admin' || user.status === 'approved') return next();
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.findOne(u => u.id === req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).redirect('/');
  next();
}

// ── 페이지 라우트 ──
app.get('/', requireLogin, (req, res) => {
  const user = db.findOne(u => u.id === req.session.userId);
  if (!user) { req.session.destroy(); return res.redirect('/login'); }
  if (user.role === 'admin')           return res.redirect('/admin');
  if (user.status === 'approved')      return res.redirect('/budget');
  if (user.status === 'pending')       return res.redirect('/pending');
  return res.redirect('/rejected');
});

const send = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/login',    (req, res) => req.session.userId ? res.redirect('/') : send('login.html')(req, res));
app.get('/signup',   (req, res) => req.session.userId ? res.redirect('/') : send('signup.html')(req, res));
app.get('/budget',   requireApproved, send('budget.html'));
app.get('/admin',    requireAdmin,    send('admin.html'));
app.get('/pending',  requireLogin,    send('pending.html'));
app.get('/rejected', requireLogin,    send('rejected.html'));
app.get('/logout',   (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── Auth API ──
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });

  const user = db.findOne(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });

  req.session.userId = user.id;
  req.session.role   = user.role;

  let redirect = '/';
  if (user.role === 'admin')           redirect = '/admin';
  else if (user.status === 'approved') redirect = '/budget';
  else if (user.status === 'pending')  redirect = '/pending';
  else                                  redirect = '/rejected';

  res.json({ success: true, redirect });
});

app.post('/api/signup', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name)
    return res.json({ success: false, message: '모든 항목을 입력해주세요.' });
  if (username.length < 3)
    return res.json({ success: false, message: '아이디는 3자 이상이어야 합니다.' });
  if (password.length < 6)
    return res.json({ success: false, message: '비밀번호는 6자 이상이어야 합니다.' });
  if (db.findOne(u => u.username === username))
    return res.json({ success: false, message: '이미 사용 중인 아이디입니다.' });

  db.insert({
    username,
    password: await bcrypt.hash(password, 10),
    name,
    role: 'user',
    status: 'pending'
  });
  res.json({ success: true, message: '가입 신청이 완료됐어요! 관리자 승인 후 이용 가능합니다.' });
});

// ── 현재 사용자 정보 ──
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = db.findOne(u => u.id === req.session.userId);
  if (!user) return res.json({ loggedIn: false });
  const { password: _, ...safe } = user;
  res.json({ loggedIn: true, ...safe });
});

// ── 관리자 API ──
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.findAll(u => u.role !== 'admin')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(({ password: _, ...u }) => u);
  res.json(users);
});

app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  db.update(Number(req.params.id), { status: 'approved' });
  res.json({ success: true });
});

app.post('/api/admin/users/:id/reject', requireAdmin, (req, res) => {
  db.update(Number(req.params.id), { status: 'rejected' });
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  db.delete(Number(req.params.id));
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 가계부 서버 실행 중: http://localhost:${PORT}\n`);
});
