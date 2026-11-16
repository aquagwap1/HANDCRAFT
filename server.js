const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');
const seed = require('./data.json');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'handcraft-diploma-secret';
const STATUSES = ['new', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled'];

const db = new DatabaseSync(path.join(__dirname, 'handcraft.db'));
db.exec('PRAGMA foreign_keys = ON');

function inTransaction(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer',
  shop TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price REAL NOT NULL
);
`);

function fillDatabase() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count > 0) return;

  const userIds = {};
  const addUser = db.prepare('INSERT INTO users (name, email, password, role, shop) VALUES (?, ?, ?, ?, ?)');
  seed.users.forEach((u) => {
    const hash = bcrypt.hashSync(u.password, 10);
    userIds[u.key] = addUser.run(u.name, u.email, hash, u.role, u.shop || null).lastInsertRowid;
  });

  const catIds = {};
  const addCat = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)');
  seed.categories.forEach((c) => {
    catIds[c.slug] = addCat.run(c.name, c.slug).lastInsertRowid;
  });

  const addProduct = db.prepare(
    'INSERT INTO products (seller_id, category_id, name, description, price, stock, image) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  seed.products.forEach((p) => {
    addProduct.run(userIds[p.seller], catIds[p.category], p.name, p.description, p.price, p.stock, p.image);
  });
}

fillDatabase();

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function needText(value, min, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (text.length < min || text.length > max) {
    throw fail(400, `${label}: от ${min} до ${max} символов`);
  }
  return text;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, shop: u.shop };
}

function findUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function startSession(res, userId) {
  const token = jwt.sign({ id: userId }, SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
}

function currentUser(req) {
  const token = req.cookies.token;
  if (!token) return null;
  try {
    const data = jwt.verify(token, SECRET);
    const user = findUser(data.id);
    return user && !user.blocked ? user : null;
  } catch (e) {
    return null;
  }
}

function auth(req, res, next) {
  const user = currentUser(req);
  if (!user) return next(fail(401, 'Войдите в аккаунт'));
  req.user = user;
  next();
}

function onlyRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return next(fail(403, 'Недостаточно прав'));
    next();
  };
}

const PRODUCT_SQL = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, COALESCE(u.shop, u.name) AS shop
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN users u ON u.id = p.seller_id`;

const SORTS = {
  cheap: 'p.price ASC',
  expensive: 'p.price DESC',
  new: 'p.id DESC'
};

function findProducts(filters) {
  const where = [];
  const params = [];
  if (filters.onlyPublished) where.push("p.status = 'published'");
  if (filters.sellerId) {
    where.push('p.seller_id = ?');
    params.push(filters.sellerId);
  }
  if (filters.category) {
    where.push('c.slug = ?');
    params.push(filters.category);
  }
  if (filters.q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  const sql = `${PRODUCT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${SORTS[filters.sort] || SORTS.new}`;
  return db.prepare(sql).all(...params);
}

function readProduct(body) {
  const price = Number(body.price);
  const stock = Number(body.stock);
  const categoryId = Number(body.categoryId);
  const image = String(body.image || '').trim();
  if (!(price >= 0)) throw fail(400, 'Некорректная цена');
  if (!Number.isInteger(stock) || stock < 0) throw fail(400, 'Некорректное количество');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw fail(400, 'Выберите категорию');
  if (!/^https?:\/\//i.test(image)) throw fail(400, 'Укажите ссылку на фото, начинающуюся с http');
  return {
    name: needText(body.name, 2, 120, 'Название'),
    description: needText(body.description, 10, 2000, 'Описание'),
    price,
    stock,
    categoryId,
    image,
    status: body.status === 'hidden' ? 'hidden' : 'published'
  };
}

function loadOrders(where, params) {
  const orders = db
    .prepare(
      `SELECT o.*, b.name AS buyer_name, COALESCE(s.shop, s.name) AS shop
       FROM orders o
       JOIN users b ON b.id = o.buyer_id
       JOIN users s ON s.id = o.seller_id
       ${where} ORDER BY o.id DESC`
    )
    .all(...params);
  const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  orders.forEach((order) => {
    order.items = getItems.all(order.id);
  });
  return orders;
}

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
        upgradeInsecureRequests: null
      }
    }
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
  const name = needText(req.body.name, 2, 80, 'Имя');
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'seller' ? 'seller' : 'buyer';
  if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Некорректный email');
  if (password.length < 6) throw fail(400, 'Пароль: минимум 6 символов');
  const shop = role === 'seller' ? needText(req.body.shop, 2, 80, 'Название мастерской') : null;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw fail(409, 'Этот email уже зарегистрирован');
  }
  const result = db
    .prepare('INSERT INTO users (name, email, password, role, shop) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role, shop);
  startSession(res, result.lastInsertRowid);
  res.status(201).json({ user: publicUser(findUser(result.lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password)) {
    throw fail(401, 'Неверный email или пароль');
  }
  if (user.blocked) throw fail(403, 'Аккаунт заблокирован');
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.get('/api/categories', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'published') AS total
         FROM categories c ORDER BY c.id`
      )
      .all()
  );
});

app.post('/api/categories', auth, onlyRoles('admin'), (req, res) => {
  const name = needText(req.body.name, 2, 60, 'Название');
  const slug = String(req.body.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw fail(400, 'Slug: латиница, цифры и дефис');
  try {
    db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
  } catch (e) {
    throw fail(409, 'Такая категория уже есть');
  }
  res.status(201).json({ ok: true });
});

app.delete('/api/categories/:id', auth, onlyRoles('admin'), (req, res) => {
  if (db.prepare('SELECT 1 FROM products WHERE category_id = ?').get(req.params.id)) {
    throw fail(409, 'В категории есть товары, удалить её нельзя');
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/products', (req, res) => {
  const filters = {
    onlyPublished: true,
    category: req.query.category,
    q: String(req.query.q || '').trim().slice(0, 100),
    sort: req.query.sort
  };
  res.json(findProducts(filters));
});

app.get('/api/my/products', auth, onlyRoles('seller'), (req, res) => {
  res.json(findProducts({ sellerId: req.user.id }));
});

app.get('/api/products/:id', (req, res) => {
  const product = db.prepare(`${PRODUCT_SQL} WHERE p.id = ?`).get(req.params.id);
  if (!product) throw fail(404, 'Товар не найден');
  if (product.status === 'hidden') {
    const user = currentUser(req);
    if (!user || (user.role !== 'admin' && user.id !== product.seller_id)) throw fail(404, 'Товар не найден');
  }
  res.json(product);
});

app.post('/api/products', auth, onlyRoles('seller', 'admin'), (req, res) => {
  const p = readProduct(req.body);
  const result = db
    .prepare(
      'INSERT INTO products (seller_id, category_id, name, description, price, stock, image, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(req.user.id, p.categoryId, p.name, p.description, p.price, p.stock, p.image, p.status);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

function loadOwnProduct(req) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw fail(404, 'Товар не найден');
  if (req.user.role !== 'admin' && product.seller_id !== req.user.id) {
    throw fail(403, 'Можно менять только свои товары');
  }
  return product;
}

app.put('/api/products/:id', auth, onlyRoles('seller', 'admin'), (req, res) => {
  const product = loadOwnProduct(req);
  const p = readProduct(req.body);
  db.prepare(
    'UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, stock = ?, image = ?, status = ? WHERE id = ?'
  ).run(p.categoryId, p.name, p.description, p.price, p.stock, p.image, p.status, product.id);
  res.json({ ok: true });
});

app.patch('/api/products/:id/status', auth, onlyRoles('seller', 'admin'), (req, res) => {
  const product = loadOwnProduct(req);
  const status = req.body.status === 'hidden' ? 'hidden' : 'published';
  db.prepare('UPDATE products SET status = ? WHERE id = ?').run(status, product.id);
  res.json({ ok: true });
});

app.delete('/api/products/:id', auth, onlyRoles('seller', 'admin'), (req, res) => {
  const product = loadOwnProduct(req);
  db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
  res.json({ ok: true });
});

app.post('/api/orders', auth, onlyRoles('buyer'), (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0 || items.length > 50) throw fail(400, 'Корзина пуста');
  const name = needText(req.body.name, 2, 80, 'Имя получателя');
  const phone = needText(req.body.phone, 6, 20, 'Телефон');
  const address = needText(req.body.address, 5, 250, 'Адрес доставки');
  const comment = String(req.body.comment || '').trim().slice(0, 400);

  const wanted = new Map();
  items.forEach((item) => {
    const id = Number(item.id);
    const qty = Number(item.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 100) {
      throw fail(400, 'Некорректные данные корзины');
    }
    wanted.set(id, (wanted.get(id) || 0) + qty);
  });

  const createdIds = inTransaction(() => {
    const bySeller = new Map();
    wanted.forEach((qty, id) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!product || product.status !== 'published') throw fail(400, 'Один из товаров больше не доступен');
      if (product.seller_id === req.user.id) throw fail(400, 'Нельзя заказать собственный товар');
      if (product.stock < qty) {
        throw fail(400, `Товара «${product.name}» осталось только ${product.stock} шт.`);
      }
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, id);
      const list = bySeller.get(product.seller_id) || [];
      list.push({ product, qty });
      bySeller.set(product.seller_id, list);
    });

    const ids = [];
    bySeller.forEach((list, sellerId) => {
      const total = list.reduce((sum, row) => sum + row.product.price * row.qty, 0);
      const order = db
        .prepare(
          'INSERT INTO orders (buyer_id, seller_id, total, name, phone, address, comment) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(req.user.id, sellerId, total, name, phone, address, comment);
      list.forEach((row) => {
        db.prepare('INSERT INTO order_items (order_id, product_id, title, qty, price) VALUES (?, ?, ?, ?, ?)').run(
          order.lastInsertRowid,
          row.product.id,
          row.product.name,
          row.qty,
          row.product.price
        );
      });
      ids.push(order.lastInsertRowid);
    });
    return ids;
  });

  const marks = createdIds.map(() => '?').join(',');
  res.status(201).json(loadOrders(`WHERE o.id IN (${marks})`, createdIds));
});

app.get('/api/orders', auth, (req, res) => {
  const user = req.user;
  if (user.role === 'admin') return res.json(loadOrders('', []));
  if (user.role === 'seller') return res.json(loadOrders('WHERE o.seller_id = ?', [user.id]));
  res.json(loadOrders('WHERE o.buyer_id = ?', [user.id]));
});

app.patch('/api/orders/:id', auth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) throw fail(404, 'Заказ не найден');
  const status = req.body.status;
  if (!STATUSES.includes(status)) throw fail(400, 'Недопустимый статус');

  const user = req.user;
  const sellerOwns = user.role === 'seller' && order.seller_id === user.id;
  const buyerCancels =
    user.role === 'buyer' && order.buyer_id === user.id && status === 'cancelled' && order.status === 'new';
  if (user.role !== 'admin' && !sellerOwns && !buyerCancels) throw fail(403, 'Нет доступа к заказу');
  if (order.status === 'completed' || order.status === 'cancelled') {
    throw fail(400, 'Статус этого заказа уже нельзя менять');
  }

  inTransaction(() => {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
    if (status === 'cancelled') {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      items.forEach((item) => {
        if (item.product_id) {
          db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.qty, item.product_id);
        }
      });
    }
  });

  res.json(loadOrders('WHERE o.id = ?', [order.id])[0]);
});

app.get('/api/admin/stats', auth, onlyRoles('admin'), (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    buyers: one("SELECT COUNT(*) AS n FROM users WHERE role = 'buyer'"),
    sellers: one("SELECT COUNT(*) AS n FROM users WHERE role = 'seller'"),
    products: one('SELECT COUNT(*) AS n FROM products'),
    orders: one('SELECT COUNT(*) AS n FROM orders'),
    revenue: one("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status != 'cancelled'")
  });
});

app.get('/api/admin/users', auth, onlyRoles('admin'), (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, shop, blocked, created_at FROM users ORDER BY id DESC').all());
});

app.patch('/api/admin/users/:id', auth, onlyRoles('admin'), (req, res) => {
  const user = findUser(req.params.id);
  if (!user) throw fail(404, 'Пользователь не найден');
  if (user.role === 'admin') throw fail(400, 'Администратора заблокировать нельзя');
  db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(req.body.blocked ? 1 : 0, user.id);
  res.json({ ok: true });
});

app.get('/api/admin/products', auth, onlyRoles('admin'), (req, res) => {
  res.json(findProducts({}));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ресурс не найден' });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Ошибка сервера' : err.message });
});

app.listen(PORT, () => {
  console.log(`HANDCRAFT запущен: http://localhost:${PORT}`);
});
