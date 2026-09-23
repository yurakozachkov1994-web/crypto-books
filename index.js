export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
      'Access-Control-Allow-Credentials': 'true'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const initDataStr = request.headers.get('X-Telegram-Init-Data') || '';
      const user = parseTelegramInitData(initDataStr);
      
      // Задайте ваш реальный Telegram ID как админа (или он подтянется автоматически)
      const ADMIN_ID = 512345678; // Замените на ваш ID, либо условие ниже сделает первого/указанного
      const isAdmin = user && (user.id === ADMIN_ID || user.id === 123456789); // Укажите свой ID

      const path = url.pathname;
      let body = {};
      if (request.method === 'POST') {
        try { body = await request.json(); } catch(e) {}
      }

      // --- 1. BOOTSTRAP (Инициализация при запуске мини-приложения) ---
      if (path === '/api/bootstrap' && request.method === 'GET') {
        if (!user) {
          return json({ error: 'Unauthorized' }, 401, corsHeaders);
        }

        // Проверяем/создаем пользователя в базе
        let dbUser = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
        
        // Обработка реферального параметра из start_param (если есть)
        let refParam = url.searchParams.get('ref');
        
        if (!dbUser) {
          let referredBy = null;
          if (refParam && refParam.startsWith('ref_')) {
            const potentialRefId = parseInt(refParam.replace('ref_', ''));
            if (potentialRefId && potentialRefId !== user.id) {
              const refUserCheck = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(potentialRefId).first();
              if (refUserCheck) referredBy = potentialRefId;
            }
          }

          await env.DB.prepare(
            "INSERT INTO users (id, name, balance, referred_by, created_at) VALUES (?, ?, 0, ?, ?)"
          ).bind(user.id, user.first_name || 'Игрок', referredBy, Date.now()).run();

          dbUser = { id: user.id, name: user.first_name || 'Игрок', balance: 0, completed_tasks: 0 };
        }

        // Загружаем активные задания
        const tasks = await env.DB.prepare("SELECT id, title, type, reward FROM tasks").all();
        
        // Загружаем реферальную статистику
        const refCountRes = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?").bind(user.id).first();
        const refHistory = await env.DB.prepare("SELECT description, amount, created_at FROM referrals WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all();

        const responseData = {
          user: {
            id: dbUser.id,
            name: dbUser.name,
            balance: dbUser.balance,
            completed_tasks: dbUser.completed_tasks
          },
          tasks: tasks.results || [],
          ref: {
            link: `https://t.me/${env.BOT_USERNAME || 'your_bot'}/app?startapp=ref_${user.id}`,
            count: refCountRes?.cnt || 0,
            history: refHistory.results || []
          }
        };

        // Если админ — подгружаем админ-панель
        if (isAdmin || user.id === 123456789) {
          const uCount = await env.DB.prepare("SELECT COUNT(*) as c FROM users").first();
          const tCount = await env.DB.prepare("SELECT COUNT(*) as c FROM tasks").first();
          const wCount = await env.DB.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status = 'pending'").first();
          
          const deposits = await env.DB.prepare("SELECT d.*, u.name as user_name FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'pending'").all();
          const withdrawals = await env.DB.prepare("SELECT w.*, u.name as user_name FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'pending'").all();
          const usersList = await env.DB.prepare("SELECT id, name, balance FROM users ORDER BY created_at DESC LIMIT 15").all();

          responseData.admin = {
            users: uCount?.c || 0,
            tasks: tCount?.c || 0,
            withdrawals: wCount?.c || 0,
            deposit_items: deposits.results || [],
            withdrawal_items: withdrawals.results || [],
            user_items: usersList.results || []
          };
        }

        return json(responseData, 200, corsHeaders);
      }

      // --- 2. ЗАДАНИЯ: СТАРТ И ПРОВЕРКА ---
      if (path === '/api/tasks/start' && request.method === 'POST') {
        const { task_id } = body;
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
        if (!task) return json({ error: 'Задание не найдено' }, 404, corsHeaders);
        return json({ url: task.url }, 200, corsHeaders);
      }

      if (path === '/api/tasks/complete' && request.method === 'POST') {
        const { task_id } = body;
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(task_id).first();
        if (!task) return json({ error: 'Задание не найдено' }, 404, corsHeaders);

        // Проверка: выполнялось ли уже задание этим пользователем
        const existing = await env.DB.prepare("SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?").bind(user.id, task_id).first();
        if (existing && existing.status === 'completed') {
          return json({ error: 'Вы уже выполнили это задание' }, 400, corsHeaders);
        }

        // Проверка подписки в Telegram через Bot API (если указан username канала/группы)
        if (task.chat_username && env.BOT_TOKEN) {
          try {
            const chatUn = task.chat_username.startsWith('@') ? task.chat_username : '@' + task.chat_username;
            const tgRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatUn)}&user_id=${user.id}`);
            const tgJson = await tgRes.json();
            
            if (!tgJson.ok || !['creator', 'administrator', 'member'].includes(tgJson.result?.status)) {
              return json({ error: 'Вы не подписаны на канал/группу!' }, 400, corsHeaders);
            }
          } catch(e) {
            console.error('Telegram API check error:', e);
          }
        }

        // Начисляем награду пользователю
        await env.DB.prepare("UPDATE users SET balance = balance + ?, completed_tasks = completed_tasks + 1 WHERE id = ?").bind(task.reward, user.id).run();
        
        // Фиксируем выполнение
        await env.DB.prepare("INSERT OR REPLACE INTO user_tasks (user_id, task_id, status) VALUES (?, ?, 'completed')").bind(user.id, task_id).run();

        // Реферальный бонус (15% от награды за задание)
        const currentUser = await env.DB.prepare("SELECT referred_by FROM users WHERE id = ?").bind(user.id).first();
        if (currentUser && currentUser.referred_by) {
          const refBonus = task.reward * 0.15;
          await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(refBonus, currentUser.referred_by).run();
          await env.DB.prepare("INSERT INTO referrals (user_id, referred_id, description, amount, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(currentUser.referred_by, user.id, `Бонус 15% за задание от ID ${user.id}`, refBonus, Date.now()).run();
        }

        return json({ message: `Задание выполнено! Получено +${task.reward} GRAM` }, 200, corsHeaders);
      }

      // --- 3. РЕКЛАМА ADSGRAM ---
      if (path === '/api/ads/reward' && request.method === 'POST') {
        const dbUser = await env.DB.prepare("SELECT last_ad_time FROM users WHERE id = ?").bind(user.id).first();
        const now = Date.now();
        // Ограничение: не чаще чем раз в 5 минут
        if (dbUser && (now - dbUser.last_ad_time < 300 * 1000)) {
          return json({ error: 'Подождите перед просмотром следующей рекламы' }, 400, corsHeaders);
        }

        const adReward = 0.005; // Награда за просмотр рекламы
        await env.DB.prepare("UPDATE users SET balance = balance + ?, last_ad_time = ? WHERE id = ?").bind(adReward, now, user.id).run();
        return json({ message: `Бонус за рекламу зачислен: +${adReward} GRAM` }, 200, corsHeaders);
      }

      // --- 4. ДЕПОЗИТЫ И ВЫВОДЫ ---
      if (path === '/api/deposits' && request.method === 'POST') {
        const { amount } = body;
        if (!amount || amount <= 0) return json({ error: 'Неверная сумма' }, 400, corsHeaders);

        const depositId = 'dep_' + Math.random().toString(36).substring(2, 10);
        const reference = 'ref_' + Math.random().toString(36).substring(2, 9);
        const amountNano = Math.round(amount * 1e9).toString(); // В нанотоннах

        await env.DB.prepare("INSERT INTO deposits (id, user_id, amount, amount_nano, reference, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
          .bind(depositId, user.id, amount, amountNano, reference, Date.now()).run();

        return json({ id: depositId, reference, amount_nano }, 200, corsHeaders);
      }

      if (path.match(/^\/api\/deposits\/[^/]+\/status$/) && request.method === 'GET') {
        const depId = path.split('/')[3];
        const dep = await env.DB.prepare("SELECT * FROM deposits WHERE id = ? AND user_id = ?").bind(depId, user.id).first();
        if (!dep) return json({ error: 'Не найдено' }, 404, corsHeaders);
        return json({ status: dep.status, amount: dep.amount }, 200, corsHeaders);
      }

      if (path === '/api/withdrawals' && request.method === 'POST') {
        const { amount, address } = body;
        if (!amount || amount < 1 || !address) return json({ error: 'Неверные данные для вывода (мин. 1 GRAM)' }, 400, corsHeaders);

        const dbUser = await env.DB.prepare("SELECT balance FROM users WHERE id = ?").bind(user.id).first();
        if (!dbUser || dbUser.balance < amount) return json({ error: 'Недостаточно средств на балансе' }, 400, corsHeaders);

        // Списываем сразу
        await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").bind(amount, user.id).run();
        
        const withdrawId = 'wd_' + Math.random().toString(36).substring(2, 10);
        await env.DB.prepare("INSERT INTO withdrawals (id, user_id, amount, address, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
          .bind(withdrawId, user.id, amount, address, Date.now()).run();

        return json({ message: 'Заявка на вывод создана. Ожидайте подтверждения.' }, 200, corsHeaders);
      }

      // --- 5. АДМИН-ПАНЕЛЬ (УПРАВЛЕНИЕ) ---
      if (path.startsWith('/api/admin/')) {
        // Проверка прав администратора
        if (!isAdmin && user.id !== 123456789) {
          return json({ error: 'Доступ запрещен' }, 403, corsHeaders);
        }

        // Создание задания админом
        if (path === '/api/admin/tasks' && request.method === 'POST') {
          const { title, type, chat_username, url, reward } = body;
          const taskId = 't_' + Math.random().toString(36).substring(2, 8);
          await env.DB.prepare("INSERT INTO tasks (id, title, type, chat_username, url, reward, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(taskId, title, type, chat_username, url, reward, Date.now()).run();
          return json({ message: 'Задание успешно создано' }, 200, corsHeaders);
        }

        // Подтверждение / отклонение депозита
        if (path.match(/^\/api\/admin\/deposits\/[^/]+$/) && request.method === 'POST') {
          const depId = path.split('/')[4];
          const { status } = body; // approved / rejected
          const dep = await env.DB.prepare("SELECT * FROM deposits WHERE id = ?").bind(depId).first();
          
          if (dep && dep.status === 'pending') {
            await env.DB.prepare("UPDATE deposits SET status = ? WHERE id = ?").bind(status, depId).run();
            if (status === 'approved') {
              // Зачисляем баланс пользователю
              await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(dep.amount, dep.user_id).run();
              
              // Реферальный бонус (10% рефереру от пополнения)
              const depUser = await env.DB.prepare("SELECT referred_by FROM users WHERE id = ?").bind(dep.user_id).first();
              if (depUser && depUser.referred_by) {
                const refBonus = dep.amount * 0.10;
                await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(refBonus, depUser.referred_by).run();
                await env.DB.prepare("INSERT INTO referrals (user_id, referred_id, description, amount, created_at) VALUES (?, ?, ?, ?, ?)")
                  .bind(depUser.referred_by, dep.user_id, `Бонус 10% от пополнения ID ${dep.user_id}`, refBonus, Date.now()).run();
              }
            }
          }
          return json({ success: true }, 200, corsHeaders);
        }

        // Подтверждение / отклонение вывода
        if (path.match(/^\/api\/admin\/withdrawals\/[^/]+$/) && request.method === 'POST') {
          const wdId = path.split('/')[4];
          const { status } = body; // approved / rejected
          const wd = await env.DB.prepare("SELECT * FROM withdrawals WHERE id = ?").bind(wdId).first();
          
          if (wd && wd.status === 'pending') {
            await env.DB.prepare("UPDATE withdrawals SET status = ? WHERE id = ?").bind(status, wdId).run();
            if (status === 'rejected') {
              // Возвращаем средства на баланс при отклонении
              await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(wd.amount, wd.user_id).run();
            }
          }
          return json({ success: true }, 200, corsHeaders);
        }
      }

      return json({ error: 'Not Found' }, 404, corsHeaders);

    } catch (err) {
      console.error(err);
      return json({ error: err.message || 'Internal Server Error' }, 500, corsHeaders);
    }
  }
};

function parseTelegramInitData(initDataStr) {
  if (!initDataStr) return null;
  try {
    const params = new URLSearchParams(initDataStr);
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    return null;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
