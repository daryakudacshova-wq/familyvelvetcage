import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { nanoid } from 'nanoid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqliteStoreFactory from 'connect-sqlite3';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLiteStore = sqliteStoreFactory(session);

const app = express();
const PORT = 3000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, nanoid() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db' }),
  secret: 'CHANGE_ME_SECRET_KEY',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
  next();
};

// ===== AUTH =====
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4)
    return res.status(400).json({ error: 'Проверь логин/пароль (мин. 4 символа)' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
                    .run(username, hash);
    req.session.userId = info.lastInsertRowid;
    req.session.username = username;
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка регистрации:', e);
    res.status(400).json({ error: 'Логин уже занят' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(400).json({ error: 'Неверный логин/пароль' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Неверный логин/пароль' });

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

// ===== TREES =====
app.get('/api/trees', auth, (req, res) => {
  const trees = db.prepare('SELECT * FROM trees WHERE owner_id = ? ORDER BY created_at DESC')
                  .all(req.session.userId);
  res.json(trees);
});

app.post('/api/trees', auth, (req, res) => {
  const id = nanoid(10);
  const name = req.body.name || 'Моё древо';
  db.prepare('INSERT INTO trees (id, owner_id, name) VALUES (?, ?, ?)')
    .run(id, req.session.userId, name);
  res.json({ id, name });
});

app.get('/api/trees/:id', (req, res) => {
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.id);
  if (!tree) return res.status(404).json({ error: 'Древо не найдено' });

  const isOwner = req.session.userId === tree.owner_id;
  if (!tree.is_public && !isOwner)
    return res.status(403).json({ error: 'Древо приватное' });

  const persons = db.prepare('SELECT * FROM persons WHERE tree_id = ?').all(tree.id);
  const relations = db.prepare('SELECT * FROM relations WHERE tree_id = ?').all(tree.id);

  res.json({ tree, persons, relations, isOwner });
});

app.post('/api/trees/:id/publish', auth, (req, res) => {
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.id);
  if (!tree || tree.owner_id !== req.session.userId)
    return res.status(403).json({ error: 'Нет доступа' });
  db.prepare('UPDATE trees SET is_public = 1 WHERE id = ?').run(tree.id);
  res.json({ ok: true });
});

app.delete('/api/trees/:id', auth, (req, res) => {
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.id);
  if (!tree || tree.owner_id !== req.session.userId)
    return res.status(403).json({ error: 'Нет доступа' });
  db.prepare('DELETE FROM relations WHERE tree_id = ?').run(tree.id);
  db.prepare('DELETE FROM persons WHERE tree_id = ?').run(tree.id);
  db.prepare('DELETE FROM trees WHERE id = ?').run(tree.id);
  res.json({ ok: true });
});

// ===== PERSONS =====
app.post('/api/trees/:id/persons', auth, upload.single('photo'), (req, res) => {
  try {
    const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.id);
    if (!tree || tree.owner_id !== req.session.userId)
      return res.status(403).json({ error: 'Нет доступа' });

    if (!req.body.name || !req.body.name.trim())
      return res.status(400).json({ error: 'Пустое имя' });

    const pid = nanoid(10);
    const photo = req.file ? '/uploads/' + req.file.filename : null;
    db.prepare('INSERT INTO persons (id, tree_id, name, photo, pos_x, pos_y) VALUES (?, ?, ?, ?, NULL, NULL)')
      .run(pid, tree.id, req.body.name.trim(), photo);

    res.json({ id: pid, name: req.body.name.trim(), photo, pos_x: null, pos_y: null });
  } catch (e) {
    console.error('Ошибка добавления персонажа:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/trees/:treeId/persons/:personId', auth, upload.single('photo'), (req, res) => {
  try {
    const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.treeId);
    if (!tree || tree.owner_id !== req.session.userId)
      return res.status(403).json({ error: 'Нет доступа' });

    const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(req.params.personId);
    if (!person) return res.status(404).json({ error: 'Персонаж не найден' });

    const newName = (req.body.name && req.body.name.trim()) || person.name;
    const newPhoto = req.file ? '/uploads/' + req.file.filename : person.photo;

    db.prepare('UPDATE persons SET name = ?, photo = ? WHERE id = ?')
      .run(newName, newPhoto, person.id);

    res.json({
      id: person.id,
      name: newName,
      photo: newPhoto,
      pos_x: person.pos_x,
      pos_y: person.pos_y
    });
  } catch (e) {
    console.error('Ошибка редактирования:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/trees/:treeId/persons/:personId/position', auth, (req, res) => {
  try {
    const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.treeId);
    if (!tree || tree.owner_id !== req.session.userId)
      return res.status(403).json({ error: 'Нет доступа' });

    const { x, y } = req.body;

    if (x === null || y === null) {
      db.prepare('UPDATE persons SET pos_x = NULL, pos_y = NULL WHERE id = ?')
        .run(req.params.personId);
      res.json({ ok: true, pinned: false });
    } else {
      db.prepare('UPDATE persons SET pos_x = ?, pos_y = ? WHERE id = ?')
        .run(x, y, req.params.personId);
      res.json({ ok: true, pinned: true });
    }
  } catch (e) {
    console.error('Ошибка закрепления:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/trees/:treeId/persons/:personId', auth, (req, res) => {
  try {
    const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.treeId);
    if (!tree || tree.owner_id !== req.session.userId)
      return res.status(403).json({ error: 'Нет доступа' });

    const toDelete = new Set([req.params.personId]);
    const queue = [req.params.personId];

    while (queue.length) {
      const cur = queue.shift();
      const rels = db.prepare(
        'SELECT * FROM relations WHERE tree_id = ? AND (from_id = ? OR to_id = ?)'
      ).all(tree.id, cur, cur);

      for (const r of rels) {
        const other = r.from_id === cur ? r.to_id : r.from_id;
        if (!toDelete.has(other)) {
          toDelete.add(other);
          queue.push(other);
        }
      }
    }

    for (const pid of toDelete) {
      db.prepare('DELETE FROM relations WHERE tree_id = ? AND (from_id = ? OR to_id = ?)')
        .run(tree.id, pid, pid);
      db.prepare('DELETE FROM persons WHERE id = ?').run(pid);
    }

    res.json({ deleted: [...toDelete] });
  } catch (e) {
    console.error('Ошибка удаления:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== RELATIONS =====
app.post('/api/trees/:id/relations', auth, (req, res) => {
  try {
    const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.id);
    if (!tree || tree.owner_id !== req.session.userId)
      return res.status(403).json({ error: 'Нет доступа' });

    const { from_id, to_id, type } = req.body;
    if (!from_id || !to_id || from_id === to_id)
      return res.status(400).json({ error: 'Некорректная связь' });

    const rid = nanoid(10);
    db.prepare('INSERT INTO relations (id, tree_id, from_id, to_id, type) VALUES (?, ?, ?, ?, ?)')
      .run(rid, tree.id, from_id, to_id, type);

    res.json({ id: rid, from_id, to_id, type });
  } catch (e) {
    console.error('Ошибка создания связи:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/trees/:treeId/relations/:rid', auth, (req, res) => {
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(req.params.treeId);
  if (!tree || tree.owner_id !== req.session.userId)
    return res.status(403).json({ error: 'Нет доступа' });
  db.prepare('DELETE FROM relations WHERE id = ?').run(req.params.rid);
  res.json({ ok: true });
});

// ===== START =====
initDb().then(() => {
  app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
}).catch(err => {
  console.error('Ошибка инициализации БД:', err);
});