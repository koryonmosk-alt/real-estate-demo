export type SendTextArgs = {
  to: string;
  text: string;
};

export type SendTemplateArgs = {
  to: string;
  templateName: string;
  languageCode?: string;
  components?: unknown[];
};

export function requireWhatsappEnv() {
  const phoneId = process.env.META_WHATSAPP_PHONE_ID;
  if (!phoneId) throw new Error("META_WHATSAPP_PHONE_ID is not set");
  const token = process.env.META_GRAPH_API_TOKEN;
  if (!token) throw new Error("META_GRAPH_API_TOKEN is not set");
  return { phoneId, token };
}

function whatsappEndpoint(phoneId: string) {
  const version = process.env.META_GRAPH_API_VERSION || "v26.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("META_GRAPH_API_VERSION is invalid");
  return `https://graph.facebook.com/${version}/${phoneId}/messages`;
}

export async function sendWhatsappText(args: SendTextArgs): Promise<void> {
  const { phoneId, token } = requireWhatsappEnv();
  const res = await fetch(whatsappEndpoint(phoneId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "text",
      text: { body: args.text, preview_url: false },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed ${res.status}: ${body}`);
  }
}

export async function sendWhatsappTemplate(args: SendTemplateArgs): Promise<void> {
  const { phoneId, token } = requireWhatsappEnv();
  const res = await fetch(whatsappEndpoint(phoneId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "template",
      template: {
        name: args.templateName,
        language: { code: args.languageCode ?? "en_US" },
        components: args.components,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp template send failed ${res.status}: ${body}`);
  }
}
