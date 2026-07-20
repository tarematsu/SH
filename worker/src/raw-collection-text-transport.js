const TEXT_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'text' });
const HEADER_SEPARATOR = '\n';

export function encodeRawCollectionTextMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.body !== 'string') {
    throw new Error('raw collection text transport requires a string body');
  }
  const { body, ...header } = message;
  return `${JSON.stringify(header)}${HEADER_SEPARATOR}${body}`;
}

export function decodeRawCollectionTextMessage(value) {
  if (typeof value !== 'string') return value;
  const separator = value.indexOf(HEADER_SEPARATOR);
  if (separator <= 0) throw new Error('invalid raw collection text transport');
  let header;
  try {
    header = JSON.parse(value.slice(0, separator));
  } catch (error) {
    throw new Error(`invalid raw collection transport header: ${error?.message || error}`);
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('invalid raw collection transport header');
  }
  return {
    ...header,
    body: value.slice(separator + HEADER_SEPARATOR.length),
  };
}

export function textTransportQueue(queue) {
  if (!queue?.send) return queue;
  return {
    send(message) {
      return queue.send(encodeRawCollectionTextMessage(message), TEXT_QUEUE_SEND_OPTIONS);
    },
  };
}
