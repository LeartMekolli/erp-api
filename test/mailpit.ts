import { waitFor } from './wait-for';

/** Mailpit's HTTP API, which tests read to see what was really sent. */
const BASE = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

interface Summary {
  ID: string;
  Subject: string;
}

export interface MailpitMessage {
  subject: string;
  text: string;
  html: string;
  from: { name: string; address: string };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Mailpit ${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Every message addressed to `to`, newest first. */
export async function messagesTo(to: string): Promise<Summary[]> {
  const query = encodeURIComponent(`to:"${to}"`);
  const result = await getJson<{ messages: Summary[] | null }>(`/api/v1/search?query=${query}`);
  return result.messages ?? [];
}

/** Waits for the first message to `to` and returns its content. */
export async function waitForMessage(to: string, timeoutMs = 10_000): Promise<MailpitMessage> {
  const [first] = await waitFor(async () => {
    const found = await messagesTo(to);
    return found.length > 0 ? found : undefined;
  }, timeoutMs);

  const message = await getJson<{ Subject: string; Text: string; HTML: string; From: { Name: string; Address: string } }>(
    `/api/v1/message/${first.ID}`,
  );
  return {
    subject: message.Subject,
    text: message.Text,
    html: message.HTML,
    from: { name: message.From.Name, address: message.From.Address },
  };
}
