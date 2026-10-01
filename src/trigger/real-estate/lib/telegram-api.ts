export class TelegramApiError extends Error {
  constructor(message: string, readonly errorCode?: number, readonly retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
  }
}

type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

export async function telegramRequest<T>(
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let envelope: TelegramEnvelope<T>;
    try {
      envelope = await response.json() as TelegramEnvelope<T>;
    } catch {
      throw new TelegramApiError(`Telegram ${method} returned an unreadable response (HTTP ${response.status})`);
    }
    if (!response.ok || envelope.ok !== true || envelope.result === undefined) {
      throw new TelegramApiError(
        `Telegram ${method} failed: ${envelope.description ?? `HTTP ${response.status}`}`,
        envelope.error_code ?? response.status,
        envelope.parameters?.retry_after,
      );
    }
    return envelope.result;
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    // Fetch errors may include the request URL, which contains the bot token.
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "network error";
    throw new TelegramApiError(`Telegram ${method} request ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

export type TelegramSentMessage = {
  message_id: number;
  chat: { id: number };
  date: number;
  text?: string;
};

export async function sendTelegramText(args: {
  chatId: string;
  text: string;
}): Promise<TelegramSentMessage> {
  if (!args.text.trim()) throw new Error("Telegram message text must not be empty");
  if (args.text.length > 4096) throw new Error("Telegram message exceeds the 4096-character limit");
  return telegramRequest<TelegramSentMessage>("sendMessage", {
    chat_id: args.chatId,
    text: args.text,
    link_preview_options: { is_disabled: true },
  });
}
