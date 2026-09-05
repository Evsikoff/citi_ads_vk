# ГДЕ БЕНЗ? — VK Mini Apps

HTML5-игра на React/Vite, адаптированная для запуска во ВКонтакте и
Одноклассниках через `@vkontakte/vk-bridge`.

## Локальный запуск

Требуется современная версия Node.js с поддержкой `--experimental-strip-types`.

```bash
npm install
npm run dev
```

Production-сборка создаётся в `dist/`:

```bash
npm run build
```

Полный набор проверок:

```bash
npm run check
```

## Интеграция VK

- Инициализация: `VKWebAppInit`.
- Межэкранная и rewarded-реклама: `VKWebAppShowNativeAds`.
- Инвентарь: JSON в строковом `VKWebAppStorageSet`/`VKWebAppStorageGet`.
- Покупки: `VKWebAppShowOrderBox`.
- В режиме Одноклассников (`vk_client=ok`) IAP-кнопки скрыты, а вызов покупки
  дополнительно заблокирован в платформенном модуле.

Идентификатор каждой In-App покупки берётся только из поля `system_name`
соответствующего бустера в `src/game/boosters.json`. Текущие товары:
`fuel10l`, `money025`, `money05`.

## Настройка платежей

В панели приложения ВКонтакте в разделе «Платежи» → «Адрес для уведомлений»
нужно вручную указать callback:

```text
https://vktrade.fly.dev/vk/callback
```

Клиент игры этот URL не вызывает: уведомления на него отправляет VK.
