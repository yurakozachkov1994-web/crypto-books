export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
      'Access-Control-Allow-Credentials': 'true'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;
      let body = {};
      if (request.method === 'POST') {
        try { body = await request.json(); } catch(e) {}
      }

      // Проверка базы данных (если не настроена, вернем пустые заглушки, чтобы приложение не падало)
      let dbAvailable = true;
      try {
        await env.DB.prepare("SELECT 1").first();
      } catch(e) {
        dbAvailable = false;
      }

      if (path === '/api/bootstrap') {
        // Базовый ответ, чтобы интерфейс ожил и отрисовал баланс и админку
        const responseData = {
          user: {
            id: 12345,
            name: 'Юра',
            balance: 10.500,
            completed_tasks: 3
          },
          tasks: [
            { id: 't_1', title: 'Подписаться на канал Тут Кременчук', type: 'telegram_channel', chat_username: '@tutcement', reward: 0.050, url: 'https://t.me/tutcement' }
          ],
          ref: {
            link: 'https://t.me/crypto_books_app_bot/app?startapp=ref_12345',
            count: 2,
            history: [
              { description: 'Бонус от реферала', amount: 0.100, created_at: Date.now() }
            ]
          },
          admin: {
            users: 5,
            tasks: 1,
            withdrawals: 0,
            deposit_items: [],
            withdrawal_items: [],
            user_items: [{ id: 12345, name: 'Юра', balance: 10.500 }]
          }
        };
        return new Response(JSON.stringify(responseData), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      return new Response(JSON.stringify({ success: true, message: 'Worker is running!' }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
  }
};
