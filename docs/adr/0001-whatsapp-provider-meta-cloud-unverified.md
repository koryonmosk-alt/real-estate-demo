# Use the unverified Meta Cloud API for WhatsApp, abstracted behind an adapter

We build the demo on Meta's official WhatsApp Cloud API running **unverified** (free test
number, limited to 250 unique recipients/24h, 2 numbers, 250 templates — none of which bind a
demo, and replies to people who message first do not count against the limit). Twilio was
rejected: it is a wrapper over the same Meta platform and adds $0.005/message. An own-number
gateway (no Meta) was kept as a fallback for the demo, but rejected as the primary because it
has no badge, no template/list message types, and sits in a ToS gray area we don't want the
sales demo anchored to. Business verification is deferred until a client signs — it raises
ceilings but does not gate a demo. All WhatsApp sends go through a single `send-whatsapp`
adapter so this choice is a config change, not a rebuild.