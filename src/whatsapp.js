const GRAPH = 'https://graph.facebook.com/v21.0';

export async function sendText(to, body) {
  try {
    const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    });
    if (!r.ok) console.error('WhatsApp send failed:', r.status, await r.text());
  } catch (e) {
    console.error('WhatsApp send error:', e.message);
  }
}
