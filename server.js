const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');

const app         = express();
const DB_FILE     = path.join(__dirname, 'users.json');
const BUDGET_FILE = path.join(__dirname, 'budget_data.json');

// ── JSON 파일 DB (users) ──
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

// ── 가계부 데이터 ──
const DEFAULT_FIXED = [
  ["월세",             "주거/관리비","재이",   990000,"계좌이체",   "10일",""],
  ["코웨이 침대",      "주거/관리비","재이",   111999,"신용카드",   "10일","카드자동"],
  ["해피빈(기부)",     "기타지출",   "재이",    10000,"신용카드",   "","기부"],
  ["적십자(기부)",     "기타지출",   "재이",    20000,"자동이체",   "","기부"],
  ["LG 폰요금",        "통신",       "재이",   141180,"신용카드",   "",""],
  ["구글드라이브",     "통신",       "재이",     2400,"신용카드",   "","구독"],
  ["카톡클라우드",     "통신",       "재이",     5100,"신용카드",   "","구독"],
  ["흥화(보험)",       "저축/보험",  "재이",    10217,"자동이체",   "",""],
  ["흥국(보험)",       "저축/보험",  "재이",   109727,"자동이체",   "",""],
  ["실비(한화손보)",   "저축/보험",  "재이",    69408,"자동이체",   "10일",""],
  ["한화손보",         "저축/보험",  "재이",    66330,"신용카드",   "10일",""],
  ["곗돈",             "저축/보험",  "재이",  1800000,"계좌이체",   "25일",""],
  ["소진공",           "기타지출",   "재이",   120071,"계좌이체",   "15일","대출상환"],
  ["소진공 저신용",    "기타지출",   "재이",   300000,"계좌이체",   "15일","대출상환"],
  ["소진공 대리대출",  "기타지출",   "재이",   184000,"계좌이체",   "21일","대출상환"],
  ["미소대출",         "기타지출",   "재이",   164400,"계좌이체",   "25일","대출상환"],
  ["국민대출",         "기타지출",   "재이",   768962,"자동이체",   "25일","대출상환"],
  ["쿠쿠(정수기)",     "주거/관리비","성천",    29000,"자동이체",   "20일",""],
  ["소노스테이션",     "여가/문화",  "성천",    66000,"기업신용카드","25일",""],
  ["타이칸",           "교통",       "성천", 2000000,"계좌이체",   "20일","리스/할부"],
  ["삼성화재(보험)",   "저축/보험",  "성천",    11000,"자동이체",   "",""],
  ["롯데손보(보험)",   "저축/보험",  "성천",    12000,"자동이체",   "",""],
  ["한화손보(보험)",   "저축/보험",  "성천",    40000,"자동이체",   "",""],
  ["현대해상(보험)",   "저축/보험",  "성천",    20000,"자동이체",   "",""],
  ["흥국생명(보험)",   "저축/보험",  "성천",   130000,"자동이체",   "",""],
  ["LG 폰요금",        "통신",       "성천",   151000,"기업신용카드","12일",""],
  ["코웨이",           "주거/관리비","성천",    33900,"삼성신용카드","20일",""],
  ["노란우산",         "저축/보험",  "성천",   100000,"자동이체",   "","소기업공제"],
  ["쿠쿠(공기청정기)","주거/관리비","성천",    26900,"자동이체",   "25일",""],
  ["소상공 저신용",    "기타지출",   "성천",    99000,"계좌이체",   "","대출상환"],
  ["소상공",           "기타지출",   "성천",   242000,"계좌이체",   "","대출상환"],
];

function readBudget() {
  if (!fs.existsSync(BUDGET_FILE)) {
    const data = {
      transactions: [],
      fixed: DEFAULT_FIXED.map(([name, cat, member, amt, method, day, note]) => ({
        name, cat, member, amounts: Array(12).fill(amt), method, day, note
      }))
    };
    writeBudget(data);
    return data;
  }
  return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
}

function writeBudget(data) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(data, null, 2));
}

// ── SSE 브로드캐스트 ──
const sseClients = new Set();

function broadcastUpdate() {
  const msg = `data: ${JSON.stringify({ type: 'update', ts: Date.now() })}\n\n`;
  for (const client of [...sseClients]) {
    try { client.write(msg); } catch (e) { sseClients.delete(client); }
  }
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
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  const user = db.findOne(u => u.id === req.session.userId);
  if (!user) { req.session.destroy(); return res.status(401).json({ error: 'unauthorized' }); }
  if (user.status === 'pending')  return res.status(403).json({ error: 'pending' });
  if (user.status === 'rejected') return res.status(403).json({ error: 'rejected' });
  if (user.role === 'admin' || user.status === 'approved') return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function requireApprovedPage(req, res, next) {
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
app.get('/budget',   requireApprovedPage, send('budget.html'));
app.get('/admin',    requireAdmin,        send('admin.html'));
app.get('/pending',  requireLogin,        send('pending.html'));
app.get('/rejected', requireLogin,        send('rejected.html'));
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

// ── 가계부 API ──
app.get('/api/budget', requireApproved, (req, res) => {
  res.json(readBudget());
});

app.post('/api/transactions', requireApproved, (req, res) => {
  const { date, type, member, cat, amount, detail, method, memo } = req.body;
  if (!date || !amount) return res.json({ success: false, message: '날짜와 금액은 필수입니다.' });
  const budget = readBudget();
  const tx = {
    id: Date.now().toString(),
    date, type, member, cat,
    amount: Number(amount),
    detail: detail || '',
    method: method || '',
    memo:   memo   || ''
  };
  budget.transactions.push(tx);
  writeBudget(budget);
  broadcastUpdate();
  res.json({ success: true, tx });
});

app.delete('/api/transactions/:id', requireApproved, (req, res) => {
  const budget = readBudget();
  const before = budget.transactions.length;
  budget.transactions = budget.transactions.filter(t => t.id !== req.params.id);
  if (budget.transactions.length < before) {
    writeBudget(budget);
    broadcastUpdate();
  }
  res.json({ success: true });
});

app.put('/api/fixed', requireApproved, (req, res) => {
  const { fixed } = req.body;
  if (!Array.isArray(fixed)) return res.json({ success: false, message: '잘못된 데이터 형식입니다.' });
  const budget = readBudget();
  budget.fixed = fixed;
  writeBudget(budget);
  broadcastUpdate();
  res.json({ success: true });
});

// ── SSE 실시간 업데이트 ──
app.get('/api/events', requireApproved, (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: {"type":"connected"}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 가계부 서버 실행 중: http://localhost:${PORT}\n`);
});
