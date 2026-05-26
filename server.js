const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const { Pool }   = require('pg');
const PgSession  = require('connect-pg-simple')(session);
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── PostgreSQL 연결 ──
// Railway는 내부 URL(DATABASE_URL)과 외부 URL(DATABASE_PUBLIC_URL)을 모두 제공.
// 내부 DNS(postgres.railway.internal) 해석 실패 시 외부 URL로 폴백.
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL ? { rejectUnauthorized: false } : false
});

// ── 기본 고정지출 데이터 ──
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

// ─────────────────────────────────────────
// DB 초기화: 테이블 생성 + 기본 데이터 시드
// ─────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'user',
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL,
      type       TEXT,
      member     TEXT,
      cat        TEXT,
      amount     INTEGER DEFAULT 0,
      detail     TEXT DEFAULT '',
      method     TEXT DEFAULT '',
      memo       TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fixed_items (
      order_index INTEGER NOT NULL,
      name        TEXT NOT NULL,
      cat         TEXT,
      member      TEXT,
      amounts     JSONB NOT NULL DEFAULT '[]',
      method      TEXT DEFAULT '',
      day         TEXT DEFAULT '',
      note        TEXT DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notices (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // admin 계정이 없으면 생성
  const { rows: adminRows } = await pool.query(
    "SELECT id FROM users WHERE username = 'admin' LIMIT 1"
  );
  if (adminRows.length === 0) {
    const hash = await bcrypt.hash('admin1234', 10);
    await pool.query(
      'INSERT INTO users (username, password, name, role, status) VALUES ($1,$2,$3,$4,$5)',
      ['admin', hash, '관리자', 'admin', 'approved']
    );
    console.log('✅ 관리자 계정 생성됨  |  ID: admin  /  PW: admin1234');
  }

  // 고정지출 기본 데이터가 없으면 시드
  const { rows: cntRows } = await pool.query('SELECT COUNT(*) AS cnt FROM fixed_items');
  if (parseInt(cntRows[0].cnt) === 0) {
    for (let i = 0; i < DEFAULT_FIXED.length; i++) {
      const [name, cat, member, amt, method, day, note] = DEFAULT_FIXED[i];
      await pool.query(
        `INSERT INTO fixed_items (order_index,name,cat,member,amounts,method,day,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [i, name, cat, member, JSON.stringify(Array(12).fill(amt)), method, day, note]
      );
    }
    console.log('✅ 고정지출 기본 데이터 생성됨');
  }
}

// ─────────────────────────────────────────
// SSE
// ─────────────────────────────────────────
const sseClients = new Set();

function broadcastUpdate() {
  const msg = `data: ${JSON.stringify({ type: 'update', ts: Date.now() })}\n\n`;
  for (const client of [...sseClients]) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ─────────────────────────────────────────
// 미들웨어
// ─────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'budget-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
// Auth 헬퍼
// ─────────────────────────────────────────
async function getUser(id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

async function requireApproved(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await getUser(req.session.userId);
    if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'unauthorized' }); }
    if (user.status === 'pending')  return res.status(403).json({ error: 'pending' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'rejected' });
    if (user.role === 'admin' || user.status === 'approved') return next();
    return res.status(401).json({ error: 'unauthorized' });
  } catch (err) { next(err); }
}

async function requireApprovedPage(req, res, next) {
  try {
    if (!req.session.userId) return res.redirect('/login');
    const user = await getUser(req.session.userId);
    if (!user) { req.session.destroy(() => {}); return res.redirect('/login'); }
    if (user.status === 'pending')  return res.redirect('/pending');
    if (user.status === 'rejected') return res.redirect('/rejected');
    if (user.role === 'admin' || user.status === 'approved') return next();
    return res.redirect('/login');
  } catch (err) { next(err); }
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) return res.redirect('/login');
    const user = await getUser(req.session.userId);
    if (!user || user.role !== 'admin') return res.redirect('/');
    next();
  } catch (err) { next(err); }
}

async function requireAdminApi(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await getUser(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────
// 페이지 라우트
// ─────────────────────────────────────────
app.get('/', requireLogin, async (req, res, next) => {
  try {
    const user = await getUser(req.session.userId);
    if (!user) { req.session.destroy(() => {}); return res.redirect('/login'); }
    if (user.role === 'admin')      return res.redirect('/admin');
    if (user.status === 'approved') return res.redirect('/budget');
    if (user.status === 'pending')  return res.redirect('/pending');
    return res.redirect('/rejected');
  } catch (err) { next(err); }
});

const send = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/login',    (req, res) => req.session.userId ? res.redirect('/') : send('login.html')(req, res));
app.get('/signup',   (req, res) => req.session.userId ? res.redirect('/') : send('signup.html')(req, res));
app.get('/budget',   requireApprovedPage, send('budget.html'));
app.get('/admin',    requireAdmin,        send('admin.html'));
app.get('/pending',  requireLogin,        send('pending.html'));
app.get('/rejected', requireLogin,        send('rejected.html'));
app.get('/logout',   (req, res) => { req.session.destroy(() => {}); res.redirect('/login'); });

// ─────────────────────────────────────────
// Auth API
// ─────────────────────────────────────────
app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ success: false, message: '아이디와 비밀번호를 입력해주세요.' });

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 LIMIT 1', [username]);
    const user = rows[0];
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
  } catch (err) { next(err); }
});

app.post('/api/signup', async (req, res, next) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name)
      return res.json({ success: false, message: '모든 항목을 입력해주세요.' });
    if (username.length < 3)
      return res.json({ success: false, message: '아이디는 3자 이상이어야 합니다.' });
    if (password.length < 6)
      return res.json({ success: false, message: '비밀번호는 6자 이상이어야 합니다.' });

    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
    if (rows.length > 0)
      return res.json({ success: false, message: '이미 사용 중인 아이디입니다.' });

    await pool.query(
      'INSERT INTO users (username, password, name, role, status) VALUES ($1,$2,$3,$4,$5)',
      [username, await bcrypt.hash(password, 10), name, 'user', 'pending']
    );
    res.json({ success: true, message: '가입 신청이 완료됐어요! 관리자 승인 후 이용 가능합니다.' });
  } catch (err) { next(err); }
});

app.get('/api/me', async (req, res, next) => {
  try {
    if (!req.session.userId) return res.json({ loggedIn: false });
    const user = await getUser(req.session.userId);
    if (!user) return res.json({ loggedIn: false });
    const { password: _, ...safe } = user;
    res.json({ loggedIn: true, ...safe });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
// 관리자 API
// ─────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, name, role, status, created_at
       FROM users WHERE role != 'admin' ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/admin/users/:id/approve', requireAdmin, async (req, res, next) => {
  try {
    await pool.query("UPDATE users SET status = 'approved' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/users/:id/reject', requireAdmin, async (req, res, next) => {
  try {
    await pool.query("UPDATE users SET status = 'rejected' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
// 가계부 API
// ─────────────────────────────────────────
app.get('/api/budget', requireApproved, async (req, res, next) => {
  try {
    const { rows: txRows } = await pool.query(
      'SELECT id, date, type, member, cat, amount, detail, method, memo FROM transactions ORDER BY date ASC, created_at ASC'
    );
    const { rows: fixedRows } = await pool.query(
      'SELECT name, cat, member, amounts, method, day, note FROM fixed_items ORDER BY order_index ASC'
    );
    const fixed = fixedRows.map(f => ({
      ...f,
      amounts: Array.isArray(f.amounts) ? f.amounts : JSON.parse(f.amounts)
    }));
    fixed.forEach(f => {
      if (f.member === '본인')    f.member = '재이';
      if (f.member === '배우자') f.member = '성천';
    });
    res.json({ transactions: txRows, fixed });
  } catch (err) { next(err); }
});

app.post('/api/transactions', requireApproved, async (req, res, next) => {
  try {
    const { date, type, member, cat, amount, detail, method, memo } = req.body;
    if (!date || !amount) return res.json({ success: false, message: '날짜와 금액은 필수입니다.' });

    const id = Date.now().toString();
    const tx = {
      id, date, type, member, cat,
      amount: Number(amount),
      detail: detail || '',
      method: method || '',
      memo:   memo   || ''
    };
    await pool.query(
      `INSERT INTO transactions (id, date, type, member, cat, amount, detail, method, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, date, type, member, cat, tx.amount, tx.detail, tx.method, tx.memo]
    );
    broadcastUpdate();
    res.json({ success: true, tx });
  } catch (err) { next(err); }
});

app.delete('/api/transactions/:id', requireApproved, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM transactions WHERE id = $1', [req.params.id]);
    broadcastUpdate();
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.put('/api/fixed', requireApproved, async (req, res, next) => {
  try {
    const { fixed } = req.body;
    if (!Array.isArray(fixed)) return res.json({ success: false, message: '잘못된 데이터 형식입니다.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM fixed_items');
      for (let i = 0; i < fixed.length; i++) {
        const f = fixed[i];
        await client.query(
          `INSERT INTO fixed_items (order_index,name,cat,member,amounts,method,day,note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [i, f.name, f.cat, f.member, JSON.stringify(f.amounts), f.method, f.day || '', f.note || '']
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    broadcastUpdate();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
// 공지사항 API
// ─────────────────────────────────────────
app.get('/api/notices', requireApproved, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.content, n.created_at, n.updated_at, u.name AS author_name
       FROM notices n LEFT JOIN users u ON n.author_id = u.id
       ORDER BY n.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/notices', requireAdminApi, async (req, res, next) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.json({ success: false, message: '제목과 내용을 입력해주세요.' });
    const { rows } = await pool.query(
      'INSERT INTO notices (title, content, author_id) VALUES ($1,$2,$3) RETURNING *',
      [title, content, req.session.userId]
    );
    res.json({ success: true, notice: rows[0] });
  } catch (err) { next(err); }
});

app.put('/api/notices/:id', requireAdminApi, async (req, res, next) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.json({ success: false, message: '제목과 내용을 입력해주세요.' });
    await pool.query(
      'UPDATE notices SET title=$1, content=$2, updated_at=NOW() WHERE id=$3',
      [title, content, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/notices/:id', requireAdminApi, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM notices WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
// SSE 실시간 업데이트
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// 글로벌 에러 핸들러
// ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ 서버 오류:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

// ─────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────
if (!DB_URL) {
  console.error('❌ DATABASE_URL 또는 DATABASE_PUBLIC_URL 환경변수가 필요합니다.');
  console.error('   Railway: 프로젝트에 PostgreSQL 플러그인을 추가하면 자동 설정됩니다.');
  console.error('   로컬:    DATABASE_URL=postgresql://user:pw@localhost/dbname node server.js');
  process.exit(1);
}

// DB가 아직 준비되지 않았을 수 있으므로 최대 5회 재시도
async function startWithRetry(retries = 5, delay = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await initDB();
      app.listen(PORT, () => {
        console.log(`\n🏠 가계부 서버 실행 중: http://localhost:${PORT}\n`);
      });
      return;
    } catch (err) {
      console.error(`❌ DB 연결 실패 (${i}/${retries}): ${err.message}`);
      if (i === retries) { process.exit(1); }
      console.log(`   ${delay / 1000}초 후 재시도...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

startWithRetry();
