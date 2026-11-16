# HANDCRAFT

Веб-платформа для продажи изделий ручной работы.

## Текущий стек

- HTML, CSS, JavaScript
- Node.js 22.13+
- Express
- SQLite (`node:sqlite`)
- bcryptjs, JWT, cookie-parser, Helmet

> Примечание: React, Vite, PostgreSQL и Prisma указаны в техническом задании как целевой стек, но текущая версия проекта пока работает на HTML/CSS/JavaScript и SQLite.

## Запуск

1. Установите Node.js версии 22.13 или новее.
2. В терминале перейдите в папку проекта.
3. Выполните:

```bash
npm install
npm start
```

Откройте http://localhost:3000.

База `handcraft.db` создаётся автоматически при первом запуске и заполняется тестовыми данными из `data.json`.

## Тестовые аккаунты

| Роль | Email | Пароль |
|---|---|---|
| Администратор | admin@handcraft.kz | admin123 |
| Мастер | alexandr@handcraft.kz | master123 |
| Покупатель | buyer@handcraft.kz | buyer123 |
| Покупатель | sergey@handcraft.kz | buyer123 |

Это демонстрационные аккаунты для локальной проверки. Не используйте эти пароли для реальных сервисов.

## Структура

```text
HANDCRAFT/
├── docs/
│   ├── architecture.md
│   ├── competitors.md
│   └── spec.md
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data.json
├── server.js
├── package.json
└── package-lock.json
```

## Документация

- `docs/spec.md` — техническое задание.
- `docs/architecture.md` — архитектура текущей реализации.
- `docs/competitors.md` — анализ конкурентов.
