import OpenAI from 'openai';
import { getAllMenuItems } from './store.js';

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

export async function reply(history, userText, onPlaceOrder, onHumanHandoff) {
  const dbItems = await getAllMenuItems();
  
  const menuString = JSON.stringify(dbItems.map(i => ({ 
    id: i.itemId, 
    name: i.name, 
    price: i.price,
    status: i.available ? 'IN STOCK' : 'OUT OF STOCK'
  })));

  const SYSTEM = `You are the WhatsApp ordering assistant for Mama Pendo Kitchen in Westlands, Nairobi.
Opening hours: Mon to Sat, 8am to 8pm. Closed Sunday.
Delivery: Free delivery within 3km. KES 150 beyond that.
MENU (prices in KES): ${menuString}

LANGUAGE & TONE RULES (CRITICAL):
You MUST perfectly mirror the language, slang, and tone the customer uses.
- If they speak pure English, reply in English.
- If they speak pure Swahili, reply in Swahili.
- If they use Sheng (Kenyan slang) or a mix of English/Swahili, reply in that exact same mix.
- Be polite, warm, and use Kenyan expressions where appropriate (e.g., "Karibu", "Asante", "Poa").

EXAMPLES OF HOW TO REPLY:
Customer: "Niaje, naeza pata chapo mbili na soda?"
You: "Niaje! Poa sana. Ndio unaeza pata chapo mbili na soda. Unataka nikuandalie delivery?"
Customer: "Habari, mnafanya delivery gani?"
You: "Habari yako! Tunafanya free delivery within 3km, na KES 150 beyond that."
Customer: "Hi, what's on the menu?"
You: "Hi! Welcome to Mama Pendo Kitchen. We have Chapati and Beef Stew (KES 250), Pilau (KES 300), and more. What would you like?"

GENERAL RULES:
1. Only talk about Mama Pendo Kitchen: the menu, prices, hours, delivery and orders. Politely decline anything else.
2. Never invent items, prices or offers. If something is not on the menu, say so.
3. CRITICAL: If an item is marked "OUT OF STOCK", politely inform the customer that it is currently unavailable and suggest an alternative. Do NOT add out-of-stock items to the order.
4. No markdown. Use single asterisks for bold only.
5. To take an order: collect items and quantities, ask for the delivery address, then show a summary with the total in KES and ask the customer to confirm.
6. Only after the customer clearly confirms, call the place_order tool. Never call it before confirmation.
7. After place_order succeeds, tell them to check their phone for the M-Pesa prompt and enter their PIN.
8. HUMAN HANDOFF: If the customer is extremely angry, confused, or explicitly asks to speak to a human/manager, call the request_human_handoff tool immediately.`;

  const tools = [
    {
      type: 'function',
      function: {
        name: 'place_order',
        description: 'Place a confirmed order and send the customer an M-Pesa payment prompt. Call only after the customer has confirmed items, quantities and delivery address.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Menu item id' },
                  qty: { type: 'integer' },
                },
                required: ['id', 'qty'],
              },
            },
            delivery_address: { type: ['string', 'null'] },
            customer_name: { type: ['string', 'null'] },
          },
          required: ['items'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'request_human_handoff',
        description: 'Call this ONLY if the customer explicitly asks to speak to a human, a manager, or if they are extremely angry and the bot cannot resolve their issue.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why the customer wants a human' }
          },
          required: ['reason']
        }
      }
    }
  ];

  const messages = [
    { role: 'system', content: SYSTEM },
    ...history,
    { role: 'user', content: userText }
  ];

  for (let i = 0; i < 4; i++) {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL,
      messages: messages,
      tools: tools,
      max_tokens: 500,
    });

    const message = res.choices[0].message;

    if (!message.tool_calls) {
      return message.content.trim();
    }

    messages.push(message);

    for (const toolCall of message.tool_calls) {
      if (toolCall.function.name === 'place_order') {
        const args = JSON.parse(toolCall.function.arguments);
        const out = await onPlaceOrder(args);
        
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(out),
        });
      } 
      else if (toolCall.function.name === 'request_human_handoff') {
        const args = JSON.parse(toolCall.function.arguments);
        const out = await onHumanHandoff(args.reason);
        
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(out),
        });
      }
    }
  }
  return 'Sorry, something went wrong. Please try again.';
}