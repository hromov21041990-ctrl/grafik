export type SupportTicket = {
  id: string; category: string; title: string; message: string;
  contact_email: string; company_code: string; sender_role: string; created_at: string;
};
export type DeliveryResult = { notifiedAt: string | null; error: string | null };
export type TelegramSecrets = { token?: string; chatId?: string };

export async function sendSupportNotification(
  ticket: SupportTicket,
  secrets: TelegramSecrets,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const fail = (error: string): DeliveryResult => ({ notifiedAt: null, error });
  const token = secrets.token?.trim();
  const chatId = secrets.chatId?.trim();
  if (!token || !chatId) return fail("telegram_secrets_missing");
  if (chatId !== "-5492444972") return fail("telegram_chat_id_mismatch");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return fail("telegram_token_invalid_format");
  const categories: Record<string, string> = {
    bug: "Ошибка", question: "Вопрос", idea: "Предложение", access: "Доступ",
  };
  const text = [
    "По графику · Техподдержка 2.0",
    `Заявка: ${ticket.id}`,
    `Категория: ${categories[ticket.category] || ticket.category}`,
    `Тема: ${ticket.title}`,
    `Email: ${ticket.contact_email}`,
    `Точка: ${ticket.company_code || "не указана"}`,
    `Роль: ${ticket.sender_role}`,
    `Создана: ${ticket.created_at}`,
    "", ticket.message,
  ].join("\n");
  let message = text;
  if (text.length > 3900) {
    let preview = "";
    for (const char of text) {
      if (preview.length + char.length > 3850) break;
      preview += char;
    }
    message = preview + "\n… Полный текст сохранён в базе заявок.";
  }
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text: message, link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) return fail(`telegram_http_${response.status}`);
    let result;
    try { result = await response.json(); }
    catch { return fail("telegram_invalid_response"); }
    if (result?.ok !== true) return fail("telegram_api_rejected");
    if (!Number.isSafeInteger(result.result?.message_id) || result.result.message_id <= 0 ||
        String(result.result?.chat?.id) !== chatId)
      return fail("telegram_invalid_confirmation");
    return { notifiedAt: new Date().toISOString(), error: null };
  } catch (error) {
    // Never save exception text: network exceptions can contain the bot URL/token.
    return fail(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "telegram_timeout_delivery_unknown" : "telegram_network_error_delivery_unknown");
  }
}
