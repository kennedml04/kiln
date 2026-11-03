/**
 * Reads an SSE response body and calls `onData` with the `data:` text of each message.
 * Resolves when the stream ends or is aborted.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) onData(data);
      }
    }
  } catch {
    // Aborted, or the other side went away.
  }
}
